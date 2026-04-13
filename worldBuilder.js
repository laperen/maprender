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

THREE.Mesh.prototype.raycast = acceleratedRaycast;

const MIN_BUILDING_AREA = 5;
const ROAD_STEP  = 8;
const POLY_STEP  = 15;
const DRAPE_BIAS = 0.4;
const RAY_ORIGIN_Y = 2000;

// ── Street lamp constants ─────────────────────────────────────
const LAMP_SPACING     = 35;   // metres between posts along centreline
const LAMP_SIDE_OFFSET = 3.2;  // metres from centreline to post

// Cell size for deduplication grid — two lamps within this distance collapse to one.
// Slightly larger than LAMP_SIDE_OFFSET * 2 to also catch opposite-side duplicates
// at narrow intersections.
const LAMP_DEDUP_CELL  = 9;    // metres

const LAMP_ROAD_TYPES  = new Set([
  'motorway', 'trunk', 'primary', 'secondary',
  'tertiary', 'residential', 'service', 'living_street',
]);

export class WorldBuilder {
  constructor(sceneManager) {
    this.scene         = sceneManager;
    this._toonGradient = makeToonGradient();

    this._lampPostMat = new THREE.MeshLambertMaterial({ color: 0x888890 });
    this._lampGlobeMat = new THREE.MeshLambertMaterial({
      color:             0xfff0c0,
      emissive:          new THREE.Color(0xffa040),
      emissiveIntensity: 0,
    });
    this._lampHaloTex = this._makeLampHaloTexture();
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

    const buildingFootprints = [];
    const rawRoadTris = [];
    const watPos = [], watIdx = [], watNrm = []; let watBase = 0;

    const buildingGroup = new THREE.Group();
    buildingGroup.name  = 'buildings';

    const roadWays = [];

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
          const ts = this._roadTriangles(way);
          if (ts) {
            ts.forEach(t => rawRoadTris.push(t));
            roads++;
            if (LAMP_ROAD_TYPES.has(way.tags.highway)) roadWays.push(way);
          }
        } else if (way.kind === 'water' && way.closed) {
          const r = this._waterPolyGeom(way, elev);
          if (r) {
            r.pos.forEach(v => watPos.push(v));
            r.nrm.forEach(v => watNrm.push(v));
            r.idx.forEach(i => watIdx.push(watBase + i));
            watBase += r.pos.length / 3;
            water++;
          }
        }
      } catch (_) {}
    }

    this.scene.buildElevationGround(elev, gridSize, radiusMeters, buildingFootprints);

    const terrainMesh = this.scene.getTerrainMesh();
    let   bvh         = null;
    if (terrainMesh) {
      try {
        terrainMesh.geometry.boundsTree = new MeshBVH(terrainMesh.geometry);
        bvh = terrainMesh.geometry.boundsTree;
      } catch (e) { console.warn('BVH build failed:', e); }
    }

    this.scene.addObject(buildingGroup, true);
    tris += buildingGroup.children.reduce((s, m) => s + this._triCount(m), 0);

    if (rawRoadTris.length) {
      const draped = this._drapeTriangles(rawRoadTris, terrainMesh, bvh, elev, DRAPE_BIAS);
      const mesh = new THREE.Mesh(
        this._buildGeom(draped.pos, draped.idx, draped.nrm),
        new THREE.MeshLambertMaterial({ color: 0x505058 })
      );
      mesh.receiveShadow = true;
      mesh.userData      = { kind: 'road' };
      this.scene.addObject(mesh);
      tris += draped.idx.length / 3;
    }

    if (roadWays.length) {
      const lampGroup = this._buildStreetLamps(roadWays, elev, terrainMesh);
      if (lampGroup) {
        this.scene.addObject(lampGroup);
        const lampMeshes = [];
        lampGroup.traverse(child => {
          if (child.isMesh && child.userData.isLampGlobe) lampMeshes.push(child);
          if (child.isMesh && child.userData.isLampHalo)  lampMeshes.push(child);
        });
        this.scene.registerLampMeshes(lampMeshes);
      }
    }

    if (watIdx.length) {
      const mesh = new THREE.Mesh(
        this._buildGeom(watPos, watIdx, watNrm),
        new THREE.MeshLambertMaterial({ color: 0x2878b0, transparent: true, opacity: 0.85 })
      );
      mesh.userData = { kind: 'water', isWater: true };
      this.scene.addObject(mesh);
      tris += watIdx.length / 3;
    }

    fetchSatelliteTexture(lat, lng, radiusMeters)
      .then(tex => this.scene.setGroundTexture(tex))
      .catch(() => {});

    return { buildings, roads, water, parks, triangleCount: Math.round(tris) };
  }

  // ═══════════════════════════════════════════════════════════════
  // STREET LAMPS — with spatial deduplication grid
  // ═══════════════════════════════════════════════════════════════

  _buildStreetLamps(roadWays, elev, terrainMesh) {
    const group = new THREE.Group();
    group.name  = 'streetLamps';

    const postGeo  = new THREE.CylinderGeometry(0.12, 0.16, 6.5, 6, 1);
    const globeGeo = new THREE.SphereGeometry(0.45, 7, 5);
    const haloGeo  = new THREE.PlaneGeometry(14, 14);

    const raycaster = new THREE.Raycaster();
    const rayDir    = new THREE.Vector3(0, -1, 0);
    const rayOrigin = new THREE.Vector3();

    const snapY = (x, z) => {
      if (!terrainMesh) return elev(x, z);
      rayOrigin.set(x, RAY_ORIGIN_Y, z);
      raycaster.set(rayOrigin, rayDir);
      const hits = raycaster.intersectObject(terrainMesh, false);
      return hits.length > 0 ? hits[0].point.y : elev(x, z);
    };

    // Spatial deduplication: quantise to LAMP_DEDUP_CELL grid.
    // Key encodes cell so that any two positions within LAMP_DEDUP_CELL metres
    // map to the same cell and only the first one wins.
    const placed = new Set();
    const dedupKey = (x, z) =>
      `${Math.round(x / LAMP_DEDUP_CELL)},${Math.round(z / LAMP_DEDUP_CELL)}`;

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

        // One lamp, left side only (avoids paired duplicates on narrow roads)
        const lx = centreline[i].x + nx * LAMP_SIDE_OFFSET;
        const lz = centreline[i].z + nz * LAMP_SIDE_OFFSET;
        const k  = dedupKey(lx, lz);
        if (placed.has(k)) continue;
        placed.add(k);

        const baseY = snapY(lx, lz);

        // Post
        const post = new THREE.Mesh(postGeo, this._lampPostMat);
        post.position.set(lx, baseY + 3.25, lz);
        post.castShadow = true;
        group.add(post);

        // Globe
        const globe = new THREE.Mesh(globeGeo, this._lampGlobeMat.clone());
        globe.position.set(lx, baseY + 6.8, lz);
        globe.userData.isLampGlobe = true;
        group.add(globe);

        // Ground halo
        const haloMat = new THREE.MeshBasicMaterial({
          map:         this._lampHaloTex,
          transparent: true,
          opacity:     0,
          depthWrite:  false,
          blending:    THREE.AdditiveBlending,
        });
        const halo = new THREE.Mesh(haloGeo, haloMat);
        halo.rotation.x = -Math.PI / 2;
        halo.position.set(lx, baseY + 0.08, lz);
        halo.renderOrder    = 1;
        halo.userData.isLampHalo = true;
        group.add(halo);
      }
    }

    return group.children.length ? group : null;
  }

  // ═══════════════════════════════════════════════════════════════
  // DRAPING ENGINE
  // ═══════════════════════════════════════════════════════════════

  _drapeTriangles(inputTris, terrainMesh, bvh, elev, bias) {
    const outPos = [], outIdx = [], outNrm = [];

    const raycaster = new THREE.Raycaster();
    const rayDir    = new THREE.Vector3(0, -1, 0);
    const rayOrigin = new THREE.Vector3();

    const snapY = (x, z) => {
      if (!terrainMesh) return elev(x, z) + bias;
      rayOrigin.set(x, RAY_ORIGIN_Y, z);
      raycaster.set(rayOrigin, rayDir);
      const hits = raycaster.intersectObject(terrainMesh, false);
      return hits.length > 0 ? hits[0].point.y + bias : elev(x, z) + bias;
    };

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
      for (const p of ring) p.y = snapY(p.x, p.z);

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
      idxArr.push(topBase + indices[k], topBase + indices[k + 2], topBase + indices[k + 1]);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('normal',   new THREE.Float32BufferAttribute(nrm, 3));
    geom.setIndex(idxArr);
    geom.addGroup(0,         wallCount,                 0);
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
