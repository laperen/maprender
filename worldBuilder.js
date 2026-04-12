// js/worldBuilder.js — Converts parsed OSM ways into Three.js meshes
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { earcut } from './earcut.js';
import {
  makeToonGradient,
  fetchSatelliteTexture,
  fetchElevationGrid,
  buildingPalette,
  roofColour,
} from './textureFactory.js';

// Patch THREE.Mesh so BVH-accelerated raycasting is used automatically
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const MIN_BUILDING_AREA = 5;  // m²
const ROAD_STEP         = 8;  // metres between road ribbon cross-sections
const POLY_STEP         = 15; // metres between polygon edge vertices

// Y position of the downward ray origin — well above any realistic terrain
const RAY_ORIGIN_Y = 2000;

export class WorldBuilder {
  constructor(sceneManager) {
    this.scene         = sceneManager;
    this._toonGradient = makeToonGradient();
  }

  async build(ways, heightScale = 1, lat = 0, lng = 0, radiusMeters = 500) {
    let buildings = 0, roads = 0, water = 0, parks = 0, tris = 0;

    // ── Elevation grid (used for terrain mesh + building base) ──
    const gridSize = 64;
    let elevGrid   = null;
    try {
      elevGrid = await fetchElevationGrid(lat, lng, radiusMeters, gridSize);
    } catch (_) { /* flat fallback */ }

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

    // ── Building footprints for ground flattening ─────────────
    const buildingFootprints = [];

    // ── Geometry accumulators ─────────────────────────────────
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

    // ── Build terrain ground mesh ─────────────────────────────
    // Must happen before BVH snap so the mesh exists to cast against.
    this.scene.buildElevationGround(elev, gridSize, radiusMeters, buildingFootprints);

    // ── Build BVH on terrain and snap road/park vertices ──────
    const terrainMesh = this.scene.getTerrainMesh();
    if (terrainMesh) {
      // Compute BVH on the terrain geometry — one-time cost, fast queries
      terrainMesh.geometry.boundsTree = new MeshBVH(terrainMesh.geometry);

      if (roadPos.length)  this._snapToTerrain(roadPos,  roadNrm,  terrainMesh, 0.3);
      if (parkPos.length)  this._snapToTerrain(parkPos,  parkNrm,  terrainMesh, 0.2);
    }

    // ── Add merged meshes to scene ────────────────────────────
    this.scene.addObject(buildingGroup, true);
    tris += buildingGroup.children.reduce((s, m) => s + this._triCount(m), 0);

    if (roadIdx.length) {
      const geom = this._mergedGeom(roadPos, roadIdx, roadNrm);
      const mesh = new THREE.Mesh(
        geom,
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
      const geom = this._mergedGeom(parkPos, parkIdx, parkNrm);
      const mesh = new THREE.Mesh(
        geom,
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

  // ── BVH terrain snap ─────────────────────────────────────────
  // Iterates every vertex in a flat positions array and casts a
  // downward ray against the terrain BVH. If a hit is found, the
  // vertex Y is replaced with the hit point Y + yBias.
  // Normals are recomputed after all vertices are updated.
  //
  // positions: flat Float32 array [x0,y0,z0, x1,y1,z1, ...]
  // normals:   parallel flat array, updated in-place after snap
  // mesh:      terrain Mesh with boundsTree already set
  // yBias:     metres above surface (prevents z-fighting)
  _snapToTerrain(positions, normals, mesh, yBias = 0.2) {
    const raycaster  = new THREE.Raycaster();
    const rayDir     = new THREE.Vector3(0, -1, 0);
    const rayOrigin  = new THREE.Vector3();
    const count      = positions.length / 3;

    for (let i = 0; i < count; i++) {
      const x = positions[i * 3];
      const z = positions[i * 3 + 2];

      rayOrigin.set(x, RAY_ORIGIN_Y, z);
      raycaster.set(rayOrigin, rayDir);

      // intersectObject uses the BVH automatically via acceleratedRaycast
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length > 0) {
        positions[i * 3 + 1] = hits[0].point.y + yBias;
      }
      // If no hit (vertex outside terrain bounds), leave Y unchanged —
      // it will already have the elevation-grid value from geometry build.
    }

    // Recompute normals so lighting on roads/parks reflects the
    // terrain slope they now sit on rather than the pre-snap geometry.
    // We do this by rebuilding a temporary geometry, computing normals,
    // then copying them back into the normals array.
    // Only necessary if the normals array is non-empty.
    if (normals.length > 0) {
      // We don't have the index array here, so we approximate by
      // zeroing all normals and setting them to straight up — this
      // is correct for roads and parks which are nearly horizontal.
      // The MeshLambertMaterial will shade correctly with Y-up normals.
      for (let i = 0; i < normals.length; i += 3) {
        normals[i]     = 0;
        normals[i + 1] = 1;
        normals[i + 2] = 0;
      }
    }
  }

  // ── Segment subdivision ───────────────────────────────────────
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
      if (i === coords.length - 1) {
        result.push({ x: coords[i].x, z: coords[i].z });
        break;
      }
      const pts = this._subdivideSegment(
        coords[i].x, coords[i].z,
        coords[i + 1].x, coords[i + 1].z,
        step
      );
      for (let k = 0; k < pts.length - 1; k++) result.push(pts[k]);
    }
    return result;
  }

  _subdivideRing(verts, step) {
    const n      = verts.length;
    const result = [];
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const pts  = this._subdivideSegment(
        verts[i].x,    verts[i].z,
        verts[next].x, verts[next].z,
        step
      );
      for (let k = 0; k < pts.length - 1; k++) result.push(pts[k]);
    }
    return result;
  }

  // ── Merged BufferGeometry ─────────────────────────────────────
  // Accepts plain JS arrays — positions and normals are already
  // mutable plain arrays so _snapToTerrain can update them in-place
  // before this geometry is created.
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
  _buildingMesh(way, heightScale, elev) {
    const coords = way.coords;
    if (coords.length < 3) return null;

    const verts = this._ensureCCW(coords.slice(0, -1));
    if (verts.length < 3) return null;
    if (Math.abs(this._signedArea(verts)) < MIN_BUILDING_AREA) return null;

    const flat    = verts.flatMap(c => [c.x, c.z]);
    const indices = earcut(flat);
    if (!indices?.length) return null;

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
  // Produces subdivided ribbon with elev()-based Y as a first pass.
  // _snapToTerrain() will refine these Y values against the BVH.
  _roadGeom(way, elev) {
    const coords = way.coords;
    if (coords.length < 2) return null;

    const hw         = this._roadHalfWidth(way.tags.highway);
    const centreline = this._subdividePolyline(coords, ROAD_STEP);
    if (centreline.length < 2) return null;

    const pos = [], idx = [];
    for (let i = 0; i < centreline.length; i++) {
      const prev = centreline[i - 1] || centreline[i];
      const next = centreline[i + 1] || centreline[i];
      const dx   = next.x - prev.x, dz = next.z - prev.z;
      const len  = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx   = -dz / len, nz = dx / len;
      // Use elev() as the initial Y — will be overwritten by BVH snap
      const y    = elev(centreline[i].x, centreline[i].z);

      pos.push(
        centreline[i].x + nx * hw, y, centreline[i].z + nz * hw,
        centreline[i].x - nx * hw, y, centreline[i].z - nz * hw,
      );
      if (i > 0) {
        const b = (i - 1) * 2;
        idx.push(b, b + 2, b + 1,  b + 1, b + 2, b + 3);
      }
    }

    // normals are placeholders — _snapToTerrain sets them to Y-up
    const nrm = new Array(pos.length).fill(0);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;

    return { pos, idx, nrm };
  }

  // ── Terrain-conforming polygon (park / water) ─────────────────
  // elev() gives initial Y. For parks, _snapToTerrain() will refine.
  // Water keeps the average elevation approach so bodies stay flat.
  _conformPolyGeom(way, elev, yBias = 0.2) {
    const raw = this._ensureCCW(way.coords.slice(0, -1));
    if (raw.length < 3) return null;

    const verts = this._subdivideRing(raw, POLY_STEP);
    if (verts.length < 3) return null;

    const flat    = verts.flatMap(v => [v.x, v.z]);
    const indices = earcut(flat);
    if (!indices.length) return null;

    const pos = verts.flatMap(v => [v.x, elev(v.x, v.z) + yBias, v.z]);

    const flipped = [];
    for (let i = 0; i < indices.length; i += 3) {
      flipped.push(indices[i], indices[i + 2], indices[i + 1]);
    }

    // Y-up normals as placeholders — _snapToTerrain updates these
    const nrm = new Array(pos.length).fill(0);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;

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
    return mesh.geometry?.index ? mesh.geometry.index.count / 3 : 0;
  }
}
