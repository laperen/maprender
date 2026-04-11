// js/textureFactory.js — Generates all textures used in the scene.
// Procedural textures are drawn onto HTML canvases and wrapped as
// THREE.CanvasTexture. The satellite ground texture is fetched from
// Esri World Imagery tiles (free, no API key required).

import * as THREE from 'three';

// ── Toon gradient lookup texture ─────────────────────────────
// Shared across all MeshToonMaterial instances. A 1D gradient that
// defines the cel-shading step curve: dark → mid → bright.
export function makeToonGradient() {
  const w      = 256;
  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, w, 0);
  // Anime-style: sharp shadow band, soft mid, bright highlight
  grd.addColorStop(0.00, '#111118');
  grd.addColorStop(0.30, '#1a1a2e');
  grd.addColorStop(0.31, '#2e3050');  // hard step — shadow to mid
  grd.addColorStop(0.65, '#4a5080');
  grd.addColorStop(0.66, '#8090c0');  // hard step — mid to lit
  grd.addColorStop(1.00, '#c8d4ff');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// ── Building wall texture ─────────────────────────────────────
// A tileable window-grid pattern.  windowColor, frameColor, and
// wallColor can be varied per building type.
export function makeBuildingWallTexture(options = {}) {
  const {
    wallColor   = '#1a1f35',
    frameColor  = '#2a3060',
    windowColor = '#a8c8ff',
    windowW     = 18,   // px
    windowH     = 24,   // px
    gapX        = 10,   // horizontal gap between windows
    gapY        = 14,   // vertical gap between windows
    cols        = 4,
    rows        = 4,
  } = options;

  const cellW  = windowW + gapX;
  const cellH  = windowH + gapY;
  const cw     = cellW  * cols;
  const ch     = cellH  * rows;

  const canvas = document.createElement('canvas');
  canvas.width  = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');

  // Wall base
  ctx.fillStyle = wallColor;
  ctx.fillRect(0, 0, cw, ch);

  // Window frames then glass
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellW + gapX / 2;
      const y = r * cellH + gapY / 2;
      // Frame (slightly larger)
      ctx.fillStyle = frameColor;
      ctx.fillRect(x - 1, y - 1, windowW + 2, windowH + 2);
      // Glass
      ctx.fillStyle = windowColor;
      ctx.fillRect(x, y, windowW, windowH);
      // Subtle interior sheen
      const shine = ctx.createLinearGradient(x, y, x + windowW, y + windowH);
      shine.addColorStop(0,    'rgba(255,255,255,0.18)');
      shine.addColorStop(0.45, 'rgba(255,255,255,0.04)');
      shine.addColorStop(1,    'rgba(0,20,60,0.25)');
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
export function makeBuildingRoofTexture(color = '#1e2840') {
  const s      = 128;
  const canvas = document.createElement('canvas');
  canvas.width  = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, s, s);

  // Subtle grid of HVAC / rooftop detail lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
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

  // Asphalt base
  ctx.fillStyle = '#18191f';
  ctx.fillRect(0, 0, cw, ch);

  // Subtle noise grain
  for (let i = 0; i < 400; i++) {
    const gx = Math.random() * cw;
    const gy = Math.random() * ch;
    const gs = Math.random() * 1.5 + 0.5;
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
    ctx.fillRect(gx, gy, gs, gs);
  }

  // Centre dashed line
  ctx.strokeStyle = 'rgba(255,230,80,0.55)';
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
// A tileable ripple pattern. Scrolled over time in scene.js.
export function makeWaterTexture() {
  const s      = 256;
  const canvas = document.createElement('canvas');
  canvas.width  = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0a3060';
  ctx.fillRect(0, 0, s, s);

  // Concentric-ripple-like lines using sine stripes
  for (let y = 0; y < s; y += 1) {
    const t = y / s;
    const wave = Math.sin(t * Math.PI * 8) * 0.5 + 0.5;
    const alpha = wave * 0.18 + 0.04;
    ctx.fillStyle = `rgba(120,200,255,${alpha.toFixed(3)})`;
    ctx.fillRect(0, y, s, 1);
  }

  // Highlight streaks
  ctx.strokeStyle = 'rgba(180,230,255,0.12)';
  ctx.lineWidth   = 1;
  for (let i = 0; i < 12; i++) {
    const x = (i / 12) * s + 8;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x - 20, s);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ── Park / grass texture ──────────────────────────────────────
export function makeParkTexture() {
  const s      = 128;
  const canvas = document.createElement('canvas');
  canvas.width  = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1a3320';
  ctx.fillRect(0, 0, s, s);

  // Irregular grass-stroke marks
  ctx.strokeStyle = 'rgba(60,140,60,0.25)';
  ctx.lineWidth   = 1;
  for (let i = 0; i < 80; i++) {
    const x  = Math.random() * s;
    const y  = Math.random() * s;
    const len = Math.random() * 8 + 4;
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
// Fetches the Esri World Imagery tile(s) covering the given area,
// composites them onto a canvas, and returns a THREE.CanvasTexture.
//
// Esri tile URL format: /tile/{z}/{y}/{x}  (note y before x)
// We pick the zoom level that gives good coverage for the radius,
// then fetch a 2×2 block of tiles centred on the location to avoid
// seam edges at the boundary.

export async function fetchSatelliteTexture(lat, lng, radiusMeters) {
  const zoom   = _zoomForRadius(radiusMeters);
  const { tx, ty } = _latLngToTile(lat, lng, zoom);

  // Fetch a 3×3 grid of tiles centred on the target tile so the
  // full area is covered even when the centre sits near a tile edge.
  const size   = 256; // Esri tile pixel size
  const grid   = 3;   // tiles per side
  const offset = Math.floor(grid / 2);
  const canvas = document.createElement('canvas');
  canvas.width  = size * grid;
  canvas.height = size * grid;
  const ctx    = canvas.getContext('2d');

  const fetches = [];
  for (let dy = 0; dy < grid; dy++) {
    for (let dx = 0; dx < grid; dx++) {
      const tileX = tx + dx - offset;
      const tileY = ty + dy - offset;
      fetches.push(
        _fetchTileImage(zoom, tileX, tileY).then(img => ({ img, dx, dy }))
      );
    }
  }

  const results = await Promise.allSettled(fetches);
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { img, dx, dy } = result.value;
      ctx.drawImage(img, dx * size, dy * size, size, size);
    }
  }

  // Slight anime-style colour grade: desaturate a touch, cool the shadows
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(180,200,255,0.12)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

function _fetchTileImage(z, x, y) {
  return new Promise((resolve, reject) => {
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error(`Tile load failed: ${url}`));
    img.src = url;
  });
}

// Mercator lat/lng → tile XY at a given zoom level
function _latLngToTile(lat, lng, zoom) {
  const n  = Math.pow(2, zoom);
  const tx = Math.floor((lng + 180) / 360 * n);
  const ty = Math.floor(
    (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n
  );
  return { tx, ty };
}

// Pick a zoom level that gives roughly 4–6 tiles of coverage for the radius
function _zoomForRadius(radiusMeters) {
  // At equator: tile width in metres at zoom z ≈ 40075016 / 2^z
  // We want the tile to be roughly radiusMeters wide, so solve for z.
  const z = Math.round(Math.log2(40075016 / (radiusMeters * 2)));
  return Math.max(12, Math.min(18, z));
}

// ── Building colour palette by type ──────────────────────────
// Returns { wallColor, frameColor, windowColor, roofColor }
export function buildingPalette(tags) {
  const t = tags.building || 'yes';
  const palettes = {
    house:       { wallColor: '#2a2535', frameColor: '#3a3050', windowColor: '#ffd090', roofColor: '#1a1520' },
    apartments:  { wallColor: '#1e2840', frameColor: '#2a3860', windowColor: '#a0c0ff', roofColor: '#141e30' },
    office:      { wallColor: '#152030', frameColor: '#1e3050', windowColor: '#80c0e0', roofColor: '#101820' },
    skyscraper:  { wallColor: '#101820', frameColor: '#182840', windowColor: '#60b0d0', roofColor: '#080f18' },
    industrial:  { wallColor: '#252020', frameColor: '#352a2a', windowColor: '#c0a070', roofColor: '#1a1515' },
    cathedral:   { wallColor: '#2a2820', frameColor: '#3a3828', windowColor: '#e0c080', roofColor: '#1a1810' },
    church:      { wallColor: '#2a2820', frameColor: '#3a3828', windowColor: '#e0c080', roofColor: '#1a1810' },
  };
  return palettes[t] ?? { wallColor: '#1a2035', frameColor: '#2a3060', windowColor: '#a8c8ff', roofColor: '#1e2840' };
}
