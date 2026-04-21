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

export class WorldBuilder {
  constructor(sceneManager) {
    this.scene         = sceneManager;
    this._toonGradient = makeToonGradient();

    this._lampPostMat = new THREE.MeshLambertMaterial({ color: 0x888890 });
    // Globe is now a small box — much lower tri count than a sphere
    this._lampGlobeMat = new THREE.MeshLambertMaterial({
      color:             0xfff0c0,
      emissive:          new THREE.Color(0xffa040),
      emissiveIntensity: 0,
    });
    this._lampHaloTex = this._makeLampHaloTexture();

    // Aviation obstruction lights — red, flashing emissive boxes on tall buildings
    this._aviatMat = new THREE.MeshLambertMaterial({
      color:             0xff1a00,
      emissive:          new THREE.Color(0xff2200),
      emissiveIntensity: 0,   // driven by setTimeOfDay via isLampGlobe flag
    });
    // Shared geometries (constructed once, instanced by reference)
    this._globeGeo  = new THREE.BoxGeometry(0.7, 0.5, 0.7);
    this._aviatGeo  = new THREE.BoxGeometry(0.6, 0.6, 0.6);
    this._postGeo   = new THREE.CylinderGeometry(0.12, 0.16, 6.5, 6, 1);
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
    const elev = (x, z) => rawElev(x, z) - centreElev;
  
    const buildingFootprints = [];
    const rawRoadTris = [];
    const roadWays = [];
    const tallBuildings = [];
  
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
          placedFootprints.push({ verts: result.verts });
  
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
  
    // 🏢 BUILDING MESH (SINGLE)
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
  
    // 🛣 ROADS
    if (rawRoadTris.length) {
      const draped = this._drapeTriangles(rawRoadTris, terrainMesh, bvh, elev, DRAPE_BIAS);
      const roadGeom = this._buildGeom(draped.pos, draped.idx, draped.nrm);

      // ✅ BVH so the player can walk on road surfaces
      try { roadGeom.boundsTree = new MeshBVH(roadGeom); } catch (_) {}

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
      this.scene.registerCollidable(mesh);
      tris += draped.idx.length / 3;
    }

    // 💡 lamps — globes/halos stay as individual meshes; posts are merged
    // into a single BVH-accelerated mesh and registered as a collidable.
    if (roadWays.length) {
      const lampGroup = this._buildStreetLamps(roadWays, elev, terrainMesh);
      if (lampGroup) {
        // Add whole group to scene (non-collidable at group level)
        this.scene.addObject(lampGroup, false);

        const lampMeshes = [];
        lampGroup.traverse(c => {
          if (!c.isMesh) return;
          if (c.userData.isLampGlobe || c.userData.isLampHalo) {
            lampMeshes.push(c);
          }
          // Register the merged post mesh now that its BVH exists
          if (c.userData.isLampPostMerged && c.geometry?.boundsTree) {
            this.scene.registerCollidable(c);
          }
        });
        this.scene.registerLampMeshes(lampMeshes);
      }
    }
  
    // ✈️ aviation lights
    if (tallBuildings.length) {
      const aviatGroup = this._buildAviationLights(tallBuildings);
      if (aviatGroup) {
        this.scene.addObject(aviatGroup, false);
        const aviatMeshes = [];
        aviatGroup.traverse(c => {
          if (c.isMesh && c.userData.isLampGlobe) aviatMeshes.push(c);
        });
        this.scene.registerLampMeshes(aviatMeshes);
      }
    }
  
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
    const group = new THREE.Group();
    group.name  = 'streetLamps';

    // Use shared geometries defined in constructor
    const globeGeo = this._globeGeo;   // box, not sphere
    const haloGeo  = this._haloGeo;

    // ── Pre-compute the post geometry's raw arrays once ──────────
    // We'll manually transform each instance into merged buffers.
    const postGeoIndex    = this._postGeo.index.array;
    const postGeoPos      = this._postGeo.attributes.position.array;
    const postGeoNrm      = this._postGeo.attributes.normal.array;
    const postVertCount   = postGeoPos.length / 3;
    const postIndexCount  = postGeoIndex.length;

    // Merged post buffers — filled as we place each lamp post.
    const mergedPos = [];
    const mergedNrm = [];
    const mergedIdx = [];
    let   postBase  = 0;  // running vertex index offset

    // Spatial deduplication: quantise to LAMP_DEDUP_CELL grid.
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

        const baseY  = this._snapY(lx, lz, elev, terrainMesh, 0);
        const postCY = baseY + 3.25;   // CylinderGeometry centre Y (same as before)

        // ── Merge post geometry: translate each vertex into world space ──
        for (let v = 0; v < postVertCount; v++) {
          const vi = v * 3;
          mergedPos.push(
            postGeoPos[vi]     + lx,
            postGeoPos[vi + 1] + postCY,
            postGeoPos[vi + 2] + lz,
          );
          mergedNrm.push(postGeoNrm[vi], postGeoNrm[vi + 1], postGeoNrm[vi + 2]);
        }
        for (let t = 0; t < postIndexCount; t++) {
          mergedIdx.push(postGeoIndex[t] + postBase);
        }
        postBase += postVertCount;

        // Globe — unchanged, individual mesh per lamp
        const globe = new THREE.Mesh(globeGeo, this._lampGlobeMat.clone());
        globe.position.set(lx, baseY + 6.8, lz);
        globe.userData.isLampGlobe = true;
        group.add(globe);

        // Ground halo — unchanged, individual mesh per lamp
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
        halo.renderOrder     = 1;
        halo.userData.isLampHalo = true;
        group.add(halo);
      }
    }

    if (!group.children.length && !mergedPos.length) return null;

    // ── Build single merged post mesh with BVH ───────────────────
    if (mergedIdx.length) {
      const postGeom = new THREE.BufferGeometry();
      postGeom.setAttribute('position', new THREE.Float32BufferAttribute(mergedPos, 3));
      postGeom.setAttribute('normal',   new THREE.Float32BufferAttribute(mergedNrm, 3));
      postGeom.setIndex(mergedIdx);
      try { postGeom.boundsTree = new MeshBVH(postGeom); } catch (_) {}

      const postMesh = new THREE.Mesh(postGeom, this._lampPostMat);
      postMesh.castShadow = true;
      postMesh.userData.isLampPostMerged = true;
      group.add(postMesh);
    }

    return group.children.length ? group : null;
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
    const group = new THREE.Group();
    group.name  = 'aviationLights';

    const geo = this._aviatGeo;

    // Global dedup — one light per ~4 m cell across all buildings
    const placed   = new Set();
    const dedupKey = (x, z) => `${Math.round(x / 4)},${Math.round(z / 4)}`;

    for (const { verts, topY } of tallBuildings) {
      if (!verts || verts.length < 3) continue;

      // Find the 4 corner candidates: vertex closest to each diagonal extreme.
      // Score each vertex by (±x ± z) to find the 4 extremal directions.
      const corners = [
        verts.reduce((best, v) =>  (v.x + v.z) > (best.x + best.z) ? v : best, verts[0]), // NE (+x+z)
        verts.reduce((best, v) =>  (v.x - v.z) > (best.x - best.z) ? v : best, verts[0]), // SE (+x-z)
        verts.reduce((best, v) => (-v.x + v.z) > (-best.x + best.z) ? v : best, verts[0]), // NW (-x+z)
        verts.reduce((best, v) => (-v.x - v.z) > (-best.x - best.z) ? v : best, verts[0]), // SW (-x-z)
      ];

      for (const v of corners) {
        const k = dedupKey(v.x, v.z);
        if (placed.has(k)) continue;
        placed.add(k);

        const mat   = this._aviatMat.clone();
        const light = new THREE.Mesh(geo, mat);
        light.position.set(v.x, topY + 0.35, v.z);
        light.userData.isLampGlobe = true;
        group.add(light);
      }
    }

    return group.children.length ? group : null;
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