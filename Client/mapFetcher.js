// js/mapFetcher.js — Fetches OSM vector data via the local proxy server.
// Geocoding also routes through the proxy to avoid CORS issues.
//
// Set PROXY_BASE to wherever your proxy.js is running:
//   - Local dev:   'http://localhost:3001'
//   - Render/Railway: 'https://your-proxy.onrender.com'
//
// The proxy handles all Overpass mirror selection and retry internally,
// so this client simply posts the raw QL query and receives parsed JSON.

// ── Proxy base URL ────────────────────────────────────────────
// Change this one constant when you deploy the proxy.
const PROXY_BASE = 'http://localhost:3001';

export class MapFetcher {
  constructor() {
    // Kept for reference / direct fallback if proxy is unavailable.
    // Normal operation never calls Overpass directly from the client.
    this._proxyBase = PROXY_BASE;
    this.MAX_CHUNKS = 20;
  }

  // ═══════════════════════════════════════════════════════════════
  // IndexedDB cache  (unchanged from original)
  // ═══════════════════════════════════════════════════════════════

  async _countChunks() {
    const db = await this._initDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('chunks', 'readonly');
      const store = tx.objectStore('chunks');
      const req   = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async _evictOldestChunks(countToRemove) {
    const db = await this._initDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      const index = store.index('timestamp');
      let deleted = 0;
      const req = index.openCursor();
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || deleted >= countToRemove) { resolve(); return; }
        store.delete(cursor.primaryKey);
        deleted++;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async _initDB() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('MapCacheDB', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        let store;
        if (!db.objectStoreNames.contains('chunks')) {
          store = db.createObjectStore('chunks', { keyPath: 'key' });
        } else {
          store = req.transaction.objectStore('chunks');
        }
        if (!store.indexNames.contains('timestamp')) {
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return this._db;
  }

  _getGridKey(lat, lng) {
    const size = 0.01;
    return `${Math.floor(lat / size)}:${Math.floor(lng / size)}`;
  }

  async _getChunk(key) {
    const db = await this._initDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      const req   = store.get(key);
      req.onsuccess = () => {
        const result = req.result;
        if (result) { result.timestamp = Date.now(); store.put(result); }
        resolve(result || null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async _setChunk(key, data) {
    const db = await this._initDB();
    await new Promise((resolve, reject) => {
      const tx    = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      store.put({ key, data, timestamp: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    const count = await this._countChunks();
    if (count > this.MAX_CHUNKS) {
      await this._evictOldestChunks(count - this.MAX_CHUNKS);
    }
  }

  _isFresh(chunk, maxAgeMs = 86_400_000) {
    return !!chunk && (Date.now() - chunk.timestamp) < maxAgeMs;
  }

  // ═══════════════════════════════════════════════════════════════
  // Fetch helpers
  // ═══════════════════════════════════════════════════════════════

  async _fetchWithTimeout(url, options, timeout = 25_000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(id);
    }
  }

  async _retry(fn, attempts = 3) {
    let delay = 500;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); } catch (err) {
        if (i === attempts - 1) throw err;
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Geocoding — now via proxy
  // ═══════════════════════════════════════════════════════════════

  async geocode(placeName) {
    const url = `${this._proxyBase}/api/geocode?q=${encodeURIComponent(placeName)}`;
    const res  = await this._fetchWithTimeout(url, {});
    if (!res.ok) throw new Error('Geocoding failed');
    const data = await res.json();
    if (!data.features?.length) throw new Error(`Place not found: "${placeName}"`);
    const [lng, lat] = data.features[0].geometry.coordinates;
    const props = data.features[0].properties;
    const display = [props.name, props.city, props.country].filter(Boolean).join(', ');
    return { lat, lng, display };
  }

  // ═══════════════════════════════════════════════════════════════
  // Overpass fetch — routes through proxy
  // ═══════════════════════════════════════════════════════════════

  /**
   * Fetch buildings, roads, water, parks within `radiusMeters` of (lat, lng).
   * Hits the local proxy instead of Overpass directly.
   */
  async fetchArea(lat, lng, radiusMeters = 500) {
    const key    = this._getGridKey(lat, lng);
    const cached = await this._getChunk(key);

    try {
      const data = await this._retry(() =>
        this._fetchFromProxy(lat, lng, radiusMeters)
      );
      await this._setChunk(key, data);
      return { ways: data, source: 'network' };
    } catch (err) {
      console.warn('[mapFetcher] proxy request failed:', err.message);
      if (cached?.data) {
        console.warn('[mapFetcher] falling back to cached data');
        return { ways: cached.data, source: 'cache' };
      }
      throw err;
    }
  }

  /**
   * Send the Overpass QL query to our proxy endpoint.
   * The proxy handles mirror selection and upstream retries.
   */
  async _fetchFromProxy(lat, lng, radiusMeters) {
    const r     = radiusMeters;
    const query = `
[out:json][timeout:25];
(
  way["building"](around:${r},${lat},${lng});
  way["highway"](around:${r},${lat},${lng});
  way["waterway"](around:${r},${lat},${lng});
  way["natural"="water"](around:${r},${lat},${lng});
  way["leisure"="park"](around:${r},${lat},${lng});
  way["landuse"="grass"](around:${r},${lat},${lng});
);
out body;
>;
out skel qt;
    `.trim();

    const res = await this._fetchWithTimeout(
      `${this._proxyBase}/api/overpass`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query }),
      },
      28_000, // slightly longer than the proxy's own timeout
    );

    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(`Proxy error ${res.status}: ${detail.error ?? 'unknown'}`);
    }

    const json = await res.json();
    return this._parse(json, lat, lng);
  }

  // ═══════════════════════════════════════════════════════════════
  // Parse OSM JSON → structured data  (unchanged from original)
  // ═══════════════════════════════════════════════════════════════

  _parse(json, centerLat, centerLng) {
    const nodes = new Map();
    const ways  = [];

    for (const el of json.elements) {
      if (el.type === 'node') nodes.set(el.id, { lat: el.lat, lng: el.lon });
    }

    for (const el of json.elements) {
      if (el.type !== 'way' || !el.nodes || !el.tags) continue;
      const coords = el.nodes
        .map(nid => nodes.get(nid))
        .filter(Boolean)
        .map(n => this._project(n.lat, n.lng, centerLat, centerLng));

      if (!coords.length) continue;
      const kind = this._classify(el.tags);
      if (!kind) continue;

      ways.push({
        id:     el.id,
        kind,
        tags:   el.tags,
        coords,
        height: this._estimateHeight(el.tags),
        closed: el.nodes[0] === el.nodes[el.nodes.length - 1],
      });
    }
    return ways;
  }

  _project(lat, lng, cLat, cLng) {
    const R    = 6378137;
    const dLat = (lat - cLat) * Math.PI / 180;
    const dLng = (lng - cLng) * Math.PI / 180;
    const x    = dLng * R * Math.cos(cLat * Math.PI / 180);
    const z    = -dLat * R;
    return { x, z };
  }

  _classify(tags) {
    if (tags.building)                                return 'building';
    if (tags.highway)                                 return 'road';
    if (tags.waterway || tags['natural'] === 'water') return 'water';
    if (tags.leisure === 'park')                      return 'park';
    if (tags.landuse === 'grass')                     return 'park';
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // Weather fetch — direct to Open-Meteo (already CORS-friendly)
  // ═══════════════════════════════════════════════════════════════

  async fetchWeather(lat, lng) {
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
        `&current=cloud_cover,weather_code,wind_speed_10m,wind_direction_10m` +
        `&wind_speed_unit=ms` +
        `&forecast_days=1`;
      const res  = await fetch(url);
      if (!res.ok) throw new Error('weather fetch failed');
      const json = await res.json();
      const cur  = json.current || {};
      const windSpeed = Math.min(80, Math.round((cur.wind_speed_10m ?? 5) * 2));
      return {
        cloudCover:    cur.cloud_cover        ?? 40,
        weatherCode:   cur.weather_code       ?? 1,
        windSpeed,
        windDirection: Math.round(cur.wind_direction_10m ?? 13),
      };
    } catch (_) {
      return { cloudCover: 40, weatherCode: 1, windSpeed: 18, windDirection: 13 };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Height estimation  (unchanged from original)
  // ═══════════════════════════════════════════════════════════════

  _estimateHeight(tags) {
    if (tags.height)             return parseFloat(tags.height)             || 10;
    if (tags['building:levels']) return parseFloat(tags['building:levels']) * 3 || 10;
    const t = tags.building;
    if (t === 'yes' || !t)                   return 10;
    if (t === 'house')                       return 7;
    if (t === 'apartments')                  return 20;
    if (t === 'office')                      return 40;
    if (t === 'skyscraper')                  return 120;
    if (t === 'tower')                       return 60;
    if (t === 'cathedral' || t === 'church') return 25;
    if (t === 'industrial')                  return 12;
    return 10;
  }
}
