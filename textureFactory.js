// js/textureFactory.js
import * as THREE from 'three';

// ── CSS colour name → hex ─────────────────────────────────────
const CSS_COLOURS = {
  white: '#f5f5f0', ivory: '#fffff0', cream: '#fffdd0',
  beige: '#e8dcc8', tan: '#c8a882', khaki: '#c8b870',
  yellow: '#e8d060', gold: '#d4a830', orange: '#d07030',
  red: '#c03020', crimson: '#9a1020', brown: '#7a4828',
  maroon: '#5a2018', pink: '#e890a0', salmon: '#d87860',
  coral: '#d06048', green: '#507840', olive: '#607830',
  teal: '#307068', cyan: '#408898', aqua: '#408898',
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

// ── Toon gradient ─────────────────────────────────────────────
export function makeToonGradient() {
  const w = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, w, 0);
  grd.addColorStop(0.00, '#2a2a3a');
  grd.addColorStop(0.28, '#3a3a50');
  grd.addColorStop(0.29, '#606888');
  grd.addColorStop(0.60, '#8090b8');
  grd.addColorStop(0.61, '#c0cce8');
  grd.addColorStop(1.00, '#e8eeff');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// ── Satellite ground texture ──────────────────────────────────
// Fetches enough tiles to cover the area, then crops the composite
// precisely to the geographic bounds of ±radiusMeters so that the
// resulting texture maps exactly onto the ground plane with no offset.
//
// Returns a canvas (not a THREE.Texture) so the caller can use it
// directly or extract the precise crop dimensions.
export async function fetchSatelliteTexture(lat, lng, radiusMeters) {
  const zoom       = _zoomForRadius(radiusMeters);
  const tileSize   = 256; // Esri tiles are 256×256px

  // Convert the four corners of our area to tile coordinates
  // so we know exactly which tiles we need.
  const R    = 6378137;
  const dLat = radiusMeters / R * (180 / Math.PI);
  const dLng = radiusMeters / (R * Math.cos(lat * Math.PI / 180)) * (180 / Math.PI);

  const latN = lat + dLat, latS = lat - dLat;
  const lngW = lng - dLng, lngE = lng + dLng;

  // Tile indices covering the area (may span multiple tiles)
  const { tx: txW, ty: tyN } = _latLngToTile(latN, lngW, zoom);
  const { tx: txE, ty: tyS } = _latLngToTile(latS, lngE, zoom);

  // Clamp to a reasonable range to avoid fetching huge numbers of tiles
  const tileCountX = Math.min(txE - txW + 1, 6);
  const tileCountY = Math.min(tyS - tyN + 1, 6);

  // Composite canvas covering all needed tiles
  const compW  = tileCountX * tileSize;
  const compH  = tileCountY * tileSize;
  const canvas = document.createElement('canvas');
  canvas.width  = compW;
  canvas.height = compH;
  const ctx = canvas.getContext('2d');

  // Fetch all tiles
  const fetches = [];
  for (let dy = 0; dy < tileCountY; dy++) {
    for (let dx = 0; dx < tileCountX; dx++) {
      const tileX = txW + dx;
      const tileY = tyN + dy;
      const url   = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${tileY}/${tileX}`;
      fetches.push(
        _fetchTileImage(url).then(img => ({ img, dx, dy }))
      );
    }
  }

  const results = await Promise.allSettled(fetches);
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { img, dx, dy } = r.value;
      ctx.drawImage(img, dx * tileSize, dy * tileSize, tileSize, tileSize);
    }
  }

  // Now compute the geographic extent of the full composite
  const compLngW = _tileToLng(txW,           zoom);
  const compLngE = _tileToLng(txW + tileCountX, zoom);
  const compLatN = _tileToLat(tyN,           zoom);
  const compLatS = _tileToLat(tyN + tileCountY, zoom);

  // Compute pixel coordinates of our exact area bounds within the composite
  const cropX = Math.round((lngW - compLngW) / (compLngE - compLngW) * compW);
  const cropY = Math.round((compLatN - latN)  / (compLatN - compLatS) * compH);
  const cropW = Math.round((lngE - lngW)      / (compLngE - compLngW) * compW);
  const cropH = Math.round((latN - latS)      / (compLatN - compLatS) * compH);

  // Extract the precise crop into a new canvas
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width  = Math.max(1, cropW);
  cropCanvas.height = Math.max(1, cropH);
  const cropCtx = cropCanvas.getContext('2d');

  // Light anime colour grade
  cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  cropCtx.globalCompositeOperation = 'multiply';
  cropCtx.fillStyle = 'rgba(190,210,255,0.10)';
  cropCtx.fillRect(0, 0, cropW, cropH);
  cropCtx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(cropCanvas);
  // ClampToEdge so no wrapping artefacts at the edges
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ── Terrarium elevation tile fetch ────────────────────────────
export async function fetchElevationGrid(lat, lng, radiusMeters, gridSize = 64) {
  const zoom       = Math.max(10, Math.min(14, _zoomForRadius(radiusMeters) - 1));
  const { tx, ty } = _latLngToTile(lat, lng, zoom);

  const tileSize = 256;
  const grid     = 2;
  const canvas   = document.createElement('canvas');
  canvas.width    = tileSize * grid;
  canvas.height   = tileSize * grid;
  const ctx      = canvas.getContext('2d');

  const fetches = [];
  for (let dy = 0; dy < grid; dy++) {
    for (let dx = 0; dx < grid; dx++) {
      fetches.push(
        _fetchTileImage(
          `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tx + dx}/${ty + dy}.png`
        ).then(img => ({ img, dx, dy }))
      );
    }
  }

  const results = await Promise.allSettled(fetches);
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { img, dx, dy } = r.value;
      ctx.drawImage(img, dx * tileSize, dy * tileSize, tileSize, tileSize);
    }
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels    = imageData.data;

  const blockW    = canvas.width;
  const blockH    = canvas.height;
  const blockLng0 = _tileToLng(tx,        zoom);
  const blockLng1 = _tileToLng(tx + grid, zoom);
  const blockLat0 = _tileToLat(ty,        zoom);
  const blockLat1 = _tileToLat(ty + grid, zoom);

  const R    = 6378137;
  const dLat = radiusMeters / R * (180 / Math.PI);
  const dLng = radiusMeters / (R * Math.cos(lat * Math.PI / 180)) * (180 / Math.PI);

  const elevations = new Float32Array(gridSize * gridSize);

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const sampleLat = lat + dLat - (row / (gridSize - 1)) * dLat * 2;
      const sampleLng = lng - dLng + (col / (gridSize - 1)) * dLng * 2;

      const px = Math.floor(((sampleLng - blockLng0) / (blockLng1 - blockLng0)) * blockW);
      const py = Math.floor(((blockLat0 - sampleLat) / (blockLat0 - blockLat1)) * blockH);

      const clampedPx = Math.max(0, Math.min(blockW - 1, px));
      const clampedPy = Math.max(0, Math.min(blockH - 1, py));
      const idx       = (clampedPy * blockW + clampedPx) * 4;

      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      elevations[row * gridSize + col] = r * 256 + g + b / 256 - 32768;
    }
  }

  return elevations;
}

// ── Building colour palette ───────────────────────────────────
export function buildingPalette(tags) {
  const explicitWall = resolveColour(tags['building:colour'] || tags['building:color']);
  if (explicitWall) return explicitWall;

  const mat = (tags['building:material'] || '').toLowerCase();
  const matColours = {
    brick: '#c8906a', stone: '#b0a890', concrete: '#b0b0b0',
    glass: '#90b8d0', metal: '#a0a8b0', wood: '#a07848',
    plaster: '#d8cdb0', render: '#d0c8b0', sandstone: '#d0b878',
    limestone: '#d8d0b0',
  };
  for (const [key, col] of Object.entries(matColours)) {
    if (mat.includes(key)) return col;
  }

  const t = tags.building || 'yes';
  const typeColours = {
    house: '#d4c0a0', detached: '#d0bca0', semidetached: '#ccb89c',
    terrace: '#c8b498', apartments: '#b8c0c8', residential: '#c8bca8',
    office: '#9ab0c0', commercial: '#c0b8a0', retail: '#c8b898',
    skyscraper: '#8090a8', industrial: '#a0a098', warehouse: '#9c9888',
    church: '#d8d0b8', cathedral: '#d4cdb0', school: '#d0c090',
    hospital: '#e0dcd4', hotel: '#c8b890', university: '#c8b878',
    train_station: '#b0b8c0', transportation: '#b0b8c0',
  };
  return typeColours[t] ?? '#c0bdb0';
}

// ── Roof colour ───────────────────────────────────────────────
export function roofColour(tags) {
  const explicit = resolveColour(tags['roof:colour'] || tags['roof:color']);
  if (explicit) return explicit;
  const wall = new THREE.Color(buildingPalette(tags));
  wall.multiplyScalar(0.75);
  wall.b = Math.min(1, wall.b + 0.05);
  return '#' + wall.getHexString();
}

// ── Shared helpers ────────────────────────────────────────────
function _fetchTileImage(url) {
  return new Promise((resolve, reject) => {
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

// Geographic coordinates of tile edges
function _tileToLng(tx, zoom) {
  return tx / Math.pow(2, zoom) * 360 - 180;
}

function _tileToLat(ty, zoom) {
  const n = Math.PI - (2 * Math.PI * ty) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function _zoomForRadius(r) {
  return Math.max(12, Math.min(18, Math.round(Math.log2(40075016 / (r * 2)))));
}
