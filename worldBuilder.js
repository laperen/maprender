// js/worldBuilder.js — Converts parsed OSM ways into Three.js meshes
import * as THREE from 'three';
import { earcut } from './earcut.js';
import {
  makeToonGradient,
  makeBuildingWallTexture,
  makeBuildingRoofTexture,
  makeRoadTexture,
  makeWaterTexture,
  makeParkTexture,
  fetchSatelliteTexture,
  buildingPalette,
} from './textureFactory.js';

export class WorldBuilder {
  constructor(sceneManager) {
    this.scene = sceneManager;

    // Shared toon gradient — one instance reused by all toon materials
    this._toonGradient = makeToonGradient();

    // Shared surface textures
    this._roadTex  = makeRoadTexture();
    this._waterTex = makeWaterTexture();
    this._parkTex  = makeParkTexture();

    // Per-type texture caches so we don't regenerate the same canvas repeatedly
    this._wallTexCache = new Map();
    this._roofTexCache = new Map();
  }

  // ── Main build entry point ────────────────────────────────────
  /**
   * @param {Array}  ways
   * @param {number} heightScale
   * @param {number} lat          — centre latitude  (for satellite tile)
   * @param {number} lng          — centre longitude (for satellite tile)
   * @param {number} radiusMeters — determines satellite zoom level
   */
  async build(ways, heightScale = 1, lat = 0, lng = 0, radiusMeters = 500) {
    let buildings = 0, roads = 0, water = 0, parks = 0, tris = 0;
    const buildingGroup = new THREE.Group();
    buildingGroup.name  = 'buildings';

    for (const way of ways) {
      try {
        if (way.kind === 'building' && way.closed) {
          const mesh = this._buildingMesh(way, heightScale);
          if (mesh) { buildingGroup.add(mesh); buildings++; tris += this._triCount(mesh); }
        } else if (way.kind === 'road') {
          const mesh = this._roadMesh(way);
          if (mesh) { this.scene.addObject(mesh); roads++; tris += this._triCount(mesh); }
        } else if (way.kind === 'water' && way.closed) {
          const mesh = this._flatPolygon(way, 'water', 0.3);
          if (mesh) { this.scene.addObject(mesh); water++; tris += this._triCount(mesh); }
        } else if (way.kind === 'park' && way.closed) {
          const mesh = this._flatPolygon(way, 'park', 0.5);
          if (mesh) { this.scene.addObject(mesh); parks++; tris += this._triCount(mesh); }
        }
      } catch (_) { /* skip bad geometry silently */ }
    }

    this.scene.addObject(buildingGroup, true);

    // Satellite ground texture loads asynchronously — swaps in when ready
    fetchSatelliteTexture(lat, lng, radiusMeters)
      .then(tex => this.scene.setGroundTexture(tex, radiusMeters))
      .catch(() => { /* satellite unavailable — plain ground remains */ });

    return { buildings, roads, water, parks, triangleCount: tris };
  }

  // ── Polygon winding helpers ───────────────────────────────────
  _signedArea(verts) {
    let area = 0;
    const n  = verts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += verts[i].x * verts[j].z;
      area -= verts[j].x * verts[i].z;
    }
    return area / 2;
  }

  _ensureCCW(verts) {
    return this._signedArea(verts) < 0 ? verts.slice().reverse() : verts;
  }

  // ── Texture helpers ───────────────────────────────────────────
  _wallTex(tags) {
    const key = tags.building || 'yes';
    if (!this._wallTexCache.has(key)) {
      const pal = buildingPalette(tags);
      this._wallTexCache.set(key, makeBuildingWallTexture({
        wallColor:   pal.wallColor,
        frameColor:  pal.frameColor,
        windowColor: pal.windowColor,
      }));
    }
    return this._wallTexCache.get(key);
  }

  _roofTex(tags) {
    const key = tags.building || 'yes';
    if (!this._roofTexCache.has(key)) {
      const pal = buildingPalette(tags);
      this._roofTexCache.set(key, makeBuildingRoofTexture(pal.roofColor));
    }
    return this._roofTexCache.get(key);
  }

  _toonMat(color, map = null, options = {}) {
    return new THREE.MeshToonMaterial({
      color,
      gradientMap: this._toonGradient,
      map,
      ...options,
    });
  }

  // ── Building extrusion ────────────────────────────────────────
  // Two material groups: [0] walls, [1] roof.
  // Wall UVs tile the window texture at real-world scale (~6m × ~9m per tile).
  // Roof UVs project the footprint bounding box onto the roof texture.
  _buildingMesh(way, heightScale) {
    const coords = way.coords;
    if (coords.length < 3) return null;

    const h     = way.height * heightScale;
    const verts = this._ensureCCW(coords.slice(0, -1));
    if (verts.length < 3) return null;

    const flat    = verts.flatMap(c => [c.x, c.z]);
    const indices = earcut(flat);
    if (!indices || !indices.length) return null;

    const n      = verts.length;
    const pos    = [];
    const nrm    = [];
    const uvs    = [];
    const idxArr = [];

    // ── Walls ────────────────────────────────────────────────────
    const wallTexW = 6;  // metres per texture tile horizontally
    const wallTexH = 9;  // metres per texture tile vertically

    for (let i = 0; i < n; i++) {
      const j    = (i + 1) % n;
      const ax   = verts[i].x, az = verts[i].z;
      const bx   = verts[j].x, bz = verts[j].z;
      const base = pos.length / 3;

      const dx      = bx - ax, dz = bz - az;
      const wallLen = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx      =  dz / wallLen;
      const nz      = -dx / wallLen;

      pos.push(
        ax, 0, az,
        bx, 0, bz,
        bx, h, bz,
        ax, h, az,
      );
      for (let k = 0; k < 4; k++) nrm.push(nx, 0, nz);

      const uEnd = wallLen / wallTexW;
      const vTop = h       / wallTexH;
      uvs.push(
        0,    0,
        uEnd, 0,
        uEnd, vTop,
        0,    vTop,
      );

      idxArr.push(
        base,     base + 2, base + 1,
        base,     base + 3, base + 2,
      );
    }

    const wallIdxCount = idxArr.length;

    // ── Roof ─────────────────────────────────────────────────────
    const topBase  = pos.length / 3;
    const xs       = verts.map(v => v.x);
    const zs       = verts.map(v => v.z);
    const minX     = Math.min(...xs);
    const minZ     = Math.min(...zs);
    const roofScale = 8; // metres per roof texture tile

    for (const v of verts) {
      pos.push(v.x, h, v.z);
      nrm.push(0, 1, 0);
      uvs.push((v.x - minX) / roofScale, (v.z - minZ) / roofScale);
    }

    for (let k = 0; k < indices.length; k += 3) {
      idxArr.push(
        topBase + indices[k],
        topBase + indices[k + 2],
        topBase + indices[k + 1],
      );
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('normal',   new THREE.Float32BufferAttribute(nrm, 3));
    geom.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(idxArr);
    geom.addGroup(0,             wallIdxCount,                0); // walls
    geom.addGroup(wallIdxCount,  idxArr.length - wallIdxCount, 1); // roof

    const pal     = buildingPalette(way.tags);
    const wallMat = this._toonMat(new THREE.Color(pal.wallColor), this._wallTex(way.tags));
    const roofMat = this._toonMat(new THREE.Color(pal.roofColor), this._roofTex(way.tags));

    // Slight per-building colour variation
    const hue = (way.id % 40) / 40;
    wallMat.color.offsetHSL(hue * 0.05 - 0.025, 0, hue * 0.04 - 0.02);

    const mesh = new THREE.Mesh(geom, [wallMat, roofMat]);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.userData      = { kind: 'building', tags: way.tags, height: h };
    return mesh;
  }

  // ── Road ribbon ───────────────────────────────────────────────
  _roadMesh(way) {
    const coords = way.coords;
    if (coords.length < 2) return null;

    const hw    = this._roadHalfWidth(way.tags.highway);
    const pos   = [];
    const uvs   = [];
    const idx   = [];
    let   vDist = 0;

    for (let i = 0; i < coords.length; i++) {
      const prev = coords[i - 1] || coords[i];
      const next = coords[i + 1] || coords[i];
      const dx   = next.x - prev.x;
      const dz   = next.z - prev.z;
      const len  = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx   = -dz / len, nz = dx / len;

      if (i > 0) {
        const cx = coords[i].x - coords[i - 1].x;
        const cz = coords[i].z - coords[i - 1].z;
        vDist += Math.sqrt(cx * cx + cz * cz) / (hw * 2);
      }

      pos.push(
        coords[i].x + nx * hw, 0.1, coords[i].z + nz * hw,
        coords[i].x - nx * hw, 0.1, coords[i].z - nz * hw,
      );
      uvs.push(0, vDist,  1, vDist);

      if (i > 0) {
        const b = (i - 1) * 2;
        idx.push(b, b + 2, b + 1,   b + 1, b + 2, b + 3);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(idx);
    geom.computeVertexNormals();

    const mesh = new THREE.Mesh(geom, this._toonMat(0x181a20, this._roadTex));
    mesh.receiveShadow = true;
    mesh.userData      = { kind: 'road', tags: way.tags };
    return mesh;
  }

  // ── Flat polygon (water / park) ───────────────────────────────
  _flatPolygon(way, type, yOffset = 0) {
    const verts = this._ensureCCW(way.coords.slice(0, -1));
    if (verts.length < 3) return null;

    const flat    = verts.flatMap(v => [v.x, v.z]);
    const indices = earcut(flat);
    if (!indices.length) return null;

    const texScale = 20;
    const pos      = [];
    const uvs      = [];

    for (const v of verts) {
      pos.push(v.x, yOffset, v.z);
      uvs.push(v.x / texScale, v.z / texScale);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));

    const flipped = [];
    for (let i = 0; i < indices.length; i += 3) {
      flipped.push(indices[i], indices[i + 2], indices[i + 1]);
    }
    geom.setIndex(flipped);
    geom.computeVertexNormals();

    let mat;
    if (type === 'water') {
      mat = this._toonMat(0x0a3060, this._waterTex, {
        transparent: true,
        opacity:     0.88,
      });
    } else {
      mat = this._toonMat(0x1a3320, this._parkTex);
    }

    const mesh = new THREE.Mesh(geom, mat);
    if (type === 'water') mesh.userData.isWater = true;
    return mesh;
  }

  // ── Road width by OSM highway tag ────────────────────────────
  _roadHalfWidth(highway) {
    const w = {
      motorway: 8, trunk: 6, primary: 5, secondary: 4,
      tertiary: 3, residential: 2.5, service: 1.5,
      footway: 1, path: 0.8, cycleway: 1.2,
    };
    return w[highway] ?? 2;
  }

  _triCount(mesh) {
    if (!mesh.geometry || !mesh.geometry.index) return 0;
    return mesh.geometry.index.count / 3;
  }
}
