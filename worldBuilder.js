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

// Reduced from 20 to 5 so small structural elements like tower
// corner buttresses are not incorrectly culled.
const MIN_BUILDING_AREA = 5; // m²

export class WorldBuilder {
  constructor(sceneManager) {
    this.scene         = sceneManager;
    this._toonGradient = makeToonGradient();
  }

  async build(ways, heightScale = 1, lat = 0, lng = 0, radiusMeters = 500) {
    let buildings = 0, roads = 0, water = 0, parks = 0, tris = 0;

    // ── Elevation grid ────────────────────────────────────────
    const gridSize = 64;
    let elevGrid   = null;
    try {
      elevGrid = await fetchElevationGrid(lat, lng, radiusMeters, gridSize);
    } catch (_) { /* flat fallback */ }

    // ── Canonical bilinear elevation sampler ──────────────────
    // Convention:
    //   col 0          → x = -radiusMeters (west)
    //   col gridSize-1 → x = +radiusMeters (east)
    //   row 0          → z = -radiusMeters (north)
    //   row gridSize-1 → z = +radiusMeters (south)
    const rawElev = (x, z) => {
      if (!elevGrid) return 0;
      const halfR = radiusMeters;
      const fc = (x + halfR) / (halfR * 2) * (gridSize - 1);
      const fr = (z + halfR) / (halfR * 2) * (gridSize - 1);
      const c0 = Math.max(0, Math.min(gridSize - 2, Math.floor(fc)));
      const r0 = Math.max(0, Math.min(gridSize - 2, Math.floor(fr)));
      const c1 = c0 + 1, r1 = r0 + 1;
      const tc = fc - c0, tr = fr - r0;
      const v00 = elevGrid[r0 * gridSize + c0];
      const v10 = elevGrid[r0 * gridSize + c1];
      const v01 = elevGrid[r1 * gridSize + c0];
      const v11 = elevGrid[r1 * gridSize + c1];
      return v00*(1-tc)*(1-tr) + v10*tc*(1-tr) + v01*(1-tc)*tr + v11*tc*tr;
    };

    const centreElev = rawElev(0, 0);
    const elev       = (x, z) => rawElev(x, z) - centreElev;

    // ── Build displaced ground mesh ───────────────────────────
    this.scene.buildElevationGround(elev, gridSize, radiusMeters);

    // ── Collect geometry ──────────────────────────────────────
    const roadPos = [], roadIdx = [], roadNrm = []; let roadBase = 0;
    const watPos  = [], watIdx  = [], watNrm  = []; let watBase  = 0;
    const parkPos = [], parkIdx = [], parkNrm = []; let parkBase = 0;

    const buildingGroup = new THREE.Group();
    buildingGroup.name  = 'buildings';

    for (const way of ways) {
      try {
        if (way.kind === 'building' && way.closed) {
          const mesh = this._buildingMesh(way, heightScale, elev);
          if (mesh) { buildingGroup.add(mesh); buildings++; }

        } else if (way.kind === 'road') {
          const r = this._roadGeom(way, elev);
          if (r) {
            r.pos.forEach(v => roadPos.push(v));
            r.nrm.forEach(v => roadNrm.push(v));
            r.idx.forEach(i => roadIdx.push(roadBase + i));
            roadBase += r.pos.length / 3;
            roads++;
          }

        } else if (way.kind === 'water' && way.closed) {
          const r = this._conformPolyGeom(way, elev, 0.4);
          if (r) {
            r.pos.forEach(v => watPos.push(v));
            r.nrm.forEach(v => watNrm.push(v));
            r.idx.forEach(i => watIdx.push(watBase + i));
            watBase += r.pos.length / 3;
            water++;
          }

        } else if (way.kind === 'park' && way.closed) {
          const r = this._conformPolyGeom(way, elev, 0.2);
          if (r) {
            r.pos.forEach(v => parkPos.push(v));
            r.nrm.forEach(v => parkNrm.push(v));
            r.idx.forEach(i => parkIdx.push(parkBase + i));
            parkBase += r.pos.length / 3;
            parks++;
          }
        }
      } catch (_) { /* skip bad geometry */ }
    }

    this.scene.addObject(buildingGroup, true);
    tris += buildingGroup.children.reduce((s, m) => s + this._triCount(m), 0);

    if (roadIdx.length) {
      const mesh = new THREE.Mesh(
        this._mergedGeom(roadPos, roadIdx, roadNrm),
        new THREE.MeshLambertMaterial({ color: 0x505058 })
      );
      mesh.receiveShadow = true;
      mesh.userData      = { kind: 'road' };
      this.scene.addObject(mesh);
      tris += roadIdx.length / 3;
    }

    if (watIdx.length) {
      const mesh = new THREE.Mesh(
        this._mergedGeom(watPos, watIdx, watNrm),
        new THREE.MeshLambertMaterial({ color: 0x2878b0, transparent: true, opacity: 0.85 })
      );
      mesh.userData = { kind: 'water', isWater: true };
      this.scene.addObject(mesh);
      tris += watIdx.length / 3;
    }

    if (parkIdx.length) {
      const mesh = new THREE.Mesh(
        this._mergedGeom(parkPos, parkIdx, parkNrm),
        new THREE.MeshLambertMaterial({ color: 0x4a7a40 })
      );
      mesh.receiveShadow = true;
      mesh.userData      = { kind: 'park' };
      this.scene.addObject(mesh);
      tris += parkIdx.length / 3;
    }

    fetchSatelliteTexture(lat, lng, radiusMeters)
      .then(tex => this.scene.setGroundTexture(tex))
      .catch(() => {});

    return { buildings, roads, water, parks, triangleCount: Math.round(tris) };
  }

  // ── Merged BufferGeometry ─────────────────────────────────────
  _mergedGeom(positions, indices, normals) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
    geom.setIndex(indices);
    return geom;
  }

  // ── Winding helpers ───────────────────────────────────────────
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

  // ── Building mesh ─────────────────────────────────────────────
  // Base Y = MINIMUM elevation across all footprint vertices.
  // This grounds the building at its lowest corner so it never
  // floats above the terrain surface, even on a slope.
  // Walls extend downward from this baseY into the terrain where
  // the terrain is higher than the minimum — intentional clipping
  // is invisible from any normal viewing angle.
  _buildingMesh(way, heightScale, elev) {
    const coords = way.coords;
    if (coords.length < 3) return null;

    const verts = this._ensureCCW(coords.slice(0, -1));
    if (verts.length < 3) return null;
    if (Math.abs(this._signedArea(verts)) < MIN_BUILDING_AREA) return null;

    const flat    = verts.flatMap(c => [c.x, c.z]);
    const indices = earcut(flat);
    if (!indices?.length) return null;

    // Use minimum elevation so the building is always grounded
    const vertElevs = verts.map(v => elev(v.x, v.z));
    const baseY     = Math.min(...vertElevs);
    const h         = way.height * heightScale;
    const topY      = baseY + h;
    const n         = verts.length;
    const pos       = [], nrm = [], idxArr = [];

    // Walls — bottom vertices sit at baseY (terrain minimum)
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
    geom.addGroup(0,         wallCount,                0);
    geom.addGroup(wallCount, idxArr.length - wallCount, 1);

    const mesh = new THREE.Mesh(geom, [
      new THREE.MeshToonMaterial({ color: new THREE.Color(buildingPalette(way.tags)), gradientMap: this._toonGradient }),
      new THREE.MeshToonMaterial({ color: new THREE.Color(roofColour(way.tags)),      gradientMap: this._toonGradient }),
    ]);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.userData      = { kind: 'building', tags: way.tags, height: h };
    return mesh;
  }

  // ── Road geometry ─────────────────────────────────────────────
  _roadGeom(way, elev) {
    const coords = way.coords;
    if (coords.length < 2) return null;

    const hw   = this._roadHalfWidth(way.tags.highway);
    const rawY = coords.map(c => elev(c.x, c.z));

    // 3-point moving average to smooth spike artefacts from DEM noise
    const smoothY = rawY.map((y, i) => {
      const a = rawY[Math.max(0, i - 1)];
      const b = y;
      const c = rawY[Math.min(rawY.length - 1, i + 1)];
      return (a + b + c) / 3;
    });

    const pos = [], idx = [];
    for (let i = 0; i < coords.length; i++) {
      const prev = coords[i - 1] || coords[i];
      const next = coords[i + 1] || coords[i];
      const dx   = next.x - prev.x, dz = next.z - prev.z;
      const len  = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx   = -dz / len, nz = dx / len;
      const y    = smoothY[i] + 0.15;
      pos.push(
        coords[i].x + nx * hw, y, coords[i].z + nz * hw,
        coords[i].x - nx * hw, y, coords[i].z - nz * hw,
      );
      if (i > 0) {
        const b = (i - 1) * 2;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setIndex(idx);
    geom.computeVertexNormals();
    return { pos, idx, nrm: Array.from(geom.attributes.normal.array) };
  }

  // ── Terrain-conforming polygon (water / park) ─────────────────
  // Each vertex gets its own terrain Y value rather than a shared
  // average. This makes the polygon follow the terrain surface so
  // it never clips through, at the cost of being non-flat on slopes.
  // A small yBias keeps the surface visually above the ground.
  _conformPolyGeom(way, elev, yBias = 0.2) {
    const verts = this._ensureCCW(way.coords.slice(0, -1));
    if (verts.length < 3) return null;

    const flat    = verts.flatMap(v => [v.x, v.z]);
    const indices = earcut(flat);
    if (!indices.length) return null;

    // Per-vertex terrain elevation
    const pos = verts.flatMap(v => [v.x, elev(v.x, v.z) + yBias, v.z]);

    const flipped = [];
    for (let i = 0; i < indices.length; i += 3) {
      flipped.push(indices[i], indices[i + 2], indices[i + 1]);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setIndex(flipped);
    geom.computeVertexNormals();
    return { pos, idx: flipped, nrm: Array.from(geom.attributes.normal.array) };
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
    return mesh.geometry?.index ? mesh.geometry.index.count / 3 : 0;
  }
}
