// js/textureFactory.js — Generates all textures used in the scene.

import * as THREE from 'three';

// ── CSS colour name → hex (subset covering common OSM values) ─
const CSS_COLOURS = {
  white: '#f5f5f0', ivory: '#fffff0', cream: '#fffdd0',
  beige: '#e8dcc8', tan: '#c8a882', khaki: '#c8b870',
  yellow: '#e8d060', gold: '#d4a830', orange: '#d07030',
  red: '#c03020', crimson: '#9a1020', brown: '#7a4828',
  maroon: '#5a2018', pink: '#e890a0', salmon: '#d87860',
  coral: '#d06048',
  green: '#507840', olive: '#607830', teal: '#307068',
  cyan: '#408898', aqua: '#408898',
  blue: '#3860a0', navy: '#1a2860', indigo: '#384090',
  violet: '#6848a0', purple: '#583878', magenta: '#903878',
  grey: '#888888', gray: '#888888', silver: '#c0c0c0',
  black: '#222222',
};

function resolveColour(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s.startsWith('#')) return s;
  return CSS_COLOURS[s] || null;
}

// ── Toon gradient lookup texture ─────────────────────────────
// Brighter mid and highlight bands so buildings read clearly.
export function makeToonGradient() {
  const w      = 256;
  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, w, 0);
  grd.addColorStop(0.00, '#2a2a3a');   // shadow
  grd.addColorStop(0.28, '#3a3a50');
  grd.addColorStop(0.29, '#606888');   // hard step to mid-tone
  grd.addColorStop(0.60, '#8090b8');
  grd.addColorStop(0.61, '#c0cce8');   // hard step to lit face
  grd.addColorStop(1.00, '#e8eeff');   // highlight
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// ── Building wall texture ─────────────────────────────────────
// Draws a window grid over a base wall colour.
export function makeBuildingWallTexture(options = {}) {
  const {
    wallColor   = '#c8c0b0',
    frameColor  = '#a09080',
    windowColor = '#b8d4e8',
    windowW     = 18,
    windowH     = 24,
    gapX        = 10,
    gapY        = 14,
    cols        = 4,
    rows        = 4,
  } = options;

  const cellW = windowW + gapX;
  const cellH = windowH + gapY;
  const cw    = cellW * cols;
  const ch    = cellH * rows;

  const canvas = document.createElement('canvas');
  canvas.width  = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = wallColor;
  ctx.fillRect(0, 0, cw, ch);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellW + gapX / 2;
      const y = r * cellH + gapY / 2;

      ctx.fillStyle = frameColor;
      ctx.fillRect(x - 1, y - 1, windowW + 2, windowH + 2);

      ctx.fillStyle = windowColor;
      ctx.fillRect(x, y, windowW, windowH);

      const shine = ctx.createLinearGradient(x, y, x + windowW, y + windowH);
      shine.addColorStop(0,    'rgba(255,255,255,0.30)');
      shine.addColorStop(0.4,  'rgba(255,255,255,0.08)');
      shine.addColorStop(1,    'rgba(0,30,80,0.20)');
      ctx.fillStyle = shine;
      ctx.fillRect(x, y, windowW, windowH);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ── Building roof texture ─────────────────────────────────────
export function makeBuildingRoofTexture(color = '#808890') {
  const s      = 128;
  const canvas = document.createElement('canvas');
  canvas.width  = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, s, s);

  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth   = 1;
  for (let i = 0; i < s; i += 16) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(s, i); ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ── Road texture ──────────────────────────────────────────────
export function makeRoadTexture() {
  const cw = 64, ch = 256;
  const canvas = document.createElement('canvas');
  canvas.width  = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#404048';
  ctx.fillRect(0, 0, cw, ch);

  for (let i = 0; i < 400; i++) {
    const gx = Math.random() * cw;
    const gy = Math.random() * ch;
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
    ctx.fillRect(gx, gy, Math.random() * 1.5 + 0.5, Math.random() * 1.5 + 0.5);
  }

  ctx.strokeStyle = 'rgba(255,230,80,0.7)';
  ctx.lineWidth   = 2;
  ctx.setLineDash([20, 20]);
  ctx.beginPath();
  ctx.moveTo(cw / 2, 0);
  ctx.lineTo(cw / 2, ch);
  ctx.stroke();
  ctx.setLineDash([]);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ── Water texture ─────────────────────────────────────────────
export function makeWaterTexture() {
  const s      = 256;
  const canvas = document.createElement('canvas');
  canvas.width  = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1a5080';
  ctx.fillRect(0, 0, s, s);

  for (let y = 0; y < s; y++) {
    const wave  = Math.sin((y / s) * Math.PI * 8) * 0.5 + 0.5;
    const alpha = wave * 0.22 + 0.05;
    ctx.fillStyle = `rgba(140,210,255,${alpha.toFixed(3)})`;
    ctx.fillRect(0, y, s, 1);
  }

  ctx.strokeStyle = 'rgba(200,240,255,0.18)';
  ctx.lineWidth   = 1;
  for (let i = 0; i < 12; i++) {
    const x = (i / 12) * s + 8;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 20, s); ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ── Park texture ──────────────────────────────────────────────
export function makeParkTexture() {
  const s      = 128;
  const canvas = document.createElement('canvas');
  canvas.width  = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#4a7a40';
  ctx.fillRect(0, 0, s, s);

  ctx.strokeStyle = 'rgba(80,160,60,0.35)';
  ctx.lineWidth   = 1;
  for (let i = 0; i < 80; i++) {
    const x     = Math.random() * s;
    const y     = Math.random() * s;
    const len   = Math.random() * 8 + 4;
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ── Satellite ground tile ─────────────────────────────────────
export async function fetchSatelliteTexture(lat, lng, radiusMeters) {
  const zoom         = _zoomForRadius(radiusMeters);
  const { tx, ty }   = _latLngToTile(lat, lng, zoom);
  const size         = 256;
  const grid         = 3;
  const offset       = Math.floor(grid / 2);
  const canvas       = document.createElement('canvas');
  canvas.width        = size * grid;
  canvas.height       = size * grid;
  const ctx          = canvas.getContext('2d');

  const fetches = [];
  for (let dy = 0; dy < grid; dy++) {
    for (let dx = 0; dx < grid; dx++) {
      fetches.push(
        _fetchTileImage(zoom, tx + dx - offset, ty + dy - offset)
          .then(img => ({ img, dx, dy }))
      );
    }
  }

  const results = await Promise.allSettled(fetches);
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { img, dx, dy } = r.value;
      ctx.drawImage(img, dx * size, dy * size, size, size);
    }
  }

  // Subtle cool grade for anime look
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(190,210,255,0.10)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-over';

  return new THREE.CanvasTexture(canvas);
}

function _fetchTileImage(z, x, y) {
  return new Promise((resolve, reject) => {
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error(`Tile failed: ${url}`));
    img.src = url;
  });
}

function _latLngToTile(lat, lng, zoom) {
  const n  = Math.pow(2, zoom);
  const tx = Math.floor((lng + 180) / 360 * n);
  const ty = Math.floor(
    (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n
  );
  return { tx, ty };
}

function _zoomForRadius(r) {
  const z = Math.round(Math.log2(40075016 / (r * 2)));
  return Math.max(12, Math.min(18, z));
}

// ── Building colour/material resolution ──────────────────────
// Priority: OSM explicit colour tag → OSM material tag → building type default.
// Returns { wallColor, frameColor, windowColor, roofColor } as hex strings.
export function buildingPalette(tags) {
  // 1. Try explicit OSM colour tags
  const explicitWall = resolveColour(tags['building:colour'] || tags['building:color']);
  const explicitRoof = resolveColour(tags['roof:colour']     || tags['roof:color']);

  if (explicitWall) {
    // Derive complementary colours from the explicit wall colour
    const wall   = explicitWall;
    const frame  = _darken(wall, 0.75);
    const window = _tintBlue(wall);
    const roof   = explicitRoof || _darken(wall, 0.65);
    return { wallColor: wall, frameColor: frame, windowColor: window, roofColor: roof };
  }

  // 2. Try OSM material tag
  const mat = (tags['building:material'] || '').toLowerCase();
  if (mat) {
    const matColours = {
      brick:         { wallColor: '#c8906a', frameColor: '#a06040', windowColor: '#b8d0e0', roofColor: '#805040' },
      stone:         { wallColor: '#b0a890', frameColor: '#887860', windowColor: '#b8ccd8', roofColor: '#706858' },
      concrete:      { wallColor: '#b0b0b0', frameColor: '#909090', windowColor: '#c0d0dc', roofColor: '#808080' },
      glass:         { wallColor: '#90b8d0', frameColor: '#6090b0', windowColor: '#d0e8f0', roofColor: '#507090' },
      metal:         { wallColor: '#a0a8b0', frameColor: '#7880a0', windowColor: '#c0d4e0', roofColor: '#606878' },
      wood:          { wallColor: '#a07848', frameColor: '#7a5830', windowColor: '#c8b888', roofColor: '#604828' },
      plaster:       { wallColor: '#d8cdb0', frameColor: '#b0a080', windowColor: '#b8d0de', roofColor: '#908060' },
      render:        { wallColor: '#d0c8b0', frameColor: '#a89870', windowColor: '#b8d0de', roofColor: '#887860' },
      sandstone:     { wallColor: '#d0b878', frameColor: '#a89050', windowColor: '#c0d0d8', roofColor: '#806040' },
      limestone:     { wallColor: '#d8d0b0', frameColor: '#b0a070', windowColor: '#c0d0d8', roofColor: '#908058' },
    };
    for (const [key, pal] of Object.entries(matColours)) {
      if (mat.includes(key)) return pal;
    }
  }

  // 3. Fall back to building type
  const t = tags.building || 'yes';
  const typeColours = {
    house:        { wallColor: '#d4c0a0', frameColor: '#a08060', windowColor: '#c0d8e8', roofColor: '#7a4828' },
    detached:     { wallColor: '#d0bca0', frameColor: '#9c7c58', windowColor: '#c0d8e8', roofColor: '#784828' },
    semidetached: { wallColor: '#ccb89c', frameColor: '#987858', windowColor: '#c0d8e8', roofColor: '#765028' },
    terrace:      { wallColor: '#c8b498', frameColor: '#947458', windowColor: '#b8d4e4', roofColor: '#744828' },
    apartments:   { wallColor: '#b8c0c8', frameColor: '#8898a8', windowColor: '#b0d0e8', roofColor: '#606870' },
    residential:  { wallColor: '#c8bca8', frameColor: '#988070', windowColor: '#b8d0e4', roofColor: '#706050' },
    office:       { wallColor: '#9ab0c0', frameColor: '#6888a0', windowColor: '#c0dce8', roofColor: '#506070' },
    commercial:   { wallColor: '#c0b8a0', frameColor: '#907860', windowColor: '#c8d8e0', roofColor: '#686050' },
    retail:       { wallColor: '#c8b898', frameColor: '#a08060', windowColor: '#d0d8e0', roofColor: '#706048' },
    skyscraper:   { wallColor: '#8090a8', frameColor: '#506080', windowColor: '#c0dce8', roofColor: '#384858' },
    industrial:   { wallColor: '#a0a098', frameColor: '#707068', windowColor: '#b0c0c8', roofColor: '#585850' },
    warehouse:    { wallColor: '#9c9888', frameColor: '#6c6858', windowColor: '#b0bcc4', roofColor: '#545040' },
    church:       { wallColor: '#d8d0b8', frameColor: '#a89870', windowColor: '#d0c080', roofColor: '#706040' },
    cathedral:    { wallColor: '#d4cdb0', frameColor: '#a09468', windowColor: '#d0c080', roofColor: '#686040' },
    school:       { wallColor: '#d0c090', frameColor: '#a09060', windowColor: '#b8d0e0', roofColor: '#707040' },
    hospital:     { wallColor: '#e0dcd4', frameColor: '#b0aca0', windowColor: '#b8d0e4', roofColor: '#808078' },
    hotel:        { wallColor: '#c8b890', frameColor: '#987848', windowColor: '#c0d0e0', roofColor: '#705838' },
    university:   { wallColor: '#c8b878', frameColor: '#988040', windowColor: '#b8d0e0', roofColor: '#706040' },
  };

  return typeColours[t] ?? {
    wallColor:   '#c0bdb0',
    frameColor:  '#908880',
    windowColor: '#b8d0e0',
    roofColor:   '#707068',
  };
}

// ── Colour helpers ─────────────────────────────────────────────
// Darken a hex colour by a factor (0–1).
function _darken(hex, factor) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(factor);
  return '#' + c.getHexString();
}

// Tint a colour towards a neutral window blue-grey.
function _tintBlue(hex) {
  const c = new THREE.Color(hex);
  const b = new THREE.Color('#b8d4e8');
  c.lerp(b, 0.6);
  return '#' + c.getHexString();
}
