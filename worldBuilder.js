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

const MIN_BUILDING_AREA = 5; // m²

export class WorldBuilder {
  constructor(sceneManager) {
    this.scene         = sceneManager;
    this._toonGradient = makeToonGradient();
  }

  async build(ways, heightScale = 1, lat = 0, lng = 0, radiusMeters = 500) {
    let buildings = 0, roads = 0, water = 0, parks = 0, tris = 0;

    // ── Fetch elevation grid ──────────────────────────────────
    const gridSize = 64;
    let elevGrid   = null;
    try {
      elevGrid = await fetchElevationGrid(lat, lng, radiusMeters, gridSize);
    } catch (_) { /* flat fallback */ }

    // ── Bilinear elevation sampler ────────────────────────────
    // Convention: col 0 = west (-r), col N-1 = east (+r)
    //             row 0 = north (-r in Z), row N-1 = south (+r in Z)
    const rawElev = (x, z) => {
      if (!elevGrid) return 0;
      const halfR = radiusMeters;
      const fc = (x + halfR) / (halfR * 2) * (gridSize - 1);
      const fr = (z + halfR) / (halfR * 2) * (gridSize - 1);
      const c0 = Math.max(0, Math.min(gridSize - 2, Math.floor(fc)));
      const r0 = Math.max(0, Math.min(gridSize - 2, Math.floor(fr)));
      const c1 = c0 + 1, r1 = r0 + 1;
      const tc = fc - c0, tr = fr - r0;
      return elevGrid[r0*gridSize+c0]*(1-tc)*(1-tr)
           + elevGrid[r0*gridSize+c1]*   tc *(1-tr)
           + elevGrid[r1*gridSize+c0]*(1-tc)*   tr
           + elevGrid[r1*gridSize+c1]*   tc *   tr;
    };

    const centreElev = rawElev(0, 0);
    const elev       = (x, z) => rawElev(x, z) - centreElev;

    // ── Collect building footprints for terrain flattening ────
    // We store each building's footprint verts and its resolved
    // baseY so we can flatten the ground mesh beneath it.
    const buildingFootprints = []; // { verts, baseY }

    // ── Collect geometry ──────────────────────────────────────
    const roadPos = [], roadIdx = [], roadNrm = []; let roadBase = 0;
    const watPos  = [], watIdx  = [], watNrm  = []; let watBase  = 0;
    const parkPos = [], parkIdx = [], parkNrm = []; let parkBase = 0;

    const buildingGroup = new THREE.Group();
    buildingGroup.name  = 'buildings';

    for (const way of ways) {
      try {
        if (way.kind === 'building' && way.closed) {
          const result = this._buildingMesh(way, heightScale, elev);
          if (result) {
            buildingGroup.add(result.mesh);
            buildingFootprints.push({ verts: result.verts, baseY: result.baseY });
            buildings++;
          }

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

    // ── Build terrain ground, flattened under buildings ───────
    this.scene.buildElevationGround(elev, gridSize, radiusMeters, buildingFootprints);

    this.scene.addObject(buildingGroup, true);
    tris += buildingGroup.children.reduce((s, m) => s + this._triCount(m), 0);

    if (roadIdx.length) {
      const mesh = new THREE.Mesh(
        this._mergedGeom(roadPos, roadIdx, roadNrm),
        new THREE.MeshLambertMaterial({ color: 0x505058 })
      );
      mesh.receiveShadow = true;
      mesh.userData = { kind: 'road' };
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
      mesh.userData = { kind: 'park' };
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

  // ── Point-in-polygon test (ray casting) ──────────────────────
  _pointInPoly(px, pz, verts) {
    let inside = false;
    const n = verts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = verts[i].x, zi = verts[i].z;
      const xj = verts[j].x, zj = verts[j].z;
      if (((zi > pz) !== (zj > pz)) &&
          (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // ── Building mesh ─────────────────────────────────────────────
  // Returns { mesh, verts, baseY } so the caller can pass footprints
  // to the ground builder for terrain flattening.
  _buildingMesh(way, heightScale, elev) {
    const coords = way.coords;
    if (coords.length < 3) return null;

    const verts = this._ensureCCW(coords.slice(0, -1));
    if (verts.length < 3) return null;
    if (Math.abs(this._signedArea(verts)) < MIN_BUILDING_AREA) return null;

    const flat    = verts.flatMap(c => [c.x, c.z]);
    const indices = earcut(flat);
    if (!indices?.length) return null;

    // Use minimum footprint elevation so building never floats
    const baseY = Math.min(...verts.map(v => elev(v.x, v.z)));
    const h     = way.height * heightScale;
    const topY  = baseY + h;
    const n     = verts.length;
    const pos   = [], nrm = [], idxArr = [];

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

    return { mesh, verts, baseY };
  }

  // ── Road geometry ─────────────────────────────────────────────
  // Uses a wider 5-point moving average for smoother elevation
  // transitions over noisy DEM data.
  _roadGeom(way, elev) {
    const coords = way.coords;
    if (coords.length < 2) return null;

    const hw   = this._roadHalfWidth(way.tags.highway);
    const rawY = coords.map(c => elev(c.x, c.z));

    // 5-point weighted moving average (1-2-3-2-1)
    const smoothY = rawY.map((_, i) => {
      const weights = [1, 2, 3, 2, 1];
      let sum = 0, total = 0;
      for (let w = -2; w <= 2; w++) {
        const idx = Math.max(0, Math.min(rawY.length - 1, i + w));
        const wt  = weights[w + 2];
        sum   += rawY[idx] * wt;
        total += wt;
      }
      return sum / total;
    });

    const pos = [], idx = [];
    for (let i = 0; i < coords.length; i++) {
      const prev = coords[i - 1] || coords[i];
      const next = coords[i + 1] || coords[i];
      const dx   = next.x - prev.x, dz = next.z - prev.z;
      const len  = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx   = -dz / len, nz = dx / len;
      const y    = smoothY[i] + 0.5; // larger bias keeps roads above terrain

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
  _conformPolyGeom(way, elev, yBias = 0.2) {
    const verts = this._ensureCCW(way.coords.slice(0, -1));
    if (verts.length < 3) return null;

    const flat    = verts.flatMap(v => [v.x, v.z]);
    const indices = earcut(flat);
    if (!indices.length) return null;

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
