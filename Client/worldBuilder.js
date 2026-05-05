// js/worldBuilder.js — Converts parsed OSM ways into Three.js meshes
// Includes inlined earcut polygon triangulator (ISC Licence, mapbox/earcut)
// Includes inlined textureFactory (satellite textures, building colours)
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ═══════════════════════════════════════════════════════════════
// EARCUT — polygon triangulator (ported from mapbox/earcut)
// ═══════════════════════════════════════════════════════════════

function earcut(data, holeIndices, dim) {
  dim = dim || 2;
  var hasHoles = holeIndices && holeIndices.length,
    outerLen = hasHoles ? holeIndices[0] * dim : data.length,
    outerNode = linkedList(data, 0, outerLen, dim, true),
    triangles = [];
  if (!outerNode || outerNode.next === outerNode.prev) return triangles;
  var minX, minY, maxX, maxY, x, y, invSize;
  if (hasHoles) outerNode = eliminateHoles(data, holeIndices, outerNode, dim);
  if (data.length > 80 * dim) {
    minX = maxX = data[0]; minY = maxY = data[1];
    for (var i = dim; i < outerLen; i += dim) {
      x = data[i]; y = data[i + 1];
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    invSize = Math.max(maxX - minX, maxY - minY);
    invSize = invSize !== 0 ? 1 / invSize : 0;
  }
  earcutLinked(outerNode, triangles, dim, minX, minY, invSize);
  return triangles;
}
function linkedList(data, start, end, dim, clockwise) {
  var i, last;
  if (clockwise === (signedArea(data, start, end, dim) > 0)) {
    for (i = start; i < end; i += dim) last = insertNode(i, data[i], data[i + 1], last);
  } else {
    for (i = end - dim; i >= start; i -= dim) last = insertNode(i, data[i], data[i + 1], last);
  }
  if (last && equals(last, last.next)) { removeNode(last); last = last.next; }
  return last;
}
function filterPoints(start, end) {
  if (!start) return start;
  if (!end) end = start;
  var p = start, again;
  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p); p = end = p.prev; if (p === p.next) break; again = true;
    } else p = p.next;
  } while (again || p !== end);
  return end;
}
function earcutLinked(ear, triangles, dim, minX, minY, invSize, pass) {
  if (!ear) return;
  if (!pass && invSize) indexCurve(ear, minX, minY, invSize);
  var stop = ear, prev, next;
  while (ear.prev !== ear.next) {
    prev = ear.prev; next = ear.next;
    if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
      triangles.push(prev.i / dim, ear.i / dim, next.i / dim);
      removeNode(ear);
      ear = stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (!pass) { earcutLinked(filterPoints(ear), triangles, dim, minX, minY, invSize, 1); }
      else if (pass === 1) {
        ear = cureLocalIntersections(filterPoints(ear), triangles, dim);
        earcutLinked(ear, triangles, dim, minX, minY, invSize, 2);
      } else if (pass === 2) { splitEarcut(ear, triangles, dim, minX, minY, invSize); }
      break;
    }
  }
}
function isEar(ear) {
  var a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false;
  var p = ear.next.next;
  while (p !== ear.prev) {
    if (pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}
function isEarHashed(ear, minX, minY, invSize) {
  var a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false;
  var minTX = a.x < b.x ? (a.x < c.x ? a.x : c.x) : (b.x < c.x ? b.x : c.x),
    minTY = a.y < b.y ? (a.y < c.y ? a.y : c.y) : (b.y < c.y ? b.y : c.y),
    maxTX = a.x > b.x ? (a.x > c.x ? a.x : c.x) : (b.x > c.x ? b.x : c.x),
    maxTY = a.y > b.y ? (a.y > c.y ? a.y : c.y) : (b.y > c.y ? b.y : c.y),
    minZ = zOrder(minTX, minTY, minX, minY, invSize),
    maxZ = zOrder(maxTX, maxTY, minX, minY, invSize);
  var p = ear.prevZ, n = ear.nextZ;
  while (p && p.z >= minZ && n && n.z <= maxZ) {
    if (p !== ear.prev && p !== ear.next && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.prevZ;
    if (n !== ear.prev && n !== ear.next && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
    n = n.nextZ;
  }
  while (p && p.z >= minZ) {
    if (p !== ear.prev && p !== ear.next && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.prevZ;
  }
  while (n && n.z <= maxZ) {
    if (n !== ear.prev && n !== ear.next && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
    n = n.nextZ;
  }
  return true;
}
function cureLocalIntersections(start, triangles, dim) {
  var p = start;
  do {
    var a = p.prev, b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i / dim, p.i / dim, b.i / dim);
      removeNode(p); removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}
function splitEarcut(start, triangles, dim, minX, minY, invSize) {
  var a = start;
  do {
    var b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        var c = splitPolygon(a, b);
        a = filterPoints(a, a.next);
        c = filterPoints(c, c.next);
        earcutLinked(a, triangles, dim, minX, minY, invSize);
        earcutLinked(c, triangles, dim, minX, minY, invSize);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}
function eliminateHoles(data, holeIndices, outerNode, dim) {
  var queue = [], i, len, start, end, list;
  for (i = 0, len = holeIndices.length; i < len; i++) {
    start = holeIndices[i] * dim; end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
    list = linkedList(data, start, end, dim, false);
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }
  queue.sort(compareX);
  for (i = 0; i < queue.length; i++) { eliminateHole(queue[i], outerNode); outerNode = filterPoints(outerNode, outerNode.next); }
  return outerNode;
}
function compareX(a, b) { return a.x - b.x; }
function eliminateHole(hole, outerNode) {
  outerNode = findHoleBridge(hole, outerNode);
  if (outerNode) { var b = splitPolygon(outerNode, hole); filterPoints(outerNode, outerNode.next); filterPoints(b, b.next); }
}
function findHoleBridge(hole, outerNode) {
  var p = outerNode, hx = hole.x, hy = hole.y, qx = -Infinity, m;
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      var x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) { qx = x; m = p.x < p.next.x ? p : p.next; if (x === hx) return m; }
    }
    p = p.next;
  } while (p !== outerNode);
  if (!m) return null;
  var stop = m, mx = m.x, my = m.y, tanMin = Infinity, tan;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x && pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) { m = p; tanMin = tan; }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}
function sectorContainsSector(m, p) { return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0; }
function indexCurve(start, minX, minY, invSize) {
  var p = start;
  do { if (p.z === null) p.z = zOrder(p.x, p.y, minX, minY, invSize); p.prevZ = p.prev; p.nextZ = p.next; p = p.next; } while (p !== start);
  p.prevZ.nextZ = null; p.prevZ = null; sortLinked(p);
}
function sortLinked(list) {
  var i, p, q, e, tail, numMerges, pSize, qSize, inSize = 1;
  do {
    p = list; list = null; tail = null; numMerges = 0;
    while (p) {
      numMerges++; q = p; pSize = 0;
      for (i = 0; i < inSize; i++) { pSize++; q = q.nextZ; if (!q) break; }
      qSize = inSize;
      while (pSize > 0 || (qSize > 0 && q)) {
        if (pSize !== 0 && (qSize === 0 || !q || p.z <= q.z)) { e = p; p = p.nextZ; pSize--; }
        else { e = q; q = q.nextZ; qSize--; }
        if (tail) tail.nextZ = e; else list = e;
        e.prevZ = tail; tail = e;
      }
      p = q;
    }
    tail.nextZ = null; inSize *= 2;
  } while (numMerges > 1);
  return list;
}
function zOrder(x, y, minX, minY, invSize) {
  x = 32767 * (x - minX) * invSize; y = 32767 * (y - minY) * invSize;
  x = (x | (x << 8)) & 0x00FF00FF; x = (x | (x << 4)) & 0x0F0F0F0F; x = (x | (x << 2)) & 0x33333333; x = (x | (x << 1)) & 0x55555555;
  y = (y | (y << 8)) & 0x00FF00FF; y = (y | (y << 4)) & 0x0F0F0F0F; y = (y | (y << 2)) & 0x33333333; y = (y | (y << 1)) & 0x55555555;
  return x | (y << 1);
}
function getLeftmost(start) {
  var p = start, leftmost = start;
  do { if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p; p = p.next; } while (p !== start);
  return leftmost;
}
function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py);
}
function isValidDiagonal(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) && (locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && (area(a.prev, a, b.prev) || area(a, b.prev, b)) || equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0);
}
function area(p, q, r) { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }
function equals(p1, p2) { return p1.x === p2.x && p1.y === p2.y; }
function intersects(p1, q1, p2, q2) {
  var o1 = sign(area(p1, q1, p2)), o2 = sign(area(p1, q1, q2)), o3 = sign(area(p2, q2, p1)), o4 = sign(area(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true; if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true; if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}
function onSegment(p, q, r) { return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y); }
function sign(num) { return num > 0 ? 1 : num < 0 ? -1 : 0; }
function intersectsPolygon(a, b) {
  var p = a;
  do { if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true; p = p.next; } while (p !== a);
  return false;
}
function locallyInside(a, b) { return area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0; }
function middleInside(a, b) {
  var p = a, inside = false, px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y && (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}
function splitPolygon(a, b) {
  var a2 = new Node(a.i, a.x, a.y), b2 = new Node(b.i, b.x, b.y), an = a.next, bp = b.prev;
  a.next = b; b.prev = a; a2.next = an; an.prev = a2; b2.next = a2; a2.prev = b2; bp.next = b2; b2.prev = bp;
  return b2;
}
function insertNode(i, x, y, last) {
  var p = new Node(i, x, y);
  if (!last) { p.prev = p; p.next = p; }
  else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
  return p;
}
function removeNode(p) { p.next.prev = p.prev; p.prev.next = p.next; if (p.prevZ) p.prevZ.nextZ = p.nextZ; if (p.nextZ) p.nextZ.prevZ = p.prevZ; }
function Node(i, x, y) { this.i = i; this.x = x; this.y = y; this.prev = null; this.next = null; this.z = null; this.prevZ = null; this.nextZ = null; this.steiner = false; }
function signedArea(data, start, end, dim) {
  var sum = 0;
  for (var i = start, j = end - dim; i < end; i += dim) { sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]); j = i; }
  return sum;
}

// ═══════════════════════════════════════════════════════════════
// TEXTURE FACTORY — satellite tiles, elevation, building colours
// ═══════════════════════════════════════════════════════════════

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

function makeToonGradient() {
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

async function fetchSatelliteTexture(lat, lng, radiusMeters) {
  const zoom       = _zoomForRadius(radiusMeters);
  const tileSize   = 256;

  const R    = 6378137;
  const dLat = radiusMeters / R * (180 / Math.PI);
  const dLng = radiusMeters / (R * Math.cos(lat * Math.PI / 180)) * (180 / Math.PI);

  const latN = lat + dLat, latS = lat - dLat;
  const lngW = lng - dLng, lngE = lng + dLng;

  const { tx: txW, ty: tyN } = _latLngToTile(latN, lngW, zoom);
  const { tx: txE, ty: tyS } = _latLngToTile(latS, lngE, zoom);

  const tileCountX = Math.min(txE - txW + 1, 6);
  const tileCountY = Math.min(tyS - tyN + 1, 6);

  const compW  = tileCountX * tileSize;
  const compH  = tileCountY * tileSize;
  const canvas = document.createElement('canvas');
  canvas.width  = compW;
  canvas.height = compH;
  const ctx = canvas.getContext('2d');

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

  const compLngW = _tileToLng(txW,              zoom);
  const compLngE = _tileToLng(txW + tileCountX, zoom);
  const compLatN = _tileToLat(tyN,              zoom);
  const compLatS = _tileToLat(tyN + tileCountY, zoom);

  const cropX = Math.round((lngW - compLngW) / (compLngE - compLngW) * compW);
  const cropY = Math.round((compLatN - latN)  / (compLatN - compLatS) * compH);
  const cropW = Math.round((lngE - lngW)      / (compLngE - compLngW) * compW);
  const cropH = Math.round((latN - latS)      / (compLatN - compLatS) * compH);

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width  = Math.max(1, cropW);
  cropCanvas.height = Math.max(1, cropH);
  const cropCtx = cropCanvas.getContext('2d');

  cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  cropCtx.globalCompositeOperation = 'multiply';
  cropCtx.fillStyle = 'rgba(190,210,255,0.10)';
  cropCtx.fillRect(0, 0, cropW, cropH);
  cropCtx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(cropCanvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

async function fetchElevationGrid(lat, lng, radiusMeters, gridSize = 64) {
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

function buildingPalette(tags) {
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

function roofColour(tags) {
  const explicit = resolveColour(tags['roof:colour'] || tags['roof:color']);
  if (explicit) return explicit;
  const wall = new THREE.Color(buildingPalette(tags));
  wall.multiplyScalar(0.75);
  wall.b = Math.min(1, wall.b + 0.05);
  return '#' + wall.getHexString();
}

// ── Structure palette — for stairs, bridges, rails, construction ──
// Reads material/colour tags; falls back to concrete grey (#909090).
function structurePalette(tags) {
  const explicit = resolveColour(
    tags['colour'] || tags['color'] ||
    tags['building:colour'] || tags['building:color']
  );
  if (explicit) return explicit;

  const mat = (tags['material'] || tags['building:material'] || '').toLowerCase();
  const matColours = {
    brick: '#c8906a', stone: '#b0a890', concrete: '#a8a8a8',
    glass: '#90b8d0', metal: '#909898', steel: '#888e98',
    wood: '#a07848', plaster: '#c8c0b0', render: '#c0b8a8',
    sandstone: '#c8b070', limestone: '#c8c0a8', iron: '#787e88',
  };
  for (const [key, col] of Object.entries(matColours)) {
    if (mat.includes(key)) return col;
  }
  return '#909090'; // default concrete grey
}

// ── Seeded LCG pseudo-random helpers (no external lib) ────────
// _lcgSeed(n)    → initial state (integer)
// _lcgNext(s)    → next state (use / 0xffffffff for [0,1) float)
function _lcgSeed(n) {
  // Mix bits to avoid bad seeds like 0
  let h = (n >>> 0) ^ 0xdeadbeef;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0 || 1;
}
function _lcgNext(s) {
  // Multiplier from Numerical Recipes; modulus 2^32 via unsigned truncation
  return (Math.imul(s, 1664525) + 1013904223) >>> 0;
}

// ── Shared tile helpers ───────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════
// WORLD BUILDER
// ═══════════════════════════════════════════════════════════════


THREE.Mesh.prototype.raycast = acceleratedRaycast;

const MIN_BUILDING_AREA = 5;
const ROAD_STEP  = 8;
const POLY_STEP  = 15;
const DRAPE_BIAS = 0.1;
const RAY_ORIGIN_Y = 2000;

// ── Street lamp constants ─────────────────────────────────────
const LAMP_SPACING     = 60;   // metres between posts along centreline
const LAMP_SIDE_OFFSET = 3.2;  // metres from centreline to post

// Cell size for deduplication grid — two lamps within this distance collapse to one.
// Large enough to collapse clusters at intersections where multiple road ways meet
// and produce overlapping lamp positions from different directions.
const LAMP_DEDUP_CELL  = 20;    // metres

const LAMP_ROAD_TYPES  = new Set([
  'motorway', 'trunk', 'primary', 'secondary',
  'tertiary', 'residential', 'service', 'living_street',
]);

const ELEV_MIN = -500;   // below sea level (safe bound)
const ELEV_MAX = 9000;   // Everest range
//const ELEV_SPIKE_THRESHOLD = 120; // meters vs neighbors

export class WorldBuilder {
  constructor(sceneManager) {
    this.scene         = sceneManager;
    this._toonGradient = makeToonGradient();

    this._lampPostMat = new THREE.MeshLambertMaterial({ color: 0x888890 });
    // Single shared materials — InstancedMesh uses one material for all instances,
    // so emissiveIntensity changes on the material affect all instances at once.
    this._lampGlobeMat = new THREE.MeshLambertMaterial({
      color:             0xfff0c0,
      emissive:          new THREE.Color(0xffa040),
      emissiveIntensity: 0,
    });
    this._lampHaloTex = this._makeLampHaloTexture();

    // Aviation obstruction lights — red emissive boxes on tall buildings
    this._aviatMat = new THREE.MeshLambertMaterial({
      color:             0xff1a00,
      emissive:          new THREE.Color(0xff2200),
      emissiveIntensity: 0,
    });
    // Shared geometries (constructed once, reused for InstancedMesh)
    this._globeGeo  = new THREE.BoxGeometry(0.7, 0.5, 0.7);
    this._aviatGeo  = new THREE.BoxGeometry(0.6, 0.6, 0.6);
    this._postGeo   = new THREE.CylinderGeometry(0.12, 0.16, 6.5, 6, 1);
    // Halo geometry — one shared PlaneGeometry, merged into a single BufferGeometry
    this._haloGeo   = new THREE.PlaneGeometry(14, 14);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.downVect = new THREE.Vector3(0, -1, 0);
    this.rayOrigin = new THREE.Vector3();
  }

  _makeLampHaloTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, cx);
    grd.addColorStop(0,    'rgba(255, 180, 60, 0.55)');
    grd.addColorStop(0.35, 'rgba(255, 150, 30, 0.25)');
    grd.addColorStop(1,    'rgba(255, 120,  0, 0.0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }
  async build(ways, heightScale = 1, lat = 0, lng = 0, radiusMeters = 500) {
    let buildings = 0, roads = 0, water = 0, parks = 0, tris = 0;
    const gridSize = 64;
    let elevGrid   = null;
    try {
      elevGrid = await fetchElevationGrid(lat, lng, radiusMeters, gridSize);
    } catch (_) {}
    const rawSample = (c, r) => {
      if (!elevGrid) return 0;
    
      const h = elevGrid[r * gridSize + c];
    
      // 🚨 hard validation
      if (!Number.isFinite(h) || h < ELEV_MIN || h > ELEV_MAX) {
        return null;
      }
    
      return h;
    };
    const rawElev = (x, z) => {
      if (!elevGrid) return 0;
    
      const halfR = radiusMeters;
    
      const fc = (x + halfR) / (halfR * 2) * (gridSize - 1);
      const fr = (z + halfR) / (halfR * 2) * (gridSize - 1);
    
      const c0 = Math.max(0, Math.min(gridSize - 2, Math.floor(fc)));
      const r0 = Math.max(0, Math.min(gridSize - 2, Math.floor(fr)));
      const c1 = c0 + 1, r1 = r0 + 1;
    
      const tc = fc - c0;
      const tr = fr - r0;
    
      // ✅ fetch samples safely
      let h00 = rawSample(c0, r0);
      let h10 = rawSample(c1, r0);
      let h01 = rawSample(c0, r1);
      let h11 = rawSample(c1, r1);
    
      // 🚨 if any sample is bad → repair using neighbors
      const samples = [h00, h10, h01, h11].filter(v => v !== null);
    
      if (samples.length === 0) return 0;
    
      const fallback = samples.reduce((a, b) => a + b, 0) / samples.length;
    
      if (h00 === null) h00 = fallback;
      if (h10 === null) h10 = fallback;
      if (h01 === null) h01 = fallback;
      if (h11 === null) h11 = fallback;
    
      // 🎯 normal bilinear interpolation
      let h =
        h00 * (1 - tc) * (1 - tr) +
        h10 * tc       * (1 - tr) +
        h01 * (1 - tc) * tr +
        h11 * tc       * tr;

      const neighborAvg = (h00 + h10 + h01 + h11) * 0.25;
      const ELEV_SPIKE_THRESHOLD = Math.max(50, Math.abs(neighborAvg) * 0.5);
      if (Math.abs(h - neighborAvg) > ELEV_SPIKE_THRESHOLD) {
        h = neighborAvg;
      }
      return h;
    };
  
    const centreElev = rawElev(0, 0);
    const elev = (x, z) => rawElev(x, z) - centreElev;
  
    const buildingFootprints = [];
    const rawRoadTris = [];
    const roadWays = [];
    const tallBuildings = [];
    const railWays = [];
    const stepsWays = [];
    const footbridgeWays = [];
    const parkWays = [];
  
    const placedFootprints = [];
  
    // 🔥 MERGED BUFFERS
    const pos = [];
    const nrm = [];
    const col = [];
    const idx = [];
  
    let indexOffset = 0;
  
    for (const way of ways) {
      try {
        if (way.kind === 'building' && way.closed) {
          const result = this._buildingMesh(way, heightScale, elev, placedFootprints);
          if (!result) continue;
  
          const geom = result.mesh.geometry;
          const positions = geom.attributes.position.array;
          const normals   = geom.attributes.normal.array;
          const indices   = geom.index.array;
  
          const colorWall = new THREE.Color(buildingPalette(way.tags));
          const colorRoof = new THREE.Color(roofColour(way.tags));
  
          // push vertices
          for (let i = 0; i < positions.length; i += 3) {
            pos.push(positions[i], positions[i+1], positions[i+2]);
            nrm.push(normals[i], normals[i+1], normals[i+2]);
          }
  
          // SIMPLE + FAST: assign per-vertex (no index lookup)
          const vertexCount = positions.length / 3;

          // group split point (walls first, then roof)
          const roofStart = geom.groups[1].start;

          // convert index offset → vertex offset
          const roofVertexStart = indices
            .slice(0, roofStart)
            .reduce((max, i) => Math.max(max, i), 0) + 1;

          for (let i = 0; i < vertexCount; i++) {
            const c = (i < roofVertexStart) ? colorWall : colorRoof;
            col.push(c.r, c.g, c.b);
          }
  
          // indices
          for (let i = 0; i < indices.length; i++) {
            idx.push(indices[i] + indexOffset);
          }
  
          indexOffset += positions.length / 3;
  
          buildingFootprints.push({ verts: result.verts, baseY: result.baseY });
          placedFootprints.push({ verts: result.verts, baseY: result.baseY, topY: result.topY });
  
          if (result.topY - result.baseY >= 30) {
            tallBuildings.push({ verts: result.verts, topY: result.topY });
          }
  
          buildings++;
        }
  
        else if (way.kind === 'road') {
          const ts = this._roadTriangles(way);
          if (ts) {
            ts.forEach(t => rawRoadTris.push(t));
            roads++;
            if (LAMP_ROAD_TYPES.has(way.tags.highway)) roadWays.push(way);
          }
        }
  
        else if (way.kind === 'water' && way.closed) {
          const r = this._waterPolyGeom(way, elev);
          if (r) {
            this._appendGeom(r, water);
            water++;
          }
        }

        else if (way.kind === 'rail') {
          railWays.push(way);
        }

        else if (way.kind === 'steps') {
          stepsWays.push(way);
        }

        else if (way.kind === 'footbridge') {
          footbridgeWays.push(way);
        }

        else if ((way.kind === 'park') && way.closed) {
          parkWays.push(way);
        }

        // 'construction' classified ways are currently recognised but
        // intentionally produce no geometry — reserved for future use.
  
      } catch (_) {}
    }
  
    // 🌍 terrain
    this.scene.buildElevationGround(elev, gridSize, radiusMeters, buildingFootprints);
  
    const terrainMesh = this.scene.getTerrainMesh();
    let bvh = null;
  
    if (terrainMesh) {
      try {
        terrainMesh.geometry.boundsTree = new MeshBVH(terrainMesh.geometry);
        bvh = terrainMesh.geometry.boundsTree;
        // Register now that BVH exists — addObject ran before BVH was built.
        this.scene.registerCollidable(terrainMesh);
      } catch (e) {}
    }

    // ── All rail buffers accumulated here before the single merged flush ──
    const allRailBuffers = [];

    // 🚧 rails — processed after terrainMesh exists so _snapY works correctly
    // OSM railway ways carry no height tag; force height=0.02 so the track
    // tube (±0.06 m cross-section) sits flush at ground level without
    // z-fighting against the terrain mesh.
    for (const way of railWays) {
      try {
        const railWay = { ...way, tags: { ...way.tags, height: '0.02' } };
        const rb = this._buildRailMesh(railWay, elev, terrainMesh);
        if (rb) allRailBuffers.push(rb);
      } catch (_) {}
    }

    // 🪜 stairs — deferred: need terrain + buildings buffer still open
    for (const way of stepsWays) {
      try {
        const result = this._buildStaircaseMesh(way, elev, terrainMesh);
        if (!result) continue;
        // Append solid geometry into shared buildings buffer
        for (const v of result.pos) pos.push(v);
        for (const v of result.nrm) nrm.push(v);
        for (const v of result.col) col.push(v);
        for (const i of result.idx) idx.push(i + indexOffset);
        indexOffset += result.pos.length / 3;
        // Collect handrail buffers
        for (const rb of result.railBuffers) allRailBuffers.push(rb);
      } catch (_) {}
    }

    // 🌉 footbridges — deferred: need terrain + allWays for deck height
    for (const way of footbridgeWays) {
      try {
        const result = this._buildFootbridgeMesh(way, elev, terrainMesh, ways);
        if (!result) continue;
        for (const v of result.pos) pos.push(v);
        for (const v of result.nrm) nrm.push(v);
        for (const v of result.col) col.push(v);
        for (const i of result.idx) idx.push(i + indexOffset);
        indexOffset += result.pos.length / 3;
        for (const rb of result.railBuffers) allRailBuffers.push(rb);
      } catch (_) {}
    }
  
    // 🛣 ROADS
    if (rawRoadTris.length) {
      const draped = this._drapeTriangles(rawRoadTris, terrainMesh, bvh, elev, DRAPE_BIAS);
      const roadGeom = this._buildGeom(draped.pos, draped.idx, draped.nrm);

      // Roads are decorative only — no collision
      const mesh = new THREE.Mesh(
        roadGeom,
        new THREE.MeshLambertMaterial({
          color: 0x505058,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        })
      );
      mesh.receiveShadow = true;
      this.scene.addObject(mesh);
      tris += draped.idx.length / 3;
    }

    // 💡 lamps — globes are InstancedMesh; halos are a single merged BufferGeometry;
    // posts remain a merged BVH-collidable mesh (unchanged).
    if (roadWays.length) {
      const lampResult = this._buildStreetLamps(roadWays, elev, terrainMesh);
      if (lampResult) {
        const { group, globeInstanced, haloMesh, positions } = lampResult;

        // Add whole group to scene (non-collidable at group level)
        this.scene.addObject(group);

        // Register merged post collidable
        group.traverse(c => {
          if (c.isMesh && c.userData.isLampPostMerged && c.geometry?.boundsTree) {
            this.scene.registerCollidable(c);
          }
        });

        // Register instanced globe + merged halo for LOD & time-of-day updates
        this.scene.registerLampInstanced({
          globeInstanced,
          haloMesh,
          positions,
          type: 'street',
        });
      }
    }
  
    // ✈️ aviation lights — InstancedMesh, no LOD (always visible, few instances)
    if (tallBuildings.length) {
      const aviatResult = this._buildAviationLights(tallBuildings);
      if (aviatResult) {
        const { group, aviatInstanced } = aviatResult;
        this.scene.addObject(group);
        this.scene.registerLampInstanced({
          globeInstanced: aviatInstanced,
          haloMesh:       null,
          positions:      null,
          type: 'aviation',
        });
      }
    }

    // 🏠 ROOF RAILS — perimeter rails on rooftops of buildings ≥ 3 m tall
    const roofRailBuffers = this._buildRoofRails(placedFootprints, elev, terrainMesh);
    for (const rb of roofRailBuffers) allRailBuffers.push(rb);

    // 🏯 ROOF PARAPETS — 1 m solid parapet walls + elevated rails on tall buildings
    //    (the same set that receives aviation lights, height ≥ 30 m)
    if (tallBuildings.length) {
      const parapetResult = this._buildRoofParapets(tallBuildings, elev, terrainMesh);
      for (const v of parapetResult.pos) pos.push(v);
      for (const v of parapetResult.nrm) nrm.push(v);
      for (const v of parapetResult.col) col.push(v);
      for (const i of parapetResult.idx) idx.push(i + indexOffset);
      indexOffset += parapetResult.pos.length / 3;
      for (const rb of parapetResult.railBuffers) allRailBuffers.push(rb);
    }

    // 🌉 ROAD EDGE RAILS — guard rails on bridge road segments with significant drops
    const roadEdgeRailBuffers = this._buildRoadEdgeRails(roadWays, elev, terrainMesh);
    for (const rb of roadEdgeRailBuffers) allRailBuffers.push(rb);

    // ✦ INTERSECTION RAILS — short decorative spurs at road intersections
    const intersectionRailBuffers = this._buildIntersectionRails(roadWays, elev, terrainMesh);
    for (const rb of intersectionRailBuffers) allRailBuffers.push(rb);

    // 🏗️ STREET FURNITURE — construction sites, park furniture, skate parks
    {
      const emptyCells = this._findEmptyCells(placedFootprints, roadWays, radiusMeters);
      const innerRadius = radiusMeters * 0.8;
      const skateparkCells = [];
      const constrCells    = [];

      for (const cell of emptyCells) {
        const dist = Math.sqrt(cell.x * cell.x + cell.z * cell.z);
        if (dist > innerRadius) continue;

        // Seeded probability per cell
        const cellSeed = _lcgSeed(Math.round(cell.x * 100) ^ Math.round(cell.z * 100));
        const r1 = _lcgNext(cellSeed) / 0xffffffff;
        const r2 = _lcgNext(r1 * 0xffffffff | 0) / 0xffffffff;

        if (r1 < 0.15) {
          skateparkCells.push(cell);
        } else if (r2 < 0.30) {
          constrCells.push(cell);
        }
      }

      // Remove overlapping skate parks (keep non-overlapping subset, ~40 m separation)
      const usedSkate = [];
      for (const cell of skateparkCells) {
        const tooClose = usedSkate.some(u => {
          const dx = u.x - cell.x, dz = u.z - cell.z;
          return Math.sqrt(dx * dx + dz * dz) < 40;
        });
        if (!tooClose) usedSkate.push(cell);
      }

      // 🏗️ Construction sites
      for (const cell of constrCells) {
        try {
          const seed = _lcgSeed(Math.round(cell.x * 37) ^ Math.round(cell.z * 53));
          const result = this._buildConstructionSite(cell.x, cell.z, elev, terrainMesh, seed);
          if (result) {
            for (const v of result.pos) pos.push(v);
            for (const v of result.nrm) nrm.push(v);
            for (const v of result.col) col.push(v);
            for (const i of result.idx) idx.push(i + indexOffset);
            indexOffset += result.pos.length / 3;
            for (const rb of result.railBuffers) allRailBuffers.push(rb);
          }
        } catch (_) {}
      }

      // 🌳 Park furniture
      for (const way of parkWays) {
        try {
          const cx = way.coords.reduce((s, p) => s + p.x, 0) / way.coords.length;
          const cz = way.coords.reduce((s, p) => s + p.z, 0) / way.coords.length;
          const seed = _lcgSeed(Math.round(cx * 41) ^ Math.round(cz * 67));
          const result = this._buildParkFurniture(way, elev, terrainMesh, seed);
          if (result) {
            for (const v of result.pos) pos.push(v);
            for (const v of result.nrm) nrm.push(v);
            for (const v of result.col) col.push(v);
            for (const i of result.idx) idx.push(i + indexOffset);
            indexOffset += result.pos.length / 3;
            for (const rb of result.railBuffers) allRailBuffers.push(rb);
          }
        } catch (_) {}
      }

      // 🛹 Skate parks — appended into shared buildings buffer
      for (const cell of usedSkate) {
        try {
          const seed = _lcgSeed(Math.round(cell.x * 73) ^ Math.round(cell.z * 89));
          const angle = (_lcgNext(seed) / 0xffffffff) * Math.PI * 2;
          const result = this._buildSkatepark(
            cell.x, cell.z, angle, elev, terrainMesh, seed,
            pos, nrm, col, idx, indexOffset
          );
          if (result) {
            indexOffset = result.newIndexOffset;
            for (const rb of result.railBuffers) allRailBuffers.push(rb);
          }
        } catch (_) {}
      }
    }

    // 🏢 BUILDING MESH (SINGLE) — buildings, stairs, bridges, construction, parks, skateparks
    if (idx.length) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geom.setAttribute('normal',   new THREE.Float32BufferAttribute(nrm, 3));
      geom.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
      geom.setIndex(idx);

      // ✅ BVH for player collision against building walls and roofs
      try { geom.boundsTree = new MeshBVH(geom); } catch (_) {}

      const mat = new THREE.MeshToonMaterial({
        vertexColors: true,
        gradientMap: this._toonGradient,
      });

      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.addObject(mesh);          // add to scene/objects
      this.scene.registerCollidable(mesh); // register NOW that BVH exists

      tris += idx.length / 3;
    }

    // 🛤️ MERGED RAILS — one mesh for OSM rails, staircase handrails, bridge handrails,
    //                    roof rails, road edge rails, and intersection spurs
    this._flushRailMesh(allRailBuffers);
    tris += allRailBuffers.reduce((sum, rb) => sum + rb.idx.length / 3, 0);
    fetchSatelliteTexture(lat, lng, radiusMeters)
      .then(tex => this.scene.setGroundTexture(tex))
      .catch(() => {});
  
    return { buildings, roads, water, parks, triangleCount: Math.round(tris) };
  }

  // ═══════════════════════════════════════════════════════════════
  // STREET LAMPS — with spatial deduplication grid
  // ═══════════════════════════════════════════════════════════════

  _snapY(x, z, elev, terrainMesh, bias) {
    if (!terrainMesh) return elev(x, z);
    this.rayOrigin.set(x, RAY_ORIGIN_Y, z);
    this.raycaster.set(this.rayOrigin, this.downVect);
    const hits = this.raycaster.intersectObject(terrainMesh, false);
    return hits.length > 0 ? hits[0].point.y + bias : elev(x, z) + bias;
  };
  _buildStreetLamps(roadWays, elev, terrainMesh) {
    // ── First pass: collect all unique lamp positions ─────────────
    const placed   = new Set();
    const dedupKey = (x, z) =>
      `${Math.round(x / LAMP_DEDUP_CELL)},${Math.round(z / LAMP_DEDUP_CELL)}`;

    // Accumulate lamp data before allocating instanced buffers
    const lampData = [];   // { lx, lz, baseY }

    for (const way of roadWays) {
      const coords = way.coords;
      if (coords.length < 2) continue;

      const centreline = this._subdividePolyline(coords, LAMP_SPACING);
      if (centreline.length < 2) continue;

      for (let i = 0; i < centreline.length; i++) {
        const prev = centreline[i - 1] || centreline[i];
        const next = centreline[i + 1] || centreline[i];
        const dx   = next.x - prev.x, dz = next.z - prev.z;
        const len  = Math.sqrt(dx * dx + dz * dz) || 1;
        const nx   = -dz / len, nz =  dx / len;

        const lx = centreline[i].x + nx * LAMP_SIDE_OFFSET;
        const lz = centreline[i].z + nz * LAMP_SIDE_OFFSET;
        const k  = dedupKey(lx, lz);
        if (placed.has(k)) continue;
        placed.add(k);

        const baseY = this._snapY(lx, lz, elev, terrainMesh, 0);
        lampData.push({ lx, lz, baseY });
      }
    }

    if (!lampData.length) return null;

    const count  = lampData.length;
    const group  = new THREE.Group();
    group.name   = 'streetLamps';

    // ── Merged post buffers (unchanged from before) ───────────────
    const postGeoIndex  = this._postGeo.index.array;
    const postGeoPos    = this._postGeo.attributes.position.array;
    const postGeoNrm    = this._postGeo.attributes.normal.array;
    const postVertCount = postGeoPos.length / 3;
    const postIdxCount  = postGeoIndex.length;

    const mergedPos = new Float32Array(count * postVertCount * 3);
    const mergedNrm = new Float32Array(count * postVertCount * 3);
    const mergedIdx = new Uint32Array(count * postIdxCount);

    // ── InstancedMesh for globes ──────────────────────────────────
    const globeInstanced = new THREE.InstancedMesh(
      this._globeGeo,
      this._lampGlobeMat,
      count,
    );
    globeInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    globeInstanced.frustumCulled = false;
    globeInstanced.castShadow    = false;
    // Start all instances hidden (scale=0); LOD tick enables them
    globeInstanced.count = count;
    globeInstanced.userData.isGlobeInstanced = true;

    // ── Parallel world positions array for LOD distance checks ────
    // Float32Array [x0,y0,z0, x1,y1,z1, …]  (globe heads, not feet)
    const positions = new Float32Array(count * 3);

    // ── Merged halo BufferGeometry ────────────────────────────────
    // Each halo is a 14×14 plane (2 triangles = 6 indices, 4 verts)
    // rotated -90° around X and placed at terrain Y + 0.08.
    // We bake the rotation and world position directly into vertex data
    // so the single merged mesh needs no per-frame matrix updates.
    const HALO_VERTS = 4;
    const HALO_IDX   = 6;
    const haloPos = new Float32Array(count * HALO_VERTS * 3);
    const haloUV  = new Float32Array(count * HALO_VERTS * 2);
    const haloIdx = new Uint32Array(count * HALO_IDX);
    // PlaneGeometry(14,14) local vertices (before rotation), in XZ after -90° X:
    //   local plane is in XY → after rotateX(-PI/2) Y becomes -Z, Z becomes Y
    //   local verts: (-7,-7,0),(7,-7,0),(7,7,0),(-7,7,0)  (CCW in XY)
    //   after -PI/2 rotation around X: y' = z_local = 0, z' = -y_local
    //   so: (-7, 0, 7),( 7, 0, 7),( 7, 0,-7),(-7, 0,-7)
    const HLX = [-7,  7,  7, -7];
    const HLZ = [ 7,  7, -7, -7];
    const HUU = [ 0,  1,  1,  0];
    const HUV = [ 1,  1,  0,  0];
    // CCW winding viewed from above: 0,1,2,  0,2,3
    const HIDX = [0, 1, 2,  0, 2, 3];

    const dummy = new THREE.Matrix4();
    const scaleZero  = new THREE.Matrix4().makeScale(0, 0, 0);

    for (let i = 0; i < count; i++) {
      const { lx, lz, baseY } = lampData[i];
      const globeY = baseY + 6.8;
      const postCY = baseY + 3.25;

      // ── Position record ─────────────────────────────────────────
      positions[i * 3]     = lx;
      positions[i * 3 + 1] = globeY;
      positions[i * 3 + 2] = lz;

      // ── Globe instance matrix — start hidden (scale 0) ──────────
      globeInstanced.setMatrixAt(i, scaleZero);

      // ── Merge post vertices ─────────────────────────────────────
      const vBase = i * postVertCount;
      const vi3   = vBase * 3;
      for (let v = 0; v < postVertCount; v++) {
        const s = v * 3;
        mergedPos[vi3 + s]     = postGeoPos[s]     + lx;
        mergedPos[vi3 + s + 1] = postGeoPos[s + 1] + postCY;
        mergedPos[vi3 + s + 2] = postGeoPos[s + 2] + lz;
        mergedNrm[vi3 + s]     = postGeoNrm[s];
        mergedNrm[vi3 + s + 1] = postGeoNrm[s + 1];
        mergedNrm[vi3 + s + 2] = postGeoNrm[s + 2];
      }
      const iBase = i * postIdxCount;
      for (let t = 0; t < postIdxCount; t++) {
        mergedIdx[iBase + t] = postGeoIndex[t] + vBase;
      }

      // ── Bake halo quad into merged geometry ─────────────────────
      const HALO_BIAS = 0.5;//0.18;
      const hvBase  = i * HALO_VERTS;
      const hv3     = hvBase * 3;
      const huv2    = hvBase * 2;
      for (let v = 0; v < HALO_VERTS; v++) {
        const cornerX = lx + HLX[v];
        const cornerZ = lz + HLZ[v];
        haloPos[hv3 + v * 3]     = cornerX;
        haloPos[hv3 + v * 3 + 1] = this._snapY(cornerX, cornerZ, elev, terrainMesh, HALO_BIAS);
        haloPos[hv3 + v * 3 + 2] = cornerZ;
        haloUV [huv2 + v * 2]    = HUU[v];
        haloUV [huv2 + v * 2 + 1]= HUV[v];
      }
      const hiBase = i * HALO_IDX;
      for (let t = 0; t < HALO_IDX; t++) {
        haloIdx[hiBase + t] = HIDX[t] + hvBase;
      }
    }

    globeInstanced.instanceMatrix.needsUpdate = true;

    // ── Build merged post mesh ────────────────────────────────────
    const postGeom = new THREE.BufferGeometry();
    postGeom.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
    postGeom.setAttribute('normal',   new THREE.BufferAttribute(mergedNrm, 3));
    postGeom.setIndex(new THREE.BufferAttribute(mergedIdx, 1));
    try { postGeom.boundsTree = new MeshBVH(postGeom); } catch (_) {}

    const postMesh = new THREE.Mesh(postGeom, this._lampPostMat);
    postMesh.castShadow = true;
    postMesh.userData.isLampPostMerged = true;
    group.add(postMesh);

    // ── Build merged halo mesh ────────────────────────────────────
    const haloGeom = new THREE.BufferGeometry();
    haloGeom.setAttribute('position', new THREE.BufferAttribute(haloPos, 3));
    haloGeom.setAttribute('uv',       new THREE.BufferAttribute(haloUV,  2));
    haloGeom.setIndex(new THREE.BufferAttribute(haloIdx, 1));

    const haloMat = new THREE.MeshBasicMaterial({
      map:         this._lampHaloTex,
      transparent: true,
      opacity:     0,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });
    const haloMesh = new THREE.Mesh(haloGeom, haloMat);
    haloMesh.renderOrder          = 1;
    haloMesh.frustumCulled        = false;
    haloMesh.userData.isLampHalo  = true;
    group.add(haloMesh);

    // ── Add instanced globe mesh to group ─────────────────────────
    group.add(globeInstanced);

    return { group, globeInstanced, haloMesh, positions };
  }

  // ═══════════════════════════════════════════════════════════════
  // DRAPING ENGINE
  // ═══════════════════════════════════════════════════════════════

  _drapeTriangles(inputTris, terrainMesh, bvh, elev, bias) {
    const outPos = [], outIdx = [], outNrm = [];

    for (const tri of inputTris) {
      const minX = Math.min(tri.a.x, tri.b.x, tri.c.x);
      const maxX = Math.max(tri.a.x, tri.b.x, tri.c.x);
      const minZ = Math.min(tri.a.z, tri.b.z, tri.c.z);
      const maxZ = Math.max(tri.a.z, tri.b.z, tri.c.z);
      const corners  = [tri.a, tri.b, tri.c];
      const edgePts  = [[{ x: tri.a.x, z: tri.a.z }],[{ x: tri.b.x, z: tri.b.z }],[{ x: tri.c.x, z: tri.c.z }]];
      const edgeNext = [tri.b, tri.c, tri.a];

      if (bvh) {
        const queryBox = new THREE.Box3(
          new THREE.Vector3(minX, -10000, minZ),
          new THREE.Vector3(maxX,  10000, maxZ)
        );
        try {
          bvh.shapecast({
            intersectsBounds: (box) => box.intersectsBox(queryBox),
            intersectsTriangle: (terrTri) => {
              const tVerts = [terrTri.a, terrTri.b, terrTri.c];
              for (let ei = 0; ei < 3; ei++) {
                const es = corners[ei], ee = edgeNext[ei];
                for (let ti = 0; ti < 3; ti++) {
                  const tv0 = tVerts[ti], tv1 = tVerts[(ti + 1) % 3];
                  const pt = this._segSegIntersectXZ(es.x, es.z, ee.x, ee.z, tv0.x, tv0.z, tv1.x, tv1.z);
                  if (pt) edgePts[ei].push(pt);
                }
              }
              return false;
            },
          });
        } catch (e) {}
      }

      for (let ei = 0; ei < 3; ei++) {
        const start = corners[ei];
        edgePts[ei].push({ x: edgeNext[ei].x, z: edgeNext[ei].z });
        edgePts[ei].sort((p, q) => {
          const dp = (p.x - start.x) ** 2 + (p.z - start.z) ** 2;
          const dq = (q.x - start.x) ** 2 + (q.z - start.z) ** 2;
          return dp - dq;
        });
        edgePts[ei] = edgePts[ei].filter((p, i, arr) => {
          if (i === 0) return true;
          const prev = arr[i - 1];
          return (p.x - prev.x) ** 2 + (p.z - prev.z) ** 2 > 0.0001;
        });
      }

      const ring = [];
      for (let ei = 0; ei < 3; ei++) {
        const pts = edgePts[ei];
        for (let pi = 0; pi < pts.length - 1; pi++) ring.push(pts[pi]);
      }
      if (ring.length < 3) continue;
      for (const p of ring) p.y = this._snapY(p.x, p.z, elev, terrainMesh, bias);

      const flat    = ring.flatMap(p => [p.x, p.z]);
      const indices = earcut(flat);
      if (!indices || indices.length < 3) continue;

      const area = this._signedAreaXZ(ring);
      const base = outPos.length / 3;
      for (const p of ring) { outPos.push(p.x, p.y, p.z); outNrm.push(0, 1, 0); }
      for (let k = 0; k < indices.length; k += 3) {
        if (area >= 0) {
          outIdx.push(base + indices[k], base + indices[k + 1], base + indices[k + 2]);
        } else {
          outIdx.push(base + indices[k], base + indices[k + 2], base + indices[k + 1]);
        }
      }
    }
    return { pos: outPos, idx: outIdx, nrm: outNrm };
  }

  _segSegIntersectXZ(p1x, p1z, p2x, p2z, p3x, p3z, p4x, p4z) {
    const d1x = p2x - p1x, d1z = p2z - p1z;
    const d2x = p4x - p3x, d2z = p4z - p3z;
    const cross = d1x * d2z - d1z * d2x;
    if (Math.abs(cross) < 1e-10) return null;
    const dx = p3x - p1x, dz = p3z - p1z;
    const t  = (dx * d2z - dz * d2x) / cross;
    const u  = (dx * d1z - dz * d1x) / cross;
    const eps = 1e-6;
    if (t > eps && t < 1 - eps && u > eps && u < 1 - eps) {
      return { x: p1x + t * d1x, z: p1z + t * d1z };
    }
    return null;
  }

  _signedAreaXZ(pts) {
    let area = 0, n = pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += pts[i].x * pts[j].z - pts[j].x * pts[i].z;
    }
    return area / 2;
  }

  _roadTriangles(way) {
    const coords = way.coords;
    if (coords.length < 2) return null;
    const hw         = this._roadHalfWidth(way.tags.highway);
    const centreline = this._subdividePolyline(coords, ROAD_STEP);
    if (centreline.length < 2) return null;
    const left = [], right = [];
    for (let i = 0; i < centreline.length; i++) {
      const prev = centreline[i - 1] || centreline[i];
      const next = centreline[i + 1] || centreline[i];
      const dx   = next.x - prev.x, dz = next.z - prev.z;
      const len  = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx   = -dz / len, nz = dx / len;
      left.push ({ x: centreline[i].x + nx * hw, z: centreline[i].z + nz * hw });
      right.push({ x: centreline[i].x - nx * hw, z: centreline[i].z - nz * hw });
    }
    const tris = [];
    for (let i = 0; i < centreline.length - 1; i++) {
      tris.push({ a: left[i],   b: left[i+1],  c: right[i]   });
      tris.push({ a: right[i],  b: left[i+1],  c: right[i+1] });
    }
    return tris;
  }

  _buildGeom(positions, indices, normals) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
    geom.setIndex(indices);
    return geom;
  }

  _subdivideSegment(ax, az, bx, bz, step) {
    const dx  = bx - ax, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len === 0) return [{ x: ax, z: az }];
    const count = Math.max(1, Math.ceil(len / step));
    const pts   = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      pts.push({ x: ax + dx * t, z: az + dz * t });
    }
    return pts;
  }

  _subdividePolyline(coords, step) {
    const result = [];
    for (let i = 0; i < coords.length; i++) {
      if (i === coords.length - 1) { result.push({ x: coords[i].x, z: coords[i].z }); break; }
      const pts = this._subdivideSegment(coords[i].x, coords[i].z, coords[i+1].x, coords[i+1].z, step);
      for (let k = 0; k < pts.length - 1; k++) result.push(pts[k]);
    }
    return result;
  }

  _subdivideRing(verts, step) {
    const n = verts.length, result = [];
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const pts  = this._subdivideSegment(verts[i].x, verts[i].z, verts[next].x, verts[next].z, step);
      for (let k = 0; k < pts.length - 1; k++) result.push(pts[k]);
    }
    return result;
  }

  _signedArea(verts) {
    let area = 0, n = verts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += verts[i].x * verts[j].z - verts[j].x * verts[i].z;
    }
    return area / 2;
  }

  _ensureCCW(verts) {
    return this._signedArea(verts) < 0 ? verts.slice().reverse() : verts;
  }

  _waterPolyGeom(way, elev) {
    const raw = this._ensureCCW(way.coords.slice(0, -1));
    if (raw.length < 3) return null;
    const verts = this._subdivideRing(raw, POLY_STEP);
    if (verts.length < 3) return null;
    const flat    = verts.flatMap(v => [v.x, v.z]);
    const indices = earcut(flat);
    if (!indices.length) return null;
    const avgY = verts.reduce((s, v) => s + elev(v.x, v.z), 0) / verts.length + 0.4;
    const pos  = verts.flatMap(v => [v.x, avgY, v.z]);
    const nrm  = new Array(pos.length).fill(0);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    const flipped = [];
    for (let i = 0; i < indices.length; i += 3) flipped.push(indices[i], indices[i+2], indices[i+1]);
    return { pos, idx: flipped, nrm };
  }

  // ── Footprint centroid ────────────────────────────────────────
  _centroid(verts) {
    let cx = 0, cz = 0;
    for (const v of verts) { cx += v.x; cz += v.z; }
    return { x: cx / verts.length, z: cz / verts.length };
  }

  // ── Point-in-polygon (XZ plane) ───────────────────────────────
  _pointInFootprint(px, pz, verts) {
    let inside = false;
    const n = verts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = verts[i].x, zi = verts[i].z;
      const xj = verts[j].x, zj = verts[j].z;
      //if (((zi > pz) !== (zj > pz)) &&
      //    (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) inside = !inside;
          
      if (((zi > pz) !== (zj > pz)) &&
        (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) return true;// = !inside;
    }
    return inside;
  }
  _segmentsIntersect(a, b, c, d) {
    const orient = (p, q, r) => {
      const val = (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
      if (Math.abs(val) < 1e-9) return 0; // collinear
      return val > 0 ? 1 : -1; // CCW or CW
    };
  
    const onSegment = (p, q, r) => {
      return (
        Math.min(p.x, q.x) <= r.x + 1e-9 &&
        Math.max(p.x, q.x) >= r.x - 1e-9 &&
        Math.min(p.z, q.z) <= r.z + 1e-9 &&
        Math.max(p.z, q.z) >= r.z - 1e-9
      );
    };
  
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
  
    // General case
    if (o1 !== o2 && o3 !== o4) return true;
  
    // Special cases (collinear)
    if (o1 === 0 && onSegment(a, b, c)) return true;
    if (o2 === 0 && onSegment(a, b, d)) return true;
    if (o3 === 0 && onSegment(c, d, a)) return true;
    if (o4 === 0 && onSegment(c, d, b)) return true;
  
    return false;
  }
  _polygonsOverlap(aVerts, bVerts) {
    const nA = aVerts.length;
    const nB = bVerts.length;
  
    // 1. Edge intersection test
    for (let i = 0; i < nA; i++) {
      const a1 = aVerts[i];
      const a2 = aVerts[(i + 1) % nA];
  
      for (let j = 0; j < nB; j++) {
        const b1 = bVerts[j];
        const b2 = bVerts[(j + 1) % nB];
  
        if (this._segmentsIntersect(a1, a2, b1, b2)) {
          return true;
        }
      }
    }
  
    // 2. Containment test (no edges intersect, but one inside another)
    const a0 = aVerts[0];
    if (this._pointInFootprint(a0.x, a0.z, bVerts)) return true;
  
    const b0 = bVerts[0];
    if (this._pointInFootprint(b0.x, b0.z, aVerts)) return true;
  
    return false;
  }
  // ── Erode a polygon inward by `amount` metres toward its centroid ─
  // Used to prevent z-fighting when OSM encodes complex structures
  // (e.g. Tokyo Tower) as multiple overlapping building ways whose
  // wall faces end up exactly coplanar.
  _erodeVerts(verts, amount) {
    const n = verts.length;
    if (n < 3) return verts;
  
    // Ensure CCW winding (important for inward normals)
    verts = this._ensureCCW(verts);
  
    const result = [];
  
    const perp = (dx, dz) => ({ x: -dz, z: dx }); // 90° CCW
  
    const normalize = (x, z) => {
      const len = Math.hypot(x, z) || 1;
      return { x: x / len, z: z / len };
    };
  
    const intersectLines = (p1, d1, p2, d2) => {
      const cross = d1.x * d2.z - d1.z * d2.x;
      if (Math.abs(cross) < 1e-6) return null; // parallel
  
      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
  
      const t = (dx * d2.z - dz * d2.x) / cross;
  
      return {
        x: p1.x + d1.x * t,
        z: p1.z + d1.z * t
      };
    };
  
    for (let i = 0; i < n; i++) {
      const prev = verts[(i - 1 + n) % n];
      const curr = verts[i];
      const next = verts[(i + 1) % n];
  
      // Edge vectors
      const e1 = normalize(curr.x - prev.x, curr.z - prev.z);
      const e2 = normalize(next.x - curr.x, next.z - curr.z);
  
      // Inward normals (since CCW)
      const n1 = perp(e1.x, e1.z);
      const n2 = perp(e2.x, e2.z);
  
      // Offset points along normals
      const p1 = {
        x: curr.x + n1.x * amount,
        z: curr.z + n1.z * amount
      };
  
      const p2 = {
        x: curr.x + n2.x * amount,
        z: curr.z + n2.z * amount
      };
  
      // Directions of offset edges
      const d1 = e1;
      const d2 = e2;
  
      const intersection = intersectLines(p1, d1, p2, d2);
  
      if (intersection) {
        result.push(intersection);
      } else {
        // Fallback: average normals (handles parallel edges)
        const avgNx = n1.x + n2.x;
        const avgNz = n1.z + n2.z;
        const norm = normalize(avgNx, avgNz);
  
        result.push({
          x: curr.x + norm.x * amount,
          z: curr.z + norm.z * amount
        });
      }
    }
  
    return result;
  }

  _buildingMesh(way, heightScale, elev, placedFootprints) {
    const coords = way.coords;
    if (coords.length < 3) return null;
    let verts = this._ensureCCW(coords.slice(0, -1));
    if (verts.length < 3) return null;
    if (Math.abs(this._signedArea(verts)) < MIN_BUILDING_AREA) return null;

    // ── Overlap detection & erosion ───────────────────────────────
    // Check whether this building's centroid falls inside any already-placed
    // footprint. If so, its walls are likely coplanar with that footprint's
    // walls (classic OSM multi-part structure). Erode inward so surfaces
    // are physically separated — no GPU trick needed for truly offset geometry.
    let erodeLevel = 0;
    if (placedFootprints && placedFootprints.length > 0) {
      for (const fp of placedFootprints) {
        if (this._polygonsOverlap(verts, fp.verts)) {
          erodeLevel++;
        }
      }
    }
    
    if (erodeLevel > 0) {
      verts = this._erodeVerts(verts, erodeLevel * 0.015);
    }

    const flat    = verts.flatMap(c => [c.x, c.z]);
    const indices = earcut(flat);
    if (!indices?.length) return null;

    // Deterministic per-building Y micro-jitter (< 5 cm) breaks coplanarity
    // between buildings that share terrain height without visible effect.
    const idHash = (way.id % 997) / 997;
    const jitter = idHash * 0.045;
    const baseY  = Math.min(...verts.map(v => elev(v.x, v.z))) + jitter;
    const h      = way.height * heightScale;
    // Eroded/overlapping buildings also get a small Y lift so their roof
    // caps don't fight the parent building's roof at the same elevation.
    const topY   = baseY + h + (erodeLevel > 0 ? 0.05 : 0.002);
    const n      = verts.length;
    const pos    = [], nrm = [], idxArr = [];

    for (let i = 0; i < n; i++) {
      const j    = (i + 1) % n;
      const ax   = verts[i].x, az = verts[i].z;
      const bx   = verts[j].x, bz = verts[j].z;
      const base = pos.length / 3;
      const dx   = bx - ax, dz = bz - az;
      const len  = Math.sqrt(dx * dx + dz * dz) || 1;
      pos.push(ax, baseY, az, bx, baseY, bz, bx, topY, bz, ax, topY, az);
      for (let k = 0; k < 4; k++) nrm.push(dz / len, 0, -dx / len);
      idxArr.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }

    const wallCount = idxArr.length;
    const topBase   = pos.length / 3;
    for (const v of verts) pos.push(v.x, topY, v.z);
    for (let k = 0; k < n; k++) nrm.push(0, 1, 0);
    for (let k = 0; k < indices.length; k += 3) {
      idxArr.push(topBase + indices[k], topBase + indices[k + 2], topBase + indices[k + 1]);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('normal',   new THREE.Float32BufferAttribute(nrm, 3));
    geom.setIndex(idxArr);
    geom.addGroup(0,         wallCount,                 0);
    geom.addGroup(wallCount, idxArr.length - wallCount, 1);

    // polygonOffset as a secondary defence for any residual depth precision
    // issues at grazing angles. Overlapping (eroded) buildings get a stronger
    // pull so they always read as "in front" of the parent surface.
    const pof = erodeLevel > 0 ? -4 : -1;
    const pou = erodeLevel > 0 ? -4 : -1;

    const wallMat = new THREE.MeshToonMaterial({
      color:               new THREE.Color(buildingPalette(way.tags)),
      gradientMap:         this._toonGradient,
      polygonOffset:       true,
      polygonOffsetFactor: pof,
      polygonOffsetUnits:  pou,
    });
    const roofMat = new THREE.MeshToonMaterial({
      color:               new THREE.Color(roofColour(way.tags)),
      gradientMap:         this._toonGradient,
      polygonOffset:       true,
      polygonOffsetFactor: pof - 1,
      polygonOffsetUnits:  pou - 1,
    });

    const mesh = new THREE.Mesh(geom, [wallMat, roofMat]);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.userData      = { kind: 'building', tags: way.tags, height: h };
    return { mesh, verts, baseY, topY };
  }

  // ═══════════════════════════════════════════════════════════════
  // AVIATION OBSTRUCTION LIGHTS
  // Red emissive boxes placed at the 4 furthest roof corners only.
  // "Furthest" = the vertices closest to each of the 4 diagonal
  // extremes (NE, NW, SE, SW) of the building's bounding box,
  // giving exactly 4 lights per building regardless of polygon complexity.
  // ═══════════════════════════════════════════════════════════════

  _buildAviationLights(tallBuildings) {
    // ── Collect all unique aviation light positions ────────────────
    const placed   = new Set();
    const dedupKey = (x, z) => `${Math.round(x / 4)},${Math.round(z / 4)}`;

    const lightData = [];   // { x, y, z }

    for (const { verts, topY } of tallBuildings) {
      if (!verts || verts.length < 3) continue;

      const corners = [
        verts.reduce((best, v) =>  (v.x + v.z) > (best.x + best.z) ? v : best, verts[0]),
        verts.reduce((best, v) =>  (v.x - v.z) > (best.x - best.z) ? v : best, verts[0]),
        verts.reduce((best, v) => (-v.x + v.z) > (-best.x + best.z) ? v : best, verts[0]),
        verts.reduce((best, v) => (-v.x - v.z) > (-best.x - best.z) ? v : best, verts[0]),
      ];

      for (const v of corners) {
        const k = dedupKey(v.x, v.z);
        if (placed.has(k)) continue;
        placed.add(k);
        lightData.push({ x: v.x, y: topY + 0.35, z: v.z });
      }
    }

    if (!lightData.length) return null;

    const count = lightData.length;
    const group = new THREE.Group();
    group.name  = 'aviationLights';

    // ── InstancedMesh — one material for all aviation lights ──────
    const aviatInstanced = new THREE.InstancedMesh(
      this._aviatGeo,
      this._aviatMat,
      count,
    );
    aviatInstanced.frustumCulled = false;
    aviatInstanced.count         = count;
    aviatInstanced.userData.isGlobeInstanced = true;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const { x, y, z } = lightData[i];
      dummy.position.set(x, y, z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      aviatInstanced.setMatrixAt(i, dummy.matrix);
    }
    aviatInstanced.instanceMatrix.needsUpdate = true;

    group.add(aviatInstanced);
    return { group, aviatInstanced };
  }

  // ═══════════════════════════════════════════════════════════════
  // RAIL BUFFERS — produces raw {pos,nrm,idx,stations} for merging.
  // Previously returned a THREE.Mesh; now returns raw arrays so all
  // rails (OSM, staircase handrails, footbridge handrails) can be
  // flushed as a single merged mesh with one BVH.
  // ═══════════════════════════════════════════════════════════════

  _buildRailMesh(way, elev, terrainMesh) {
    const coords = way.coords;
    if (!coords || coords.length < 2) return null;

    // Resolve height: OSM height tag → fallback 1 m above terrain
    const tagHeight = way.tags?.height ? parseFloat(way.tags.height) : NaN;
    const railHeight = Number.isFinite(tagHeight) && tagHeight > 0 ? tagHeight : 1.0;

    // Diamond cross-section half-extents (in metres)
    const HALF_W = 0.06;  // left/right
    const HALF_H = 0.06;  // up/down

    // Subdivide polyline so the tube follows terrain curvature
    const centreline = this._subdividePolyline(coords, 2.0);
    if (centreline.length < 2) return null;

    // Sample Y for every station
    const stations = centreline.map(p => {
      const groundY = this._snapY(p.x, p.z, elev, terrainMesh, 0);
      return { x: p.x, y: groundY + railHeight, z: p.z };
    });

    const n = stations.length;

    const pos = [];
    const nrm = [];
    const idx = [];

    // Compute per-station frames
    const tangents = [];
    for (let i = 0; i < n; i++) {
      const prev = stations[Math.max(0, i - 1)];
      const next = stations[Math.min(n - 1, i + 1)];
      const tx = next.x - prev.x;
      const ty = next.y - prev.y;
      const tz = next.z - prev.z;
      const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      tangents.push({ x: tx / len, y: ty / len, z: tz / len });
    }

    const worldUp = { x: 0, y: 1, z: 0 };

    const cross = (a, b) => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    });
    const norm3 = v => {
      const l = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
      return { x: v.x / l, y: v.y / l, z: v.z / l };
    };

    // rings[i] = array of 4 {x,y,z} world positions for diamond corners
    const rings = [];
    for (let i = 0; i < n; i++) {
      const T = tangents[i];
      const s = stations[i];

      let R = norm3(cross(T, worldUp));
      if (R.x * R.x + R.y * R.y + R.z * R.z < 0.01) {
        R = norm3(cross(T, { x: 1, y: 0, z: 0 }));
      }
      const U = norm3(cross(R, T));

      rings.push([
        { x: s.x + U.x * HALF_H, y: s.y + U.y * HALF_H, z: s.z + U.z * HALF_H },
        { x: s.x + R.x * HALF_W, y: s.y + R.y * HALF_W, z: s.z + R.z * HALF_W },
        { x: s.x - U.x * HALF_H, y: s.y - U.y * HALF_H, z: s.z - U.z * HALF_H },
        { x: s.x - R.x * HALF_W, y: s.y - R.y * HALF_W, z: s.z - R.z * HALF_W },
      ]);
    }

    const SIDES = 4;

    for (let i = 0; i < n - 1; i++) {
      const ringA = rings[i];
      const ringB = rings[i + 1];

      for (let s = 0; s < SIDES; s++) {
        const sNext = (s + 1) % SIDES;
        const v0 = ringA[s];
        const v1 = ringA[sNext];
        const v2 = ringB[sNext];
        const v3 = ringB[s];

        const midA = { x: (v0.x + v1.x) * 0.5, y: (v0.y + v1.y) * 0.5, z: (v0.z + v1.z) * 0.5 };
        const midS = { x: (ringA[0].x + ringA[2].x) * 0.5, y: (ringA[0].y + ringA[2].y) * 0.5, z: (ringA[0].z + ringA[2].z) * 0.5 };
        const fn   = norm3({ x: midA.x - midS.x, y: midA.y - midS.y, z: midA.z - midS.z });

        const base = pos.length / 3;
        pos.push(v0.x, v0.y, v0.z);
        pos.push(v1.x, v1.y, v1.z);
        pos.push(v2.x, v2.y, v2.z);
        pos.push(v3.x, v3.y, v3.z);
        for (let k = 0; k < 4; k++) nrm.push(fn.x, fn.y, fn.z);

        idx.push(base, base + 1, base + 2);
        idx.push(base, base + 2, base + 3);
      }
    }

    // End caps
    const capRing = (ring, inward) => {
      const cx = (ring[0].x + ring[2].x) * 0.5;
      const cy = (ring[0].y + ring[2].y) * 0.5;
      const cz = (ring[0].z + ring[2].z) * 0.5;
      const base = pos.length / 3;
      pos.push(cx, cy, cz);
      nrm.push(0, inward ? -1 : 1, 0);
      for (let k = 0; k < SIDES; k++) {
        const v = ring[k];
        pos.push(v.x, v.y, v.z);
        nrm.push(0, inward ? -1 : 1, 0);
      }
      for (let k = 0; k < SIDES; k++) {
        const a = base + 1 + k;
        const b = base + 1 + (k + 1) % SIDES;
        if (inward) idx.push(base, b, a);
        else        idx.push(base, a, b);
      }
    };
    capRing(rings[0],     true);
    capRing(rings[n - 1], false);

    if (pos.length === 0 || idx.length === 0) return null;

    // Return raw buffers + station positions for merging + path storage
    return { pos, nrm, idx, stations };
  }

  // ─────────────────────────────────────────────────────────────
  // Flush all accumulated rail buffers into one merged collidable mesh.
  // Also writes centreline paths to scene._railPaths for the grind system.
  // ─────────────────────────────────────────────────────────────
  _flushRailMesh(allRailBuffers) {
    if (!allRailBuffers.length) return;

    const mergedPos = [];
    const mergedNrm = [];
    const mergedIdx = [];
    let offset = 0;

    for (const { pos, nrm, idx, stations } of allRailBuffers) {
      // Discard any buffer that contains NaN — better to skip than to poison the whole mesh
      if (pos.some(v => !Number.isFinite(v))) continue;
      for (const v of pos) mergedPos.push(v);
      for (const v of nrm) mergedNrm.push(v);
      for (const i of idx) mergedIdx.push(i + offset);
      offset += pos.length / 3;

      // Store centreline in scene for the future rail-grind system
      if (stations && this.scene._railPaths) {
        const path = stations.map(s => new THREE.Vector3(s.x, s.y, s.z));
        this.scene._railPaths.push(path);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(mergedPos, 3));
    geom.setAttribute('normal',   new THREE.Float32BufferAttribute(mergedNrm, 3));
    geom.setIndex(mergedIdx);
    try { geom.boundsTree = new MeshBVH(geom); } catch (_) {}

    const mat  = new THREE.MeshLambertMaterial({ color: 0x505560 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.userData.kind = 'rail';
    this.scene.addObject(mesh);
    this.scene.registerCollidable(mesh, true);
  }

  // ═══════════════════════════════════════════════════════════════
  // STAIRCASE MESH
  // Builds a flat ramp (collision + visual), horizontal step overlays,
  // and two handrail tubes (one on each side).
  // All solid geometry is returned as raw {pos,nrm,col,idx} arrays
  // to be appended directly into the shared buildings buffer.
  // Rail buffers are returned separately for the merged rail mesh.
  // ═══════════════════════════════════════════════════════════════

  _buildStaircaseMesh(way, elev, terrainMesh) {
    const coords = way.coords;
    if (!coords || coords.length < 2) return null;

    const width = parseFloat(way.tags?.width) || 2.0; // metres
    const hw    = width / 2;

    // Subdivide centreline for slope sampling
    const centreline = this._subdividePolyline(coords, 1.0);
    if (centreline.length < 2) return null;

    const colour = new THREE.Color(structurePalette(way.tags));
    // Step overlays slightly lighter
    const stepColour = new THREE.Color(colour).multiplyScalar(1.15);
    stepColour.r = Math.min(1, stepColour.r);
    stepColour.g = Math.min(1, stepColour.g);
    stepColour.b = Math.min(1, stepColour.b);

    const pos = [], nrm = [], col = [], idx = [];
    let offset = 0;

    // ── Helper: push a quad (two CCW triangles) ──────────────────
    const pushQuad = (v0, v1, v2, v3, nx, ny, nz, c) => {
      const base = offset;
      for (const v of [v0, v1, v2, v3]) {
        pos.push(v.x, v.y, v.z);
        nrm.push(nx, ny, nz);
        col.push(c.r, c.g, c.b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      offset += 4;
    };

    // ── Build ramp quads between each station pair ───────────────
    const n = centreline.length;
    // Precompute per-station lateral normals and snapped Y values
    const stationData = centreline.map((p, i) => {
      const prev = centreline[Math.max(0, i - 1)];
      const next = centreline[Math.min(n - 1, i + 1)];
      const dx = next.x - prev.x, dz = next.z - prev.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const groundY = this._snapY(p.x, p.z, elev, terrainMesh, 0);
      return { x: p.x, z: p.z, y: groundY, nx, nz };
    });

    const STEP_INTERVAL = 0.4; // one step quad every ~0.4 m along slope
    let stepAccum = 0;

    for (let i = 0; i < n - 1; i++) {
      const s0 = stationData[i];
      const s1 = stationData[i + 1];

      // Ramp surface quad (flat top, walks on terrain)
      const tl = { x: s0.x + s0.nx * hw, y: s0.y + 0.02, z: s0.z + s0.nz * hw };
      const tr = { x: s0.x - s0.nx * hw, y: s0.y + 0.02, z: s0.z - s0.nz * hw };
      const br = { x: s1.x - s1.nx * hw, y: s1.y + 0.02, z: s1.z - s1.nz * hw };
      const bl = { x: s1.x + s1.nx * hw, y: s1.y + 0.02, z: s1.z + s1.nz * hw };
      pushQuad(tl, tr, br, bl, 0, 1, 0, colour);

      // Step overlays — thin horizontal quads rising at each step
      const segLen = Math.sqrt(
        (s1.x - s0.x) ** 2 + (s1.z - s0.z) ** 2
      );
      stepAccum += segLen;

      if (stepAccum >= STEP_INTERVAL) {
        stepAccum -= STEP_INTERVAL;
        const NOSING_H = 0.03; // step nosing thickness
        const midY = (s0.y + s1.y) / 2 + NOSING_H;
        const mx   = (s0.x + s1.x) / 2;
        const mz   = (s0.z + s1.z) / 2;
        const mnx  = (s0.nx + s1.nx) / 2;
        const mnz  = (s0.nz + s1.nz) / 2;

        const stl = { x: mx + mnx * hw, y: midY + NOSING_H, z: mz + mnz * hw };
        const str = { x: mx - mnx * hw, y: midY + NOSING_H, z: mz - mnz * hw };
        const sbr = { x: mx - mnx * hw, y: midY,            z: mz - mnz * hw };
        const sbl = { x: mx + mnx * hw, y: midY,            z: mz + mnz * hw };
        pushQuad(stl, str, sbr, sbl, 0, 1, 0, stepColour);
      }
    }

    // ── Handrails: synthetic way objects for _buildRailMesh ──────
    const RAIL_OFFSET = hw + 0.1;
    const RAIL_HEIGHT = 0.9;

    const makeHandrailWay = (side) => {
      const railCoords = stationData.map(s => ({
        x: s.x + s.nx * side * RAIL_OFFSET,
        z: s.z + s.nz * side * RAIL_OFFSET,
      }));
      // Override Y in stations so rails follow ramp + fixed height
      return {
        coords: railCoords,
        tags:   { height: String(RAIL_HEIGHT) },
      };
    };

    const railBuffers = [];
    for (const side of [1, -1]) {
      const syntheticWay = makeHandrailWay(side);
      const rb = this._buildRailMesh(syntheticWay, elev, terrainMesh);
      if (rb) railBuffers.push(rb);
    }

    return { pos, nrm, col, idx, railBuffers };
  }

  // ═══════════════════════════════════════════════════════════════
  // FOOTBRIDGE MESH
  // Builds a raised deck with low side walls and two handrail tubes.
  // Deck height is determined by:
  //   1. The maximum (min terrain Y along way + 4.5m), or
  //   2. The max Y of any crossing way + 4.5m, whichever is higher.
  // Returns { pos,nrm,col,idx,railBuffers } for merging.
  // ═══════════════════════════════════════════════════════════════

  _buildFootbridgeMesh(way, elev, terrainMesh, allWays) {
    const coords = way.coords;
    if (!coords || coords.length < 2) return null;

    const width    = parseFloat(way.tags?.width) || 3.0;
    const hw       = width / 2;
    const wallH    = 0.9;  // side wall height above deck
    const deckBias = 4.5;  // minimum clearance above terrain

    // Subdivide centreline for sampling
    const centreline = this._subdividePolyline(coords, 2.0);
    if (centreline.length < 2) return null;
    const n = centreline.length;

    // ── Determine deck height ─────────────────────────────────────
    // Sample terrain Y every 2 m along the centreline
    let minTerrainY = Infinity;
    for (const p of centreline) {
      const ty = this._snapY(p.x, p.z, elev, terrainMesh, 0);
      if (ty < minTerrainY) minTerrainY = ty;
    }

    let deckY = minTerrainY + deckBias;

    // Also check if any crossing way pushes the deck higher
    if (allWays) {
      for (const other of allWays) {
        if (other === way || !other.coords || other.coords.length < 2) continue;
        if (other.kind !== 'road' && other.kind !== 'footbridge') continue;
        // Check if any coord from the other way falls within the bridge XZ bounding box
        const minX = Math.min(...centreline.map(p => p.x)) - hw;
        const maxX = Math.max(...centreline.map(p => p.x)) + hw;
        const minZ = Math.min(...centreline.map(p => p.z)) - hw;
        const maxZ = Math.max(...centreline.map(p => p.z)) + hw;
        const overlaps = other.coords.some(
          p => p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ
        );
        if (overlaps) {
          // Use the terrain Y of the crossing way's midpoint + clearance
          const mid = other.coords[Math.floor(other.coords.length / 2)];
          const crossY = this._snapY(mid.x, mid.z, elev, terrainMesh, 0);
          deckY = Math.max(deckY, crossY + deckBias);
        }
      }
    }

    const colour     = new THREE.Color(structurePalette(way.tags));
    const wallColour = new THREE.Color(colour).multiplyScalar(0.85);

    const pos = [], nrm = [], col = [], idx = [];
    let offset = 0;

    // ── Helper: push a quad ──────────────────────────────────────
    const pushQuad = (v0, v1, v2, v3, nx, ny, nz, c) => {
      const base = offset;
      for (const v of [v0, v1, v2, v3]) {
        pos.push(v.x, v.y, v.z);
        nrm.push(nx, ny, nz);
        col.push(c.r, c.g, c.b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      offset += 4;
    };

    // Precompute per-station lateral directions (constant Y = deckY)
    const stationData = centreline.map((p, i) => {
      const prev = centreline[Math.max(0, i - 1)];
      const next = centreline[Math.min(n - 1, i + 1)];
      const dx = next.x - prev.x, dz = next.z - prev.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const lx = -dz / len, lz = dx / len; // lateral left
      return { x: p.x, y: deckY, z: p.z, lx, lz };
    });

    for (let i = 0; i < n - 1; i++) {
      const s0 = stationData[i];
      const s1 = stationData[i + 1];

      // ── Deck surface ─────────────────────────────────────────
      const dtl = { x: s0.x + s0.lx * hw, y: deckY, z: s0.z + s0.lz * hw };
      const dtr = { x: s0.x - s0.lx * hw, y: deckY, z: s0.z - s0.lz * hw };
      const dbr = { x: s1.x - s1.lx * hw, y: deckY, z: s1.z - s1.lz * hw };
      const dbl = { x: s1.x + s1.lx * hw, y: deckY, z: s1.z + s1.lz * hw };
      pushQuad(dtl, dtr, dbr, dbl, 0, 1, 0, colour);

      // ── Left side wall (outer face) ──────────────────────────
      const wl_bl = { x: s0.x + s0.lx * hw, y: deckY,         z: s0.z + s0.lz * hw };
      const wl_tl = { x: s0.x + s0.lx * hw, y: deckY + wallH, z: s0.z + s0.lz * hw };
      const wl_tr = { x: s1.x + s1.lx * hw, y: deckY + wallH, z: s1.z + s1.lz * hw };
      const wl_br = { x: s1.x + s1.lx * hw, y: deckY,         z: s1.z + s1.lz * hw };
      pushQuad(wl_bl, wl_tl, wl_tr, wl_br, s0.lx, 0, s0.lz, wallColour);

      // ── Right side wall (outer face) ─────────────────────────
      const wr_bl = { x: s1.x - s1.lx * hw, y: deckY,         z: s1.z - s1.lz * hw };
      const wr_tl = { x: s1.x - s1.lx * hw, y: deckY + wallH, z: s1.z - s1.lz * hw };
      const wr_tr = { x: s0.x - s0.lx * hw, y: deckY + wallH, z: s0.z - s0.lz * hw };
      const wr_br = { x: s0.x - s0.lx * hw, y: deckY,         z: s0.z - s0.lz * hw };
      pushQuad(wr_bl, wr_tl, wr_tr, wr_br, -s0.lx, 0, -s0.lz, wallColour);
    }

    // ── Handrails: on top of each side wall at deckY + wallH ────
    const RAIL_ABOVE_WALL = 0.0; // rail sits exactly at wall top

    const makeHandrailWay = (side) => {
      // Explicit Y stations — rail sits at fixed deckY + wallH
      const railCoords = stationData.map(s => ({
        x: s.x + s.lx * side * hw,
        z: s.z + s.lz * side * hw,
      }));
      return {
        coords: railCoords,
        tags:   { height: String(wallH + RAIL_ABOVE_WALL) },
      };
    };

    // For footbridge handrails we need a custom _buildRailMesh that
    // ignores terrain snap and uses a fixed Y instead. We build a
    // custom variant inline using the stored deckY.
    const railBuffers = [];
    const HALF_W = 0.06, HALF_H = 0.06;

    const cross = (a, b) => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    });
    const norm3 = v => {
      const l = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
      return { x: v.x / l, y: v.y / l, z: v.z / l };
    };
    const worldUp = { x: 0, y: 1, z: 0 };

    for (const side of [1, -1]) {
      // Build fixed-height stations for the rail
      const railY = deckY + wallH + 0.03; // sit slightly above wall top
      const rStations = stationData.map(s => ({
        x: s.x + s.lx * side * hw,
        y: railY,
        z: s.z + s.lz * side * hw,
      }));
      const rn = rStations.length;
      if (rn < 2) continue;

      const rPos = [], rNrm = [], rIdx = [];

      const tangents = rStations.map((_, i) => {
        const prev = rStations[Math.max(0, i - 1)];
        const next = rStations[Math.min(rn - 1, i + 1)];
        const tx = next.x - prev.x, ty = next.y - prev.y, tz = next.z - prev.z;
        const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        return { x: tx / len, y: ty / len, z: tz / len };
      });

      const rings = rStations.map((s, i) => {
        const T = tangents[i];
        let R = norm3(cross(T, worldUp));
        if (R.x * R.x + R.y * R.y + R.z * R.z < 0.01)
          R = norm3(cross(T, { x: 1, y: 0, z: 0 }));
        const U = norm3(cross(R, T));
        return [
          { x: s.x + U.x * HALF_H, y: s.y + U.y * HALF_H, z: s.z + U.z * HALF_H },
          { x: s.x + R.x * HALF_W, y: s.y + R.y * HALF_W, z: s.z + R.z * HALF_W },
          { x: s.x - U.x * HALF_H, y: s.y - U.y * HALF_H, z: s.z - U.z * HALF_H },
          { x: s.x - R.x * HALF_W, y: s.y - R.y * HALF_W, z: s.z - R.z * HALF_W },
        ];
      });

      const SIDES = 4;
      for (let i = 0; i < rn - 1; i++) {
        const rA = rings[i], rB = rings[i + 1];
        for (let s = 0; s < SIDES; s++) {
          const sN  = (s + 1) % SIDES;
          const v0  = rA[s], v1 = rA[sN], v2 = rB[sN], v3 = rB[s];
          const midA = { x: (v0.x + v1.x) * 0.5, y: (v0.y + v1.y) * 0.5, z: (v0.z + v1.z) * 0.5 };
          const midS = { x: (rA[0].x + rA[2].x) * 0.5, y: (rA[0].y + rA[2].y) * 0.5, z: (rA[0].z + rA[2].z) * 0.5 };
          const fn   = norm3({ x: midA.x - midS.x, y: midA.y - midS.y, z: midA.z - midS.z });
          const base = rPos.length / 3;
          rPos.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z, v3.x, v3.y, v3.z);
          for (let k = 0; k < 4; k++) rNrm.push(fn.x, fn.y, fn.z);
          rIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }

      const capRing = (ring, inward) => {
        const cx = (ring[0].x + ring[2].x) * 0.5;
        const cy = (ring[0].y + ring[2].y) * 0.5;
        const cz = (ring[0].z + ring[2].z) * 0.5;
        const base = rPos.length / 3;
        rPos.push(cx, cy, cz);
        rNrm.push(0, inward ? -1 : 1, 0);
        for (let k = 0; k < SIDES; k++) {
          rPos.push(rings[inward ? 0 : rn - 1][k].x, rings[inward ? 0 : rn - 1][k].y, rings[inward ? 0 : rn - 1][k].z);
          rNrm.push(0, inward ? -1 : 1, 0);
        }
        for (let k = 0; k < SIDES; k++) {
          const a = base + 1 + k, b = base + 1 + (k + 1) % SIDES;
          if (inward) rIdx.push(base, b, a);
          else        rIdx.push(base, a, b);
        }
      };
      capRing(rings[0], true);
      capRing(rings[rn - 1], false);

      if (rPos.length > 0)
        railBuffers.push({ pos: rPos, nrm: rNrm, idx: rIdx, stations: rStations });
    }

    return { pos, nrm, col, idx, railBuffers };
  }

  // ═══════════════════════════════════════════════════════════════
  // ROOF PARAPETS — solid 1 m tall perimeter walls along every edge
  // of tall buildings (those that receive aviation lights, ≥ 30 m).
  // The matching roof rail is raised to topY + PARAPET_H + RAIL_ABOVE
  // so it sits on top of the parapet rather than flush with the roof.
  //
  // Returns { pos, nrm, col, idx, railBuffers } for direct merging
  // into the shared buildings buffer and the merged rail mesh.
  // ═══════════════════════════════════════════════════════════════

  _buildRoofParapets(tallBuildings, elev, terrainMesh) {
    const PARAPET_H    = 1.0;    // wall height above topY
    const PARAPET_THK  = 0.25;   // wall thickness (inward from edge)
    const RAIL_ABOVE   = 0.05;   // rail sits this far above parapet top
    const MIN_EDGE_LEN = 1.5;    // skip edges shorter than this

    const pos = [], nrm = [], col = [], idx = [];
    let offset = 0;
    const railBuffers = [];

    // Concrete-grey parapet colour (same palette as construction/structural elements)
    const parapetColor = new THREE.Color(structurePalette({}));

    // ── Helper: push a quad (two CCW triangles) ──────────────────
    const pushQuad = (v0, v1, v2, v3, nx, ny, nz) => {
      const base = offset;
      for (const v of [v0, v1, v2, v3]) {
        pos.push(v.x, v.y, v.z);
        nrm.push(nx, ny, nz);
        col.push(parapetColor.r, parapetColor.g, parapetColor.b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      offset += 4;
    };

    for (const { verts, topY } of tallBuildings) {
      if (!verts || verts.length < 2) continue;

      // Ensure CCW so inward normals point the right way
      const ccwVerts = this._ensureCCW(verts);
      const n = ccwVerts.length;

      const wallTopY    = topY + PARAPET_H;
      const railY       = wallTopY + RAIL_ABOVE;

      for (let i = 0; i < n; i++) {
        const a = ccwVerts[i];
        const b = ccwVerts[(i + 1) % n];

        const dx = b.x - a.x, dz = b.z - a.z;
        const edgeLen = Math.sqrt(dx * dx + dz * dz);
        if (edgeLen < MIN_EDGE_LEN) continue;

        // Outward face normal (for CCW polygon the outward normal points right of travel)
        const onx =  dz / edgeLen;   // outward X
        const onz = -dx / edgeLen;   // outward Z

        // Inward offset for wall thickness
        const inx = -onx * PARAPET_THK;
        const inz = -onz * PARAPET_THK;

        // Four corners of the outer face (outer vertical quad)
        const obl = { x: a.x,        y: topY,    z: a.z };
        const obr = { x: b.x,        y: topY,    z: b.z };
        const otr = { x: b.x,        y: wallTopY, z: b.z };
        const otl = { x: a.x,        y: wallTopY, z: a.z };

        // Outer face — normal points outward
        pushQuad(obl, otl, otr, obr, onx, 0, onz);

        // Inner face — offset inward, normal points inward
        const ibl = { x: a.x + inx, y: topY,    z: a.z + inz };
        const ibr = { x: b.x + inx, y: topY,    z: b.z + inz };
        const itr = { x: b.x + inx, y: wallTopY, z: b.z + inz };
        const itl = { x: a.x + inx, y: wallTopY, z: a.z + inz };

        // Inner face — winding reversed so normal faces inward
        pushQuad(ibl, ibr, itr, itl, -onx, 0, -onz);

        // Top cap
        pushQuad(otl, otr, itr, itl, 0, 1, 0);

        // ── Rail along outside top edge ──────────────────────────
        const rb = this._buildFixedYRailMesh(
          [{ x: a.x, z: a.z }, { x: b.x, z: b.z }],
          railY
        );
        if (rb) railBuffers.push(rb);
      }
    }

    return { pos, nrm, col, idx, railBuffers };
  }

  // ═══════════════════════════════════════════════════════════════
  // ROOF RAILS — diamond-tube rails along every roof-polygon edge
  // for buildings taller than 3 m.
  // ═══════════════════════════════════════════════════════════════

  _buildRoofRails(placedFootprints, elev, terrainMesh) {
    const MIN_EDGE_LEN = 2.0;   // metres — skip shorter edges
    const RAIL_ABOVE   = 0.05;  // metres above topY

    const buffers = [];

    for (const fp of placedFootprints) {
      const { verts, baseY, topY } = fp;
      if (!verts || verts.length < 2) continue;
      if ((topY - baseY) < 3) continue;

      const railY = topY + RAIL_ABOVE;
      const n = verts.length;

      for (let i = 0; i < n; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % n];

        const dx = b.x - a.x, dz = b.z - a.z;
        const edgeLen = Math.sqrt(dx * dx + dz * dz);
        if (edgeLen < MIN_EDGE_LEN) continue;

        const syntheticWay = {
          coords: [
            { x: a.x, z: a.z },
            { x: b.x, z: b.z },
          ],
          tags: { height: String(railY) },
        };

        // Override _buildRailMesh's terrain snap — use fixed railY.
        // We build a minimal inline buffer for a single-segment rail.
        const rb = this._buildFixedYRailMesh(syntheticWay.coords, railY);
        if (rb) buffers.push(rb);
      }
    }

    return buffers;
  }

  // ═══════════════════════════════════════════════════════════════
  // ROAD EDGE RAILS — guard rails on bridge road segments where
  // terrain drops more than 1.5 m to either side.
  // ═══════════════════════════════════════════════════════════════

  _buildRoadEdgeRails(roadWays, elev, terrainMesh) {
    const DROP_THRESHOLD = 1.5;  // metres
    const LATERAL_PROBE  = 0.5;  // metres past road edge to sample drop
    const RAIL_HEIGHT    = 0.9;  // metres above road surface

    const buffers = [];

    for (const way of roadWays) {
      if (way.tags?.bridge !== 'yes') continue;
      const coords = way.coords;
      if (!coords || coords.length < 2) continue;

      const hw = this._roadHalfWidth(way.tags.highway);
      const probeDist = hw + LATERAL_PROBE;

      const centreline = this._subdividePolyline(coords, 2.0);
      if (centreline.length < 2) continue;

      const leftCoords  = [];
      const rightCoords = [];

      for (let i = 0; i < centreline.length; i++) {
        const p    = centreline[i];
        const prev = centreline[Math.max(0, i - 1)];
        const next = centreline[Math.min(centreline.length - 1, i + 1)];
        const dx   = next.x - prev.x, dz = next.z - prev.z;
        const len  = Math.sqrt(dx * dx + dz * dz) || 1;
        const nx   = -dz / len, nz = dx / len;

        const roadY = this._snapY(p.x, p.z, elev, terrainMesh, 0);

        const lx = p.x + nx * probeDist, lz = p.z + nz * probeDist;
        const rx = p.x - nx * probeDist, rz = p.z - nz * probeDist;

        const leftGroundY  = this._snapY(lx, lz, elev, terrainMesh, 0);
        const rightGroundY = this._snapY(rx, rz, elev, terrainMesh, 0);

        const leftDrop  = roadY - leftGroundY;
        const rightDrop = roadY - rightGroundY;

        if (leftDrop > DROP_THRESHOLD) {
          leftCoords.push({ x: p.x + nx * hw, z: p.z + nz * hw, railY: roadY + RAIL_HEIGHT });
        }
        if (rightDrop > DROP_THRESHOLD) {
          rightCoords.push({ x: p.x - nx * hw, z: p.z - nz * hw, railY: roadY + RAIL_HEIGHT });
        }
      }

      // Build rail segments for each continuous run on left/right
      const buildEdgeRun = (runCoords) => {
        if (runCoords.length < 2) return;
        const railY = runCoords.reduce((s, p) => s + p.railY, 0) / runCoords.length;
        const coordList = runCoords.map(p => ({ x: p.x, z: p.z }));
        const rb = this._buildFixedYRailMesh(coordList, railY);
        if (rb) buffers.push(rb);
      };

      buildEdgeRun(leftCoords);
      buildEdgeRun(rightCoords);
    }

    return buffers;
  }

  // ═══════════════════════════════════════════════════════════════
  // INTERSECTION RAILS — short decorative rail spurs radiating from
  // road intersections (shared endpoints within 1 m).
  // Placement is seeded deterministically from intersection coords.
  // ═══════════════════════════════════════════════════════════════

  _buildIntersectionRails(roadWays, elev, terrainMesh) {
    const SNAP_DIST  = 1.0;   // metres — endpoints within this distance merge
    const SPUR_MIN   = 4.0;   // metres — minimum spur length
    const SPUR_MAX   = 8.0;   // metres — maximum spur length
    const RAIL_ABOVE = 0.05;  // metres above terrain

    const buffers = [];

    // ── Collect all way endpoints ─────────────────────────────────
    const endpoints = []; // { x, z, wayIdx, endIdx (0=start,1=end) }
    for (let wi = 0; wi < roadWays.length; wi++) {
      const coords = roadWays[wi].coords;
      if (!coords || coords.length < 2) continue;
      endpoints.push({ x: coords[0].x,                       z: coords[0].z,                       wi, end: 0 });
      endpoints.push({ x: coords[coords.length - 1].x,       z: coords[coords.length - 1].z,       wi, end: 1 });
    }

    // ── Find clusters of endpoints within SNAP_DIST ───────────────
    const visited = new Uint8Array(endpoints.length);
    const intersections = [];

    for (let i = 0; i < endpoints.length; i++) {
      if (visited[i]) continue;
      const cluster = [i];
      visited[i] = 1;
      for (let j = i + 1; j < endpoints.length; j++) {
        if (visited[j]) continue;
        const dx = endpoints[j].x - endpoints[i].x;
        const dz = endpoints[j].z - endpoints[i].z;
        if (dx * dx + dz * dz <= SNAP_DIST * SNAP_DIST) {
          cluster.push(j);
          visited[j] = 1;
        }
      }
      // Only treat as intersection if 3+ endpoint references (i.e. 2+ distinct ways)
      const uniqueWays = new Set(cluster.map(k => endpoints[k].wi));
      if (uniqueWays.size >= 2) {
        const cx = cluster.reduce((s, k) => s + endpoints[k].x, 0) / cluster.length;
        const cz = cluster.reduce((s, k) => s + endpoints[k].z, 0) / cluster.length;
        intersections.push({ cx, cz, cluster });
      }
    }

    // ── Deterministic hash from position ─────────────────────────
    const hash = (x, z) => {
      let h = (Math.round(x * 100) * 1619 + Math.round(z * 100) * 31337) >>> 0;
      h ^= h >>> 13;
      h = (Math.imul(h, 0x3d6b3b59) >>> 0);
      h ^= h >>> 16;
      return (h >>> 0) / 0xffffffff;
    };

    // ── Generate spurs ────────────────────────────────────────────
    for (const { cx, cz, cluster } of intersections) {
      const baseY = this._snapY(cx, cz, elev, terrainMesh, RAIL_ABOVE);

      // Collect road directions leaving this intersection
      const roadDirs = [];
      for (const k of cluster) {
        const ep = endpoints[k];
        const coords = roadWays[ep.wi].coords;
        if (!coords || coords.length < 2) continue;
        // Direction outward from this endpoint
        let dx, dz;
        if (ep.end === 0) {
          dx = coords[0].x - coords[1].x;
          dz = coords[0].z - coords[1].z;
        } else {
          const last = coords.length - 1;
          dx = coords[last].x - coords[last - 1].x;
          dz = coords[last].z - coords[last - 1].z;
        }
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        roadDirs.push({ dx: dx / len, dz: dz / len });
      }

      // 1–3 spurs, deterministically chosen between road directions
      const h0 = hash(cx, cz);
      const spurCount = 1 + Math.floor(h0 * 3); // 1, 2, or 3
      const angleOffsets = [0.52, -0.52, 1.04]; // ~30° and ~60°

      for (let s = 0; s < spurCount && s < roadDirs.length; s++) {
        const baseDir = roadDirs[s % roadDirs.length];
        const angleOff = angleOffsets[s % angleOffsets.length];
        const hs = hash(cx + s * 17.3, cz + s * 13.7);
        const spurLen = SPUR_MIN + hs * (SPUR_MAX - SPUR_MIN);

        const cosA = Math.cos(angleOff), sinA = Math.sin(angleOff);
        const dirX = baseDir.dx * cosA - baseDir.dz * sinA;
        const dirZ = baseDir.dx * sinA + baseDir.dz * cosA;

        const endX = cx + dirX * spurLen;
        const endZ = cz + dirZ * spurLen;
        const endY = this._snapY(endX, endZ, elev, terrainMesh, RAIL_ABOVE);

        const avgY = (baseY + endY) / 2;
        const rb = this._buildFixedYRailMesh(
          [{ x: cx, z: cz }, { x: endX, z: endZ }],
          avgY
        );
        if (rb) buffers.push(rb);
      }
    }

    return buffers;
  }

  // ═══════════════════════════════════════════════════════════════
  // FIXED-Y RAIL MESH — like _buildRailMesh but ignores terrain snap;
  // all stations are placed at the provided fixed Y value.
  // Used by roof rails, road edge rails, and intersection spurs.
  // ═══════════════════════════════════════════════════════════════

  _buildFixedYRailMesh(coords, fixedY) {
    if (!coords || coords.length < 2) return null;
    if (!Number.isFinite(fixedY)) return null;

    const HALF_W = 0.06;
    const HALF_H = 0.06;

    const centreline = this._subdividePolyline(coords, 2.0);
    if (centreline.length < 2) return null;

    const n = centreline.length;
    const stations = centreline.map(p => ({ x: p.x, y: fixedY, z: p.z }));

    const pos = [], nrm = [], idx = [];

    const cross3 = (a, b) => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    });
    const lenSq3 = v => v.x * v.x + v.y * v.y + v.z * v.z;
    const norm3 = v => {
      const l = Math.sqrt(lenSq3(v)) || 1;
      return { x: v.x / l, y: v.y / l, z: v.z / l };
    };
    const worldUp = { x: 0, y: 1, z: 0 };
    // Fallback axes for degenerate tangents
    const FALLBACK_AXES = [
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    ];

    const tangents = stations.map((_, i) => {
      const prev = stations[Math.max(0, i - 1)];
      const next = stations[Math.min(n - 1, i + 1)];
      const tx = next.x - prev.x, ty = next.y - prev.y, tz = next.z - prev.z;
      const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (len < 1e-9) return { x: 0, y: 0, z: 1 }; // degenerate — use Z
      return { x: tx / len, y: ty / len, z: tz / len };
    });

    const rings = stations.map((s, i) => {
      const T = tangents[i];
      // Find a non-degenerate right vector by trying multiple fallback axes
      let R = { x: 0, y: 0, z: 0 };
      for (const axis of FALLBACK_AXES) {
        const candidate = cross3(T, axis);
        if (lenSq3(candidate) > 1e-6) { R = norm3(candidate); break; }
      }
      // If all axes degenerate (should never happen), use (1,0,0)
      if (lenSq3(R) < 1e-6) R = { x: 1, y: 0, z: 0 };
      const U = norm3(cross3(R, T));
      return [
        { x: s.x + U.x * HALF_H, y: s.y + U.y * HALF_H, z: s.z + U.z * HALF_H },
        { x: s.x + R.x * HALF_W, y: s.y + R.y * HALF_W, z: s.z + R.z * HALF_W },
        { x: s.x - U.x * HALF_H, y: s.y - U.y * HALF_H, z: s.z - U.z * HALF_H },
        { x: s.x - R.x * HALF_W, y: s.y - R.y * HALF_W, z: s.z - R.z * HALF_W },
      ];
    });

    const SIDES = 4;

    for (let i = 0; i < n - 1; i++) {
      const rA = rings[i], rB = rings[i + 1];
      for (let s = 0; s < SIDES; s++) {
        const sN  = (s + 1) % SIDES;
        const v0  = rA[s], v1 = rA[sN], v2 = rB[sN], v3 = rB[s];
        const midA = { x: (v0.x + v1.x) * 0.5, y: (v0.y + v1.y) * 0.5, z: (v0.z + v1.z) * 0.5 };
        const midS = { x: (rA[0].x + rA[2].x) * 0.5, y: (rA[0].y + rA[2].y) * 0.5, z: (rA[0].z + rA[2].z) * 0.5 };
        const diff = { x: midA.x - midS.x, y: midA.y - midS.y, z: midA.z - midS.z };
        const fn   = lenSq3(diff) > 1e-12 ? norm3(diff) : { x: 0, y: 1, z: 0 };
        // Validate before pushing — skip any face that produces NaN
        const allFinite = [v0, v1, v2, v3].every(
          v => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
        );
        if (!allFinite) continue;
        const base = pos.length / 3;
        pos.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z, v3.x, v3.y, v3.z);
        for (let k = 0; k < 4; k++) nrm.push(fn.x, fn.y, fn.z);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }

    const capRing = (ring, inward) => {
      const cx = (ring[0].x + ring[2].x) * 0.5;
      const cy = (ring[0].y + ring[2].y) * 0.5;
      const cz = (ring[0].z + ring[2].z) * 0.5;
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return;
      const base = pos.length / 3;
      pos.push(cx, cy, cz);
      nrm.push(0, inward ? -1 : 1, 0);
      for (let k = 0; k < SIDES; k++) {
        const v = ring[k];
        if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return;
        pos.push(v.x, v.y, v.z);
        nrm.push(0, inward ? -1 : 1, 0);
      }
      for (let k = 0; k < SIDES; k++) {
        const a = base + 1 + k;
        const b = base + 1 + (k + 1) % SIDES;
        if (inward) idx.push(base, b, a);
        else        idx.push(base, a, b);
      }
    };
    capRing(rings[0],     true);
    capRing(rings[n - 1], false);

    if (pos.length === 0 || idx.length === 0) return null;
    return { pos, nrm, idx, stations };
  }

  _roadHalfWidth(highway) {
    const w = {
      motorway: 8, trunk: 6, primary: 5, secondary: 4,
      tertiary: 3, residential: 2.5, service: 1.5,
      footway: 1, path: 0.8, cycleway: 1.2,
    };
    return w[highway] ?? 2;
  }

  // ═══════════════════════════════════════════════════════════════
  // EMPTY CELL FINDER
  // Divides the map area into a grid and marks cells as occupied
  // if any building footprint vertex or road coord falls within them.
  // Returns an array of empty cell centres { x, z }.
  // ═══════════════════════════════════════════════════════════════

  _findEmptyCells(placedFootprints, roadWays, radiusMeters, cellSize = 40) {
    const half  = radiusMeters;
    const cols  = Math.ceil((half * 2) / cellSize);
    const rows  = Math.ceil((half * 2) / cellSize);
    const occ   = new Uint8Array(cols * rows);

    const markCell = (x, z) => {
      const ci = Math.floor((x + half) / cellSize);
      const ri = Math.floor((z + half) / cellSize);
      if (ci < 0 || ci >= cols || ri < 0 || ri >= rows) return;
      occ[ri * cols + ci] = 1;
      // Also mark the 8 neighbours to give a margin
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nc = ci + dc, nr = ri + dr;
          if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) occ[nr * cols + nc] = 1;
        }
      }
    };

    for (const fp of placedFootprints) {
      for (const v of fp.verts) markCell(v.x, v.z);
    }
    for (const way of roadWays) {
      for (const c of way.coords) markCell(c.x, c.z);
    }

    const result = [];
    for (let ri = 0; ri < rows; ri++) {
      for (let ci = 0; ci < cols; ci++) {
        if (occ[ri * cols + ci]) continue;
        const cx = -half + (ci + 0.5) * cellSize;
        const cz = -half + (ri + 0.5) * cellSize;
        result.push({ x: cx, z: cz });
      }
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONSTRUCTION SITE
  // Returns a THREE.Group with barrier blocks (collidable, non-grindable)
  // and scaffolding tube runs (grindable via railBuffers on group.userData).
  // ═══════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════
  // BUFFER APPEND HELPER
  // Extracts vertex/index data from a THREE.BufferGeometry (which may
  // have a world-space transform baked via a mesh position/rotation)
  // and appends it into the flat shared buffer arrays.
  // Returns the new indexOffset.
  // ═══════════════════════════════════════════════════════════════

  _appendGeoToBuffers(geometry, matrixWorld, color, pos, nrm, col, idx, indexOffset) {
    const posAttr = geometry.attributes.position;
    const nrmAttr = geometry.attributes.normal;
    const idxArr  = geometry.index ? geometry.index.array : null;
    const vertCount = posAttr.count;

    // Apply the world matrix to each vertex
    const v3 = new THREE.Vector3();
    const n3 = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrixWorld);

    for (let i = 0; i < vertCount; i++) {
      v3.fromBufferAttribute(posAttr, i).applyMatrix4(matrixWorld);
      pos.push(v3.x, v3.y, v3.z);
      col.push(color.r, color.g, color.b);

      if (nrmAttr) {
        n3.fromBufferAttribute(nrmAttr, i).applyMatrix3(normalMatrix).normalize();
        nrm.push(n3.x, n3.y, n3.z);
      } else {
        nrm.push(0, 1, 0);
      }
    }

    if (idxArr) {
      for (let i = 0; i < idxArr.length; i++) {
        idx.push(idxArr[i] + indexOffset);
      }
    } else {
      // Non-indexed: generate sequential indices
      for (let i = 0; i < vertCount; i++) {
        idx.push(indexOffset + i);
      }
    }

    return indexOffset + vertCount;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONSTRUCTION SITE
  // Returns { pos, nrm, col, idx, railBuffers } for merging into
  // the shared buildings buffer and the merged rail mesh.
  // ═══════════════════════════════════════════════════════════════

  _buildConstructionSite(cx, cz, elev, terrainMesh, seedState) {
    let s = seedState;
    const rand = () => { s = _lcgNext(s); return s / 0xffffffff; };

    const pos = [], nrm = [], col = [], idx = [];
    let indexOffset = 0;
    const railBuffers = [];

    const concreteColor = new THREE.Color(structurePalette({}));
    const barrierColor  = new THREE.Color('#f0c030'); // yellow/orange barriers

    // ── Concrete barrier blocks ──────────────────────────────────
    const barrierCount = 2 + Math.floor(rand() * 3); // 2–4
    for (let i = 0; i < barrierCount; i++) {
      const bx  = cx + (rand() - 0.5) * 16;
      const bz  = cz + (rand() - 0.5) * 16;
      const by  = this._snapY(bx, bz, elev, terrainMesh, 0);
      const rot = rand() * Math.PI * 2;

      const geo = new THREE.BoxGeometry(2.0, 0.8, 0.4);
      geo.computeVertexNormals();
      const mat4 = new THREE.Matrix4()
        .makeRotationY(rot)
        .setPosition(bx, by + 0.4, bz);
      indexOffset = this._appendGeoToBuffers(geo, mat4, barrierColor, pos, nrm, col, idx, indexOffset);
      geo.dispose();
    }

    // ── Scaffolding tube runs (grindable) ────────────────────────
    const tubeCount = 1 + Math.floor(rand() * 3); // 1–3
    for (let i = 0; i < tubeCount; i++) {
      const tx    = cx + (rand() - 0.5) * 14;
      const tz    = cz + (rand() - 0.5) * 14;
      const tLen  = 4 + rand() * 4;         // 4–8 m
      const angle = rand() * Math.PI * 2;
      const dx    = Math.cos(angle), dz = Math.sin(angle);

      // Two heights: 0.4 m and 1.2 m
      for (const height of [0.4, 1.2]) {
        const baseY = this._snapY(tx, tz, elev, terrainMesh, height);
        const endY  = this._snapY(tx + dx * tLen, tz + dz * tLen, elev, terrainMesh, height);
        const rb = this._buildFixedYRailMesh(
          [{ x: tx, z: tz }, { x: tx + dx * tLen, z: tz + dz * tLen }],
          (baseY + endY) / 2
        );
        if (rb) railBuffers.push(rb);
      }
    }

    // ── Optional tall vertical post (non-grindable) ───────────────
    if (rand() > 0.35) {
      const px   = cx + (rand() - 0.5) * 12;
      const pz   = cz + (rand() - 0.5) * 12;
      const py   = this._snapY(px, pz, elev, terrainMesh, 0);
      const postH = 4 + rand() * 4;  // 4–8 m
      const geo = new THREE.CylinderGeometry(0.07, 0.09, postH, 6, 1);
      geo.computeVertexNormals();
      const mat4 = new THREE.Matrix4().setPosition(px, py + postH / 2, pz);
      indexOffset = this._appendGeoToBuffers(geo, mat4, concreteColor, pos, nrm, col, idx, indexOffset);
      geo.dispose();
    }

    return { pos, nrm, col, idx, railBuffers };
  }

  // ═══════════════════════════════════════════════════════════════
  // PARK FURNITURE
  // Benches (grindable ledges), low walls (grindable), bollard lines
  // (non-grindable cylinders).
  // Returns { pos, nrm, col, idx, railBuffers } for merging.
  // ═══════════════════════════════════════════════════════════════

  _buildParkFurniture(parkWay, elev, terrainMesh, seedState) {
    let s = seedState;
    const rand = () => { s = _lcgNext(s); return s / 0xffffffff; };

    const pos = [], nrm = [], col = [], idx = [];
    let indexOffset = 0;
    const railBuffers = [];

    const verts = parkWay.coords;
    if (!verts || verts.length < 3) return { pos, nrm, col, idx, railBuffers };

    // Bounding box of park
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const v of verts) {
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }

    const W = maxX - minX, D = maxZ - minZ;
    if (W < 4 || D < 4) return { pos, nrm, col, idx, railBuffers };

    const parkColor    = new THREE.Color('#8a7060');
    const bollardColor = new THREE.Color('#606870');

    // ── Helper: random point inside bounding box (reject outside polygon) ──
    const sampleInside = (maxTries = 12) => {
      for (let t = 0; t < maxTries; t++) {
        const x = minX + rand() * W;
        const z = minZ + rand() * D;
        if (this._pointInFootprint(x, z, verts)) return { x, z };
      }
      return null;
    };

    // ── Bench ledges (grindable) ─────────────────────────────────
    const benchCount = 1 + Math.floor(rand() * 4); // 1–4
    for (let i = 0; i < benchCount; i++) {
      const pt = sampleInside();
      if (!pt) continue;
      const by  = this._snapY(pt.x, pt.z, elev, terrainMesh, 0);
      const rot = rand() * Math.PI * 2;
      const geo = new THREE.BoxGeometry(1.8, 0.45, 0.4);
      geo.computeVertexNormals();
      const mat4 = new THREE.Matrix4()
        .makeRotationY(rot)
        .setPosition(pt.x, by + 0.45, pt.z);
      indexOffset = this._appendGeoToBuffers(geo, mat4, parkColor, pos, nrm, col, idx, indexOffset);
      geo.dispose();
      // Grind rail along top of bench
      const dx = Math.cos(rot), dz = -Math.sin(rot);
      const railY = by + 0.45 + 0.225;
      const rb = this._buildFixedYRailMesh(
        [{ x: pt.x - dx * 0.85, z: pt.z - dz * 0.85 },
         { x: pt.x + dx * 0.85, z: pt.z + dz * 0.85 }],
        railY
      );
      if (rb) railBuffers.push(rb);
    }

    // ── Low walls (grindable) ────────────────────────────────────
    const wallCount = 1 + Math.floor(rand() * 3); // 1–3
    for (let i = 0; i < wallCount; i++) {
      const pt = sampleInside();
      if (!pt) continue;
      const by  = this._snapY(pt.x, pt.z, elev, terrainMesh, 0);
      const rot = rand() * Math.PI * 2;
      const wLen = 3 + rand() * 3; // 3–6 m
      const geo = new THREE.BoxGeometry(wLen, 0.6, 0.3);
      geo.computeVertexNormals();
      const mat4 = new THREE.Matrix4()
        .makeRotationY(rot)
        .setPosition(pt.x, by + 0.3, pt.z);
      indexOffset = this._appendGeoToBuffers(geo, mat4, parkColor, pos, nrm, col, idx, indexOffset);
      geo.dispose();
      // Grind rail on wall top
      const dx = Math.cos(rot), dz = -Math.sin(rot);
      const railY = by + 0.6 + 0.015;
      const rb = this._buildFixedYRailMesh(
        [{ x: pt.x - dx * wLen * 0.48, z: pt.z - dz * wLen * 0.48 },
         { x: pt.x + dx * wLen * 0.48, z: pt.z + dz * wLen * 0.48 }],
        railY
      );
      if (rb) railBuffers.push(rb);
    }

    // ── Bollard lines (non-grindable) ────────────────────────────
    const bollardLines = 1 + Math.floor(rand() * 2); // 1–2 lines
    for (let li = 0; li < bollardLines; li++) {
      const pt = sampleInside();
      if (!pt) continue;
      const rot    = rand() * Math.PI * 2;
      const lineLen = 2.4 + rand() * 4.8;
      const count  = Math.max(2, Math.floor(lineLen / 1.2));
      const dx     = Math.cos(rot), dz = Math.sin(rot);
      const startX = pt.x - dx * lineLen * 0.5;
      const startZ = pt.z - dz * lineLen * 0.5;
      const bGeo   = new THREE.CylinderGeometry(0.075, 0.075, 0.9, 8, 1);
      bGeo.computeVertexNormals();
      for (let bi = 0; bi < count; bi++) {
        const t  = bi / Math.max(1, count - 1);
        const bx = startX + dx * lineLen * t;
        const bz = startZ + dz * lineLen * t;
        const by = this._snapY(bx, bz, elev, terrainMesh, 0);
        const mat4 = new THREE.Matrix4().setPosition(bx, by + 0.45, bz);
        indexOffset = this._appendGeoToBuffers(bGeo, mat4, bollardColor, pos, nrm, col, idx, indexOffset);
      }
      bGeo.dispose();
    }

    return { pos, nrm, col, idx, railBuffers };
  }

  // ═══════════════════════════════════════════════════════════════
  // SKATE PARK
  // Appends solid geometry (pad, quarter-pipes, kicker) directly into
  // the caller's pos/nrm/col/idx buffers and returns rail buffers for
  // the merged rail mesh.  Returns { newIndexOffset, railBuffers }.
  // ═══════════════════════════════════════════════════════════════

  _buildSkatepark(cx, cz, angle, elev, terrainMesh, seedState,
                  pos, nrm, col, idx, indexOffset) {
    let s = seedState;
    const rand = () => { s = _lcgNext(s); return s / 0xffffffff; };

    const railBuffers = [];
    const baseY  = this._snapY(cx, cz, elev, terrainMesh, 0);
    const concColor = new THREE.Color(structurePalette({})); // concrete grey

    // ── Local → world rotation helpers ───────────────────────────
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const rot2D = (lx, lz) => ({
      x: cx + lx * cosA - lz * sinA,
      z: cz + lx * sinA + lz * cosA,
    });
    const worldY = (lx, lz, bias = 0) => {
      const w = rot2D(lx, lz);
      return this._snapY(w.x, w.z, elev, terrainMesh, bias);
    };

    // ── Helper: push a quad into shared buffers ───────────────────
    const pushQuad = (v0, v1, v2, v3, nx, ny, nz) => {
      const base = indexOffset;
      for (const v of [v0, v1, v2, v3]) {
        pos.push(v.x, v.y, v.z);
        nrm.push(nx, ny, nz);
        col.push(concColor.r, concColor.g, concColor.b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      indexOffset += 4;
    };

    // ── Helper: convert local XZ + Y to world point ───────────────
    const wp = (lx, lz, y) => {
      const w = rot2D(lx, lz);
      return { x: w.x, y, z: w.z };
    };

    // ── Pad dimensions ────────────────────────────────────────────
    const padW = 12 + rand() * 8;   // 12–20 m wide
    const padD = 10 + rand() * 6;   // 10–16 m deep
    const hw = padW / 2, hd = padD / 2;

    // ── Flat concrete pad (single quad) ───────────────────────────
    pushQuad(
      wp(-hw, -hd, baseY), wp( hw, -hd, baseY),
      wp( hw,  hd, baseY), wp(-hw,  hd, baseY),
      0, 1, 0
    );

    // ── Quarter-pipe(s) ───────────────────────────────────────────
    // Profile: flat base → curved arc → vertical lip, extruded along width.
    // Arc uses 8 segments over PI/2 radians.
    const qpCount  = 1 + Math.floor(rand() * 2); // 1–2
    const QP_R     = 1.8;   // radius metres
    const QP_LIP   = 0.3;   // vertical lip above arc top
    const QP_W     = padW * 0.7; // extrusion width
    const ARC_SEGS = 8;
    const qpSides  = rand() > 0.5 ? 1 : -1; // which end of pad

    for (let qi = 0; qi < qpCount; qi++) {
      const qpZ = qpSides * (hd - 0.1) - (qi === 1 ? qpSides * 2 : 0);
      const faceDir = qpSides; // +1 = faces -z, -1 = faces +z

      // Build arc profile in local 2D (along X=0, XZ varies along depth)
      // Profile goes from (0,0) curving up to (QP_R, QP_R) then vertical lip
      const profilePts = [];
      for (let ai = 0; ai <= ARC_SEGS; ai++) {
        const t = ai / ARC_SEGS;
        const angle2 = t * Math.PI / 2;
        // Quarter circle: starts horizontal, ends vertical
        const localDepth = QP_R * (1 - Math.cos(angle2)) * faceDir;
        const localHeight = QP_R * Math.sin(angle2);
        profilePts.push({ d: localDepth, h: localHeight });
      }
      // Add vertical lip
      profilePts.push({ d: profilePts[profilePts.length - 1].d, h: QP_R + QP_LIP });

      // Extrude: for each consecutive profile pair, emit a quad across the width
      const extHW = QP_W / 2;
      for (let pi = 0; pi < profilePts.length - 1; pi++) {
        const p0 = profilePts[pi], p1 = profilePts[pi + 1];
        const z0 = qpZ + p0.d, z1 = qpZ + p1.d;
        const y0 = baseY + p0.h, y1 = baseY + p1.h;

        // Face normal: perpendicular to the profile segment
        const dz = z1 - z0, dy = y1 - y0;
        const nl  = Math.sqrt(dz * dz + dy * dy) || 1;
        // Inward normal (toward interior of ramp)
        const fnx = 0, fny = dz / nl * faceDir, fnz = -dy / nl * faceDir;

        const tl = wp(-extHW, z0, y0);
        const tr = wp( extHW, z0, y0);
        const br = wp( extHW, z1, y1);
        const bl = wp(-extHW, z1, y1);

        if (faceDir > 0) {
          pushQuad(tl, tr, br, bl, fnx, fny, fnz);
        } else {
          pushQuad(bl, br, tr, tl, fnx, fny, fnz);
        }
      }

      // Rail along the lip top
      const lipY   = baseY + QP_R + QP_LIP;
      const lipZ   = qpZ + profilePts[profilePts.length - 1].d;
      const lipWL  = rot2D(-extHW, lipZ);
      const lipWR  = rot2D( extHW, lipZ);
      const rb = this._buildFixedYRailMesh(
        [{ x: lipWL.x, z: lipWL.z }, { x: lipWR.x, z: lipWR.z }],
        lipY + 0.04
      );
      if (rb) railBuffers.push(rb);
    }

    // ── Kicker ramp ───────────────────────────────────────────────
    // Two angled quads meeting at a ridge. Width = padW * 0.35
    const kW  = padW * 0.35;
    const kHW = kW / 2;
    const kH  = 0.6 + rand() * 0.6;  // 0.6–1.2 m high
    const kD  = kH * 2.5;             // run depth
    const kOX = (rand() - 0.5) * (padW * 0.4); // lateral offset
    const kOZ = (rand() - 0.5) * (padD * 0.3); // depth offset

    // Ramp face quad
    {
      const rz0  = kOZ - kD * 0.5;
      const rz1  = kOZ + kD * 0.5;
      const ry0  = baseY;
      const ry1  = baseY + kH;
      const tl   = wp(kOX - kHW, rz0, ry0);
      const tr   = wp(kOX + kHW, rz0, ry0);
      const br   = wp(kOX + kHW, rz1, ry1);
      const bl   = wp(kOX - kHW, rz1, ry1);
      const dz   = rz1 - rz0, dy = ry1 - ry0;
      const nl   = Math.sqrt(dz * dz + dy * dy) || 1;
      pushQuad(tl, tr, br, bl, 0, dz / nl, -dy / nl);
    }
    // Top flat face
    {
      const tl = wp(kOX - kHW, kOZ + kD * 0.5, baseY + kH);
      const tr = wp(kOX + kHW, kOZ + kD * 0.5, baseY + kH);
      const br = wp(kOX + kHW, kOZ + kD * 0.5 + 0.3, baseY + kH);
      const bl = wp(kOX - kHW, kOZ + kD * 0.5 + 0.3, baseY + kH);
      pushQuad(tl, tr, br, bl, 0, 1, 0);
    }

    // Rail along kicker ridge
    {
      const ridgeY = baseY + kH + 0.04;
      const ridgeZ = kOZ + kD * 0.5;
      const rL = rot2D(kOX - kHW, ridgeZ);
      const rR = rot2D(kOX + kHW, ridgeZ);
      const rb = this._buildFixedYRailMesh(
        [{ x: rL.x, z: rL.z }, { x: rR.x, z: rR.z }],
        ridgeY
      );
      if (rb) railBuffers.push(rb);
    }

    // ── Pad-edge rails ────────────────────────────────────────────
    const railCount = 2 + Math.floor(rand() * 3); // 2–4
    for (let ri = 0; ri < railCount; ri++) {
      const rOX   = (rand() - 0.5) * padW * 0.8;
      const rOZ   = (rand() - 0.5) * padD * 0.6;
      const rLen  = 3 + rand() * 5;
      const rAng  = rand() * Math.PI;
      const rdx   = Math.cos(rAng), rdz = Math.sin(rAng);
      const rY    = baseY + 0.5 + rand() * 0.4;

      const a = rot2D(rOX - rdx * rLen * 0.5, rOZ - rdz * rLen * 0.5);
      const b = rot2D(rOX + rdx * rLen * 0.5, rOZ + rdz * rLen * 0.5);
      const rb = this._buildFixedYRailMesh(
        [{ x: a.x, z: a.z }, { x: b.x, z: b.z }],
        rY
      );
      if (rb) railBuffers.push(rb);
    }

    return { newIndexOffset: indexOffset, railBuffers };
  }

  _triCount(mesh) {
    return mesh.geometry?.index ? mesh.geometry.index.count / 3 : 0;
  }
}