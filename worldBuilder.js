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

const MIN_BUILDING_AREA = 5;   // m²
const ROAD_STEP         = 8;   // m between road ribbon cross-sections
const POLY_STEP         = 15;  // m between polygon edge vertices
const DRAPE_BIAS        = 0.25; // m above terrain surface (prevents z-fighting)
const RAY_ORIGIN_Y      = 2000; // m above zero — ray cast origin

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

    // ── Building footprints ───────────────────────────────────
    const buildingFootprints = [];

    // ── Geometry accumulators ─────────────────────────────────
    // Roads and parks are collected as raw triangle soups first.
    // The draping pass converts them into draped geometry afterwards.
    const rawRoadTris = []; // [{a,b,c}] each vertex is {x,z}
    const rawParkTris = [];
    const watPos = [], watIdx = [], watNrm = []; let watBase = 0;

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
          const tris = this._roadTriangles(way);
          if (tris) { tris.forEach(t => rawRoadTris.push(t)); roads++; }

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
          const tris = this._polygonTriangles(way);
          if (tris) { tris.forEach(t => rawParkTris.push(t)); parks++; }
        }
      } catch (_) {}
    }

    // ── Build terrain ─────────────────────────────────────────
    this.scene.buildElevationGround(elev, gridSize, radiusMeters, buildingFootprints);

    const terrainMesh = this.scene.getTerrainMesh();
    let   bvh         = null;
    let   terrainPos  = null;
    let   terrainIdx  = null;

    if (terrainMesh) {
      try {
        terrainMesh.geometry.boundsTree = new MeshBVH(terrainMesh.geometry);
        bvh        = terrainMesh.geometry.boundsTree;
        terrainPos = terrainMesh.geometry.attributes.position;
        terrainIdx = terrainMesh.geometry.index
          ? terrainMesh.geometry.index.array
          : null;
      } catch (e) {
        console.warn('BVH build failed, falling back to snap-only:', e);
      }
    }

    this.scene.addObject(buildingGroup, true);
    tris += buildingGroup.children.reduce((s, m) => s + this._triCount(m), 0);

    // ── Drape roads ───────────────────────────────────────────
    if (rawRoadTris.length) {
      const { pos, idx, nrm } = bvh && terrainPos
        ? this._drapeTriangles(rawRoadTris, terrainMesh, bvh, terrainPos, terrainIdx, DRAPE_BIAS)
        : this._fallbackTriangles(rawRoadTris, elev, DRAPE_BIAS);

      const mesh = new THREE.Mesh(
        this._buildGeom(pos, idx, nrm),
        new THREE.MeshLambertMaterial({ color: 0x505058 })
      );
      mesh.receiveShadow = true;
      mesh.userData      = { kind: 'road' };
      this.scene.addObject(mesh);
      tris += idx.length / 3;
    }

    // ── Drape parks ───────────────────────────────────────────
    if (rawParkTris.length) {
      const { pos, idx, nrm } = bvh && terrainPos
        ? this._drapeTriangles(rawParkTris, terrainMesh, bvh, terrainPos, terrainIdx, DRAPE_BIAS * 0.8)
        : this._fallbackTriangles(rawParkTris, elev, DRAPE_BIAS * 0.8);

      const mesh = new THREE.Mesh(
        this._buildGeom(pos, idx, nrm),
        new THREE.MeshLambertMaterial({ color: 0x4a7a40 })
      );
      mesh.receiveShadow = true;
      mesh.userData      = { kind: 'park' };
      this.scene.addObject(mesh);
      tris += idx.length / 3;
    }

    // ── Water (flat average, no draping) ─────────────────────
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
  // DRAPING ENGINE
  // ═══════════════════════════════════════════════════════════════

  // ── _drapeTriangles ───────────────────────────────────────────
  // Main draping pass. For each input XZ triangle:
  //   1. Find all terrain triangles overlapping its XZ bounding box
  //   2. For each input edge, compute XZ intersections with each
  //      terrain edge and insert new vertices at those points
  //   3. Re-triangulate the resulting polygon with earcut
  //   4. For every vertex (original + inserted), raycast downward
  //      to snap Y exactly to the terrain surface + bias
  _drapeTriangles(inputTris, terrainMesh, bvh, terrainPos, terrainIdx, bias) {
    const outPos = [], outIdx = [], outNrm = [];
    const raycaster = new THREE.Raycaster();
    const rayDir    = new THREE.Vector3(0, -1, 0);
    const rayOrigin = new THREE.Vector3();

    // Helper: snap a single {x,z} point to terrain Y
    const snapY = (x, z) => {
      rayOrigin.set(x, RAY_ORIGIN_Y, z);
      raycaster.set(rayOrigin, rayDir);
      const hits = raycaster.intersectObject(terrainMesh, false);
      return hits.length ? hits[0].point.y + bias : bias;
    };

    // Reusable THREE objects for terrain triangle extraction
    const _vA = new THREE.Vector3();
    const _vB = new THREE.Vector3();
    const _vC = new THREE.Vector3();
    const _box = new THREE.Box3();

    for (const tri of inputTris) {
      // Compute XZ bounding box of this input triangle
      const minX = Math.min(tri.a.x, tri.b.x, tri.c.x);
      const maxX = Math.max(tri.a.x, tri.b.x, tri.c.x);
      const minZ = Math.min(tri.a.z, tri.b.z, tri.c.z);
      const maxZ = Math.max(tri.a.z, tri.b.z, tri.c.z);

      // Collect all XZ intersection points along each edge of the
      // input triangle by testing against terrain triangle edges
      // in the bounding box region.
      const edgePoints = [
        [{ ...tri.a }],  // points along edge A→B (including endpoints)
        [{ ...tri.b }],  // points along edge B→C
        [{ ...tri.c }],  // points along edge C→A
      ];
      const edgeEnds = [tri.b, tri.c, tri.a];

      // Query BVH for terrain triangles overlapping the XZ bbox
      // Use a tall Y range to guarantee we capture all terrain tris
      _box.set(
        new THREE.Vector3(minX, -10000, minZ),
        new THREE.Vector3(maxX,  10000, maxZ)
      );

      const terrainTriIndices = [];
      try {
        bvh.shapecast({
          intersectsBounds: (box) => box.intersectsBox(_box),
          intersectsTriangle: (triInfo) => {
            terrainTriIndices.push(triInfo.a, triInfo.b, triInfo.c);
            return false; // continue traversal
          },
        });
      } catch (_) {
        // shapecast API may differ — skip intersection for this tri
      }

      // For each terrain triangle, test its 3 edges against each
      // of the input triangle's 3 edges in XZ space
      for (let ti = 0; ti < terrainTriIndices.length; ti += 3) {
        const ia = terrainTriIndices[ti];
        const ib = terrainTriIndices[ti + 1];
        const ic = terrainTriIndices[ti + 2];

        const tA = { x: terrainPos.getX(ia), z: terrainPos.getZ(ia) };
        const tB = { x: terrainPos.getX(ib), z: terrainPos.getZ(ib) };
        const tC = { x: terrainPos.getX(ic), z: terrainPos.getZ(ic) };

        const terrainEdges = [[tA, tB], [tB, tC], [tC, tA]];

        // Test each of the 3 input edges against each terrain edge
        for (let ei = 0; ei < 3; ei++) {
          const eStart = [tri.a, tri.b, tri.c][ei];
          const eEnd   = edgeEnds[ei];

          for (const [tE0, tE1] of terrainEdges) {
            const pt = this._segSegIntersectXZ(
              eStart.x, eStart.z, eEnd.x, eEnd.z,
              tE0.x, tE0.z, tE1.x, tE1.z
            );
            if (pt) edgePoints[ei].push(pt);
          }
        }
      }

      // Sort each edge's points by distance from start and add endpoint
      for (let ei = 0; ei < 3; ei++) {
        const eStart = [tri.a, tri.b, tri.c][ei];
        const eEnd   = edgeEnds[ei];
        edgePoints[ei].push({ ...eEnd });

        // Sort by distance from edge start (XZ)
        edgePoints[ei].sort((p, q) => {
          const dp = (p.x - eStart.x)**2 + (p.z - eStart.z)**2;
          const dq = (q.x - eStart.x)**2 + (q.z - eStart.z)**2;
          return dp - dq;
        });

        // Deduplicate very close points (within 0.01m)
        edgePoints[ei] = edgePoints[ei].filter((p, i, arr) => {
          if (i === 0) return true;
          const prev = arr[i - 1];
          return Math.sqrt((p.x - prev.x)**2 + (p.z - prev.z)**2) > 0.01;
        });
      }

      // Build the full polygon ring from the three edges
      // Each edge includes its start point and all inserted points,
      // but not its end (which is the next edge's start).
      const ring = [];
      for (let ei = 0; ei < 3; ei++) {
        const pts = edgePoints[ei];
        // Include all except the last point (= next edge's start)
        for (let pi = 0; pi < pts.length - 1; pi++) {
          ring.push(pts[pi]);
        }
      }

      if (ring.length < 3) continue;

      // Snap all ring points to terrain Y
      for (const p of ring) {
        p.y = snapY(p.x, p.z);
      }

      // Triangulate the ring in XZ with earcut
      const flat    = ring.flatMap(p => [p.x, p.z]);
      const indices = earcut(flat);
      if (!indices || indices.length < 3) continue;

      // Emit triangles — winding gives upward normals if ring is CCW.
      // Check signed area to ensure correct winding.
      const area = this._signedAreaXZ(ring);
      const base = outPos.length / 3;

      for (const p of ring) {
        outPos.push(p.x, p.y, p.z);
        outNrm.push(0, 1, 0);
      }

      if (area >= 0) {
        // CCW in XZ → normals point up with standard winding
        for (let k = 0; k < indices.length; k += 3) {
          outIdx.push(
            base + indices[k],
            base + indices[k + 2],
            base + indices[k + 1],
          );
        }
      } else {
        // CW → keep earcut winding as-is
        for (let k = 0; k < indices.length; k += 3) {
          outIdx.push(
            base + indices[k],
            base + indices[k + 1],
            base + indices[k + 2],
          );
        }
      }
    }

    return { pos: outPos, idx: outIdx, nrm: outNrm };
  }

  // ── _fallbackTriangles ────────────────────────────────────────
  // Used if BVH is unavailable. Simply snaps vertices using elev().
  _fallbackTriangles(inputTris, elev, bias) {
    const outPos = [], outIdx = [], outNrm = [];
    let base = 0;

    for (const tri of inputTris) {
      for (const v of [tri.a, tri.b, tri.c]) {
        outPos.push(v.x, elev(v.x, v.z) + bias, v.z);
        outNrm.push(0, 1, 0);
      }
      outIdx.push(base, base + 2, base + 1);
      base += 3;
    }

    return { pos: outPos, idx: outIdx, nrm: outNrm };
  }

  // ── _segSegIntersectXZ ────────────────────────────────────────
  // Returns the XZ intersection point of segment (p1→p2) with
  // segment (p3→p4), or null if they don't intersect within both
  // segments. Strictly interior intersections only (t and u in
  // (0,1) exclusive) to avoid duplicate endpoint vertices.
  _segSegIntersectXZ(p1x, p1z, p2x, p2z, p3x, p3z, p4x, p4z) {
    const d1x = p2x - p1x, d1z = p2z - p1z;
    const d2x = p4x - p3x, d2z = p4z - p3z;
    const cross = d1x * d2z - d1z * d2x;

    if (Math.abs(cross) < 1e-10) return null; // parallel

    const dx = p3x - p1x, dz = p3z - p1z;
    const t  = (dx * d2z - dz * d2x) / cross;
    const u  = (dx * d1z - dz * d1x) / cross;

    const eps = 1e-6;
    if (t > eps && t < 1 - eps && u > eps && u < 1 - eps) {
      return { x: p1x + t * d1x, z: p1z + t * d1z };
    }
    return null;
  }

  // ── _signedAreaXZ ─────────────────────────────────────────────
  _signedAreaXZ(pts) {
    let area = 0, n = pts.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += pts[i].x * pts[j].z - pts[j].x * pts[i].z;
    }
    return area / 2;
  }

  // ═══════════════════════════════════════════════════════════════
  // RAW TRIANGLE COLLECTION (no Y yet — draping assigns Y)
  // ═══════════════════════════════════════════════════════════════

  // ── Road ribbon triangles in XZ ───────────────────────────────
  // Returns [{a,b,c}] where each vertex is {x,z} only.
  // Y values are assigned by the draping pass.
  _roadTriangles(way) {
    const coords = way.coords;
    if (coords.length < 2) return null;

    const hw         = this._roadHalfWidth(way.tags.highway);
    const centreline = this._subdividePolyline(coords, ROAD_STEP);
    if (centreline.length < 2) return null;

    const left  = [];
    const right = [];

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
      // Each road quad = 2 triangles
      tris.push({ a: left[i],  b: left[i+1],  c: right[i]   });
      tris.push({ a: right[i], b: left[i+1],  c: right[i+1] });
    }
    return tris;
  }

  // ── Park polygon triangles in XZ ──────────────────────────────
  _polygonTriangles(way) {
    const raw = this._ensureCCW(way.coords.slice(0, -1));
    if (raw.length < 3) return null;

    const verts   = this._subdivideRing(raw, POLY_STEP);
    if (verts.length < 3) return null;

    const flat    = verts.flatMap(v => [v.x, v.z]);
    const indices = earcut(flat);
    if (!indices?.length) return null;

    const tris = [];
    for (let k = 0; k < indices.length; k += 3) {
      tris.push({
        a: { x: verts[indices[k]].x,   z: verts[indices[k]].z   },
        b: { x: verts[indices[k+1]].x, z: verts[indices[k+1]].z },
        c: { x: verts[indices[k+2]].x, z: verts[indices[k+2]].z },
      });
    }
    return tris;
  }

  // ═══════════════════════════════════════════════════════════════
  // GEOMETRY HELPERS
  // ═══════════════════════════════════════════════════════════════

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
      if (i === coords.length - 1) {
        result.push({ x: coords[i].x, z: coords[i].z });
        break;
      }
      const pts = this._subdivideSegment(
        coords[i].x, coords[i].z,
        coords[i+1].x, coords[i+1].z, step
      );
      for (let k = 0; k < pts.length - 1; k++) result.push(pts[k]);
    }
    return result;
  }

  _subdivideRing(verts, step) {
    const n = verts.length, result = [];
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const pts  = this._subdivideSegment(
        verts[i].x, verts[i].z, verts[next].x, verts[next].z, step
      );
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

  // ── Water polygon (flat average, no draping) ──────────────────
  _conformPolyGeom(way, elev, yBias = 0.2) {
    const raw = this._ensureCCW(way.coords.slice(0, -1));
    if (raw.length < 3) return null;
    const verts = this._subdivideRing(raw, POLY_STEP);
    if (verts.length < 3) return null;
    const flat    = verts.flatMap(v => [v.x, v.z]);
    const indices = earcut(flat);
    if (!indices.length) return null;
    const avgY = verts.reduce((s, v) => s + elev(v.x, v.z), 0) / verts.length + yBias;
    const pos  = verts.flatMap(v => [v.x, avgY, v.z]);
    const nrm  = new Array(pos.length).fill(0);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    const flipped = [];
    for (let i = 0; i < indices.length; i += 3) {
      flipped.push(indices[i], indices[i+2], indices[i+1]);
    }
    return { pos, idx: flipped, nrm };
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
