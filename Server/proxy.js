// proxy.js — OSM/Overpass CORS proxy + WebSocket scaffold for future multiplayer
//
// Current responsibilities:
//   POST /api/overpass   — proxies Overpass QL queries, tries multiple mirrors
//   GET  /api/geocode    — proxies Photon geocoding
//   GET  /health         — liveness check (useful for Render/Railway keep-alive pings)
//
// Future multiplayer:
//   The ws (WebSocket) server is wired in but currently does nothing beyond
//   accepting connections. Add room/session logic here when ready.
//
// Usage:
//   node proxy.js
//   PORT env var overrides the default 3001.
//
// Dependencies (install once):
//   npm install express cors node-fetch ws

'use strict';

const express  = require('express');
const cors     = require('cors');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');

// node-fetch v2 keeps CommonJS require() — v3+ is ESM-only.
// If you prefer ESM rename the file to proxy.mjs and use import.
const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));

// ── Config ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// Overpass mirrors tried in order; first success wins.
// The proxy always tries all of them before giving up, mirroring the
// client-side behaviour that existed before.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

const PHOTON_BASE = 'https://photon.komoot.io/api/';

// Per-request timeout forwarded to each upstream mirror (ms).
const UPSTREAM_TIMEOUT_MS = 20_000;

// Simple in-memory rate limiter: max N requests per IP per window.
// Replace with Redis + sliding-window if you need distributed enforcement.
const RATE_LIMIT = { windowMs: 60_000, max: 30 };
const _rateBuckets = new Map(); // ip → { count, resetAt }

// ── App setup ─────────────────────────────────────────────────
const app    = express();
const server = createServer(app);

// Allow all origins so the client can run from file://, localhost, or any CDN.
// Tighten this to your actual domain before going to production:
//   origin: ['https://your-game.com']
app.use(cors({ origin: '*' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));

// ── Middleware ────────────────────────────────────────────────

function rateLimit(req, res, next) {
  const ip  = req.ip ?? 'unknown';
  const now = Date.now();
  let bucket = _rateBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT.windowMs };
    _rateBuckets.set(ip, bucket);
  }

  bucket.count++;
  if (bucket.count > RATE_LIMIT.max) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

// Prune stale rate-limit buckets every minute to avoid memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of _rateBuckets) {
    if (now > b.resetAt) _rateBuckets.delete(ip);
  }
}, 60_000);

// ── Helpers ───────────────────────────────────────────────────

/**
 * Fetch with an AbortController timeout.
 * @param {string} url
 * @param {object} options  — standard fetch options
 * @param {number} timeoutMs
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try a list of upstream URLs in order, returning the first successful response.
 * On failure of all mirrors the last error is re-thrown.
 */
async function tryMirrors(mirrors, buildRequest) {
  let lastErr;
  for (const mirror of mirrors) {
    try {
      const res = await buildRequest(mirror);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${mirror}`);
      return res;
    } catch (err) {
      lastErr = err;
      console.warn(`[proxy] mirror failed: ${mirror} —`, err.message);
    }
  }
  throw lastErr;
}

// ── Routes ────────────────────────────────────────────────────

// Liveness check — Render/Railway can ping this to keep the dyno warm.
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * POST /api/overpass
 * Body (application/x-www-form-urlencoded OR JSON):
 *   { query: "<Overpass QL string>" }
 *
 * Returns raw Overpass JSON to the client.
 * The client (mapFetcher.js) is responsible for parsing + projecting the data.
 */
app.post('/api/overpass', rateLimit, async (req, res) => {
  // Accept both urlencoded (legacy) and JSON bodies
  const query = req.body?.query ?? req.body?.data;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing "query" field in request body' });
  }

  // Basic sanity check — refuse anything that isn't an Overpass QL block
  if (!query.includes('[out:json]')) {
    return res.status(400).json({ error: 'Query must contain [out:json]' });
  }

  try {
    // Shuffle mirrors so load is spread across Overpass servers.
    const mirrors = [...OVERPASS_MIRRORS].sort(() => Math.random() - 0.5);

    const upstream = await tryMirrors(mirrors, (mirror) =>
      fetchWithTimeout(
        mirror,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    `data=${encodeURIComponent(query)}`,
        },
        UPSTREAM_TIMEOUT_MS,
      )
    );

    // Stream the upstream body straight through — avoids buffering large payloads.
    res.setHeader('Content-Type', 'application/json');
    upstream.body.pipe(res);
  } catch (err) {
    console.error('[proxy] /api/overpass error:', err.message);
    res.status(502).json({ error: 'All Overpass mirrors failed', detail: err.message });
  }
});

/**
 * GET /api/geocode?q=<place name>
 * Proxies Photon (https://photon.komoot.io) and returns GeoJSON FeatureCollection.
 */
app.get('/api/geocode', rateLimit, async (req, res) => {
  const q = req.query.q;
  if (!q || typeof q !== 'string' || q.trim().length === 0) {
    return res.status(400).json({ error: 'Missing "q" query parameter' });
  }

  const url = `${PHOTON_BASE}?q=${encodeURIComponent(q.trim())}&limit=1&lang=en`;

  try {
    const upstream = await fetchWithTimeout(url, {}, UPSTREAM_TIMEOUT_MS);
    if (!upstream.ok) throw new Error(`Photon returned HTTP ${upstream.status}`);

    res.setHeader('Content-Type', 'application/json');
    upstream.body.pipe(res);
  } catch (err) {
    console.error('[proxy] /api/geocode error:', err.message);
    res.status(502).json({ error: 'Geocoding failed', detail: err.message });
  }
});

// ── WebSocket server (multiplayer scaffold) ───────────────────
//
// Currently just logs connections. To add multiplayer:
//   1. Assign each socket a UUID and a room ID.
//   2. Broadcast position/rotation updates via JSON messages.
//   3. Implement interest-area filtering (only send updates within N metres).
//
// Recommended message envelope:
//   { type: 'move', id, x, y, z, yaw, seq }
//   { type: 'join', id, name, lat, lng }
//   { type: 'leave', id }

const wss = new WebSocketServer({ server, path: '/ws' });

// Simple room registry — Map<roomId, Set<ws>>
// Room ID = the grid cell key (same 0.01° grid as IndexedDB cache) so players
// near the same OSM chunk are automatically in the same room.
const rooms = new Map();

function getRoomId(lat, lng) {
  const size = 0.01;
  return `${Math.floor(lat / size)}:${Math.floor(lng / size)}`;
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[ws] client connected from ${ip}`);

  let clientMeta = { id: crypto.randomUUID(), roomId: null };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // Client announces its spawn location → assign to a room and broadcast join
      case 'join': {
        const roomId = getRoomId(msg.lat ?? 0, msg.lng ?? 0);
        clientMeta.roomId = roomId;
        clientMeta.name   = String(msg.name ?? 'unknown').slice(0, 32);

        if (!rooms.has(roomId)) rooms.set(roomId, new Set());
        rooms.get(roomId).add(ws);

        console.log(`[ws] ${clientMeta.id} joined room ${roomId} (${rooms.get(roomId).size} clients)`);

        // Confirm join back to the connecting client
        wsSend(ws, { type: 'joined', id: clientMeta.id, roomId });

        // Announce to others in same room
        broadcast(roomId, { type: 'peer_join', id: clientMeta.id, name: clientMeta.name }, ws);
        break;
      }

      // Position update — relay to room peers
      case 'move': {
        if (!clientMeta.roomId) break;
        broadcast(clientMeta.roomId, {
          type: 'move',
          id:   clientMeta.id,
          x:    msg.x, y: msg.y, z: msg.z,
          yaw:  msg.yaw,
          seq:  msg.seq,
        }, ws);
        break;
      }

      // Explicit leave (client can also just disconnect)
      case 'leave': {
        handleLeave(ws, clientMeta);
        break;
      }

      default:
        break; // ignore unknown message types
    }
  });

  ws.on('close', () => {
    console.log(`[ws] ${clientMeta.id} disconnected`);
    handleLeave(ws, clientMeta);
  });

  ws.on('error', (err) => {
    console.error(`[ws] ${clientMeta.id} error:`, err.message);
  });
});

function handleLeave(ws, meta) {
  if (!meta.roomId) return;
  const room = rooms.get(meta.roomId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) rooms.delete(meta.roomId);
  broadcast(meta.roomId, { type: 'peer_leave', id: meta.id });
  meta.roomId = null;
}

function broadcast(roomId, msg, excludeWs = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const raw = JSON.stringify(msg);
  for (const peer of room) {
    if (peer !== excludeWs && peer.readyState === 1 /* OPEN */) {
      peer.send(raw);
    }
  }
}

function wsSend(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[proxy] listening on http://0.0.0.0:${PORT}`);
  console.log(`[proxy] WebSocket endpoint: ws://0.0.0.0:${PORT}/ws`);
});
