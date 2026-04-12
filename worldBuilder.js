// js/worldBuilder.js — Converts parsed OSM ways into Three.js meshes
import * as THREE from 'three';
import { earcut } from './earcut.js';
import {
  makeToonGradient,
  fetchSatelliteTexture,
  fetchElevationGrid,
  buildingPalette,
  roofColour,
} from './textureFactory.js';

// Minimum footprint area (m²) — buildings smaller than this are skipped.
// Avoids wasting draw calls on tiny sheds and map artefacts.
const MIN_BUILDING_AREA = 20;

export class WorldBuilder {
  constructor(sceneManager) {
    this.scene         = sceneManager;
    this._toonGradient = makeToonGradient();
  }

  // ── Main build entry point ────────────────────────────────────
  async build(ways, heightScale = 1, lat = 0, lng = 0, radiusMeters = 500) {
    let buildings = 0, roads = 0, water = 0, parks = 0, tris = 0;

    // ── Fetch elevation grid ──────────────────────────────────
    // 64×64 samples across the area — enough for visible terrain shape.
    let elevGrid   = null;
    let gridSize   = 64;
    try {
      elevGrid = await fetchElevationGrid(lat, lng, radiusMeters, gridSize);
    } catch (_) {
      // Elevation unavailable — flat terrain fallback
    }

    // Helper: sample elevation at a world-space (x, z) coordinate.
    // x and z are in metres relative to the centre.
    const getElev = (x, z) => {
      if (!elevGrid) return 0;
      const halfR = radiusMeters;
      // Map x ∈ [-halfR, halfR] → col ∈ [0, gridSize-1]
      const col = Math.round((x + halfR) / (halfR * 2) * (gridSize - 1));
      const row = Math.round((-z + halfR) / (halfR * 2) * (gridSize - 1));
      const c   = Math.max(0, Math.min(gridSize - 1, col));
      const r   = Math.max(0, Math.min(gridSize - 1, row));
      return elevGrid[r * gridSize + c];
    };

    // Find the centre elevation so all heights are relative to it
    // (avoids the whole scene floating high above y=0).
    const centreElev = getElev(0, 0);
    const elev       = (x, z) => getElev(x, z) - centreElev;

    // ── Build displaced ground mesh ───────────────────────────
    this.scene.buildElevationGround(elevGrid, gridSize, radiusMeters, centreElev);

    // ── Collect geometry by type for merging ──────────────────
    const roadPositions = [], roadIndices  = [], roadNormals = [];
    const waterPositions = [], waterIndices = [], waterNormals = [];
    const parkPositions  = [], parkIndices  = [], parkNormals  = [];
    let roadBase = 0, waterBase = 0, parkBase = 0;

    const buildingGroup = new THREE.Group();
    buildingGroup.name  = 'buildings';

    for (const way of ways) {
      try {
        if (way.kind === 'building' && way.closed) {
          const mesh = this._buildingMesh(way, heightScale, elev);
          if (mesh) { buildingGroup.add(mesh); buildings++; tris += this._triCount(mesh); }

        } else if (way.kind === 'road') {
          const result = this._roadGeom(way, elev);
          if (result) {
            const { pos, idx, nrm } = result;
            const base = roadBase;
            for (const v of pos) roadPositions.push(v);
            for (const n of nrm) roadNormals.push(n);
            for (const i of idx) roadIndices.push(base + i);
            roadBase += pos.length / 3;
            roads++;
          }

        } else if (way.kind === 'water' && way.closed) {
          const result = this._flatPolyGeom(way, elev, 0.3);
          if (result) {
            const { pos, idx, nrm } = result;
            const base = waterBase;
            for (const v of pos) waterPositions.push(v);
            for (const n of nrm) waterNormals.push(n);
            for (const i of idx) waterIndices.push(base + i);
            waterBase += pos.length / 3;
            water++;
          }

        } else if (way.kind === 'park' && way.closed) {
          const result = this._flatPolyGeom(way, elev, 0.5);
          if (result) {
            const { pos, idx, nrm } = result;
            const base = parkBase;
            for (const v of pos) parkPositions.push(v);
            for (const n of nrm) parkNormals.push(n);
            for (const i of idx) parkIndices.push(base + i);
            parkBase += pos.length / 3;
            parks++;
          }
        }
      } catch (_) { /* skip bad geometry */ }
    }

    // ── Add buildings ─────────────────────────────────────────
    this.scene.addObject(buildingGroup, true);
    tris += Math.round(buildingGroup.children.reduce((s, m) => s + this._triCount(m), 0));

    // ── Merge and add roads ───────────────────────────────────
    if (roadIndices.length) {
      const geom = this._mergedGeom(roadPositions, roadIndices, roadNormals);
      const mat  = new THREE.MeshLambertMaterial({ color: 0x505058 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.receiveShadow = true;
      mesh.userData      = { kind: 'road' };
      this.scene.addObject(mesh);
      tris += roadIndices.length / 3;
    }

    // ── Merge and add water ───────────────────────────────────
    if (waterIndices.length) {
      const geom = this._mergedGeom(waterPositions, waterIndices, waterNormals);
      const mat  = new THREE.MeshLambertMaterial({
        color: 0x2878b0, transparent: true, opacity: 0.85,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData = { kind: 'water', isWater: true };
      this.scene.addObject(mesh);
      tris += waterIndices.length / 3;
    }

    // ── Merge and add parks ───────────────────────────────────
    if (parkIndices.length) {
      const geom = this._mergedGeom(parkPositions, parkIndices, parkNormals);
      const mat  = new THREE.MeshLambertMaterial({ color: 0x4a7a40 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.receiveShadow = true;
      mesh.userData      = { kind: 'park' };
      this.scene.addObject(mesh);
      tris += parkIndices.length / 3;
    }

    // ── Satellite ground texture (async, non-blocking) ────────
    fetchSatelliteTexture(lat, lng, radiusMeters)
      .then(tex => this.scene.setGroundTexture(tex, radiusMeters))
      .catch(() => {});

    return { buildings, roads, water, parks, triangleCount: Math.round(tris) };
  }

  // ── Merge arrays into a single BufferGeometry ─────────────────
  _mergedGeom(positions, indices, normals) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (normals.length) {
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    } else {
      geom.computeVertexNormals();
    }
    geom.setIndex(indices);
    return geom;
  }

  // ── Polygon winding ───────────────────────────────────────────
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

  // ── Building mesh — flat toon colour, two groups ──────────────
  _buildingMesh(way, heightScale, elev) {
    const coords = way.coords;
    if (coords.length < 3) return null;

    const verts = this._ensureCCW(coords.slice(0, -1));
    if (verts.length < 3) return null;

    // Polygon area budget check
    const area = Math.abs(this._signedArea(verts));
    if (area < MIN_BUILDING_AREA) return null;

    const flat    = verts.flatMap(c => [c.x, c.z]);
    const indices = earcut(flat);
    if (!indices || !indices.length) return null;

    // Base elevation: average of footprint vertices
    const baseY = verts.reduce((s, v) => s + elev(v.x, v.z), 0) / verts.length;
    const h     = way.height * heightScale;
    const topY  = baseY + h;

    const n      = verts.length;
    const pos    = [], nrm = [], idxArr = [];

    // ── Walls ─────────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const j    = (i + 1) % n;
      const ax   = verts[i].x, az = verts[i].z;
      const bx   = verts[j].x, bz = verts[j].z;
      const base = pos.length / 3;
      const dx   = bx - ax, dz = bz - az;
      const len  = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx   =  dz / len, nz = -dx / len;

      pos.push(ax, baseY, az,  bx, baseY, bz,  bx, topY, bz,  ax, topY, az);
      for (let k = 0; k < 4; k++) nrm.push(nx, 0, nz);
      idxArr.push(base, base + 2, base + 1,  base, base + 3, base + 2);
    }

    const wallCount = idxArr.length;

    // ── Roof ──────────────────────────────────────────────────
    const topBase = pos.length / 3;
    for (const v of verts) pos.push(v.x, topY, v.z);
    for (let k = 0; k < n; k++) nrm.push(0, 1, 0);
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
    geom.setIndex(idxArr);
    geom.addGroup(0,          wallCount,                0);
    geom.addGroup(wallCount,  idxArr.length - wallCount, 1);

    const wallCol  = new THREE.Color(buildingPalette(way.tags));
    const roofCol  = new THREE.Color(roofColour(way.tags));
    const wallMat  = new THREE.MeshToonMaterial({ color: wallCol, gradientMap: this._toonGradient });
    const roofMat  = new THREE.MeshToonMaterial({ color: roofCol, gradientMap: this._toonGradient });

    const mesh = new THREE.Mesh(geom, [wallMat, roofMat]);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.userData      = { kind: 'building', tags: way.tags, height: h };
    return mesh;
  }

  // ── Road geometry (returned as arrays for merging) ────────────
  _roadGeom(way, elev) {
    const coords = way.coords;
    if (coords.length < 2) return null;

    const hw  = this._roadHalfWidth(way.tags.highway);
    const pos = [], idx = [];

    for (let i = 0; i < coords.length; i++) {
      const prev = coords[i - 1] || coords[i];
      const next = coords[i + 1] || coords[i];
      const dx   = next.x - prev.x, dz = next.z - prev.z;
      const len  = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx   = -dz / len, nz = dx / len;
      const y    = elev(coords[i].x, coords[i].z) + 0.15;

      pos.push(
        coords[i].x + nx * hw, y, coords[i].z + nz * hw,
        coords[i].x - nx * hw, y, coords[i].z - nz * hw,
      );

      if (i > 0) {
        const b = (i - 1) * 2;
        idx.push(b, b + 2, b + 1,  b + 1, b + 2, b + 3);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setIndex(idx);
    geom.computeVertexNormals();
    const nrm = Array.from(geom.attributes.normal.array);
    return { pos, idx, nrm };
  }

  // ── Flat polygon geometry (water / park) ──────────────────────
  _flatPolyGeom(way, elev, yBias = 0) {
    const verts = this._ensureCCW(way.coords.slice(0, -1));
    if (verts.length < 3) return null;

    const flat    = verts.flatMap(v => [v.x, v.z]);
    const indices = earcut(flat);
    if (!indices.length) return null;

    const pos = [];
    for (const v of verts) {
      pos.push(v.x, elev(v.x, v.z) + yBias, v.z);
    }

    const flipped = [];
    for (let i = 0; i < indices.length; i += 3) {
      flipped.push(indices[i], indices[i + 2], indices[i + 1]);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setIndex(flipped);
    geom.computeVertexNormals();
    const nrm = Array.from(geom.attributes.normal.array);
    return { pos, idx: flipped, nrm };
  }

  _roadHalfWidth(highway) {
    const w = {
      motorway: 8, trunk: 6, primary: 5, secondary: 4,
      tertiary: 3, residential: 2.5, service: 1.5,
      footway: 1, path: 0.8, cycleway: 1.2,
    };
    return w[highway] ?? 2;
  }

  _triCount(mesh) {
    if (!mesh.geometry?.index) return 0;
    return mesh.geometry.index.count / 3;
  }
}
