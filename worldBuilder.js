// js/worldBuilder.js — Converts parsed OSM ways into Three.js meshes
import * as THREE from 'three';
import { earcut }  from './earcut.js';

// ── Material palette ─────────────────────────────────────────
const MAT = {
  building: new THREE.MeshStandardMaterial({ color: 0x1a2035, roughness: 0.7, metalness: 0.3 }),
  buildingTop: new THREE.MeshStandardMaterial({ color: 0x2a3555, roughness: 0.5, metalness: 0.4 }),
  road:     new THREE.MeshStandardMaterial({ color: 0x151820, roughness: 1.0 }),
  water:    new THREE.MeshStandardMaterial({ color: 0x0a3060, roughness: 0.1, metalness: 0.5, transparent: true, opacity: 0.85 }),
  park:     new THREE.MeshStandardMaterial({ color: 0x0d2210, roughness: 1.0 }),
};

export class WorldBuilder {
  constructor(sceneManager) {
    this.scene = sceneManager;
  }

  /**
   * Takes the structured ways array from MapFetcher and builds 3D geometry.
   * @param {Array}  ways         — array of way objects
   * @param {number} heightScale  — multiplier applied to building heights
   * @returns {{ buildings, roads, water, parks, triangleCount }}
   */
  build(ways, heightScale = 10) {
    this.scene.clearWorld();

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
          const mesh = this._flatPolygon(way, MAT.water, 0.3);
          if (mesh) { this.scene.addObject(mesh); water++; tris += this._triCount(mesh); }
        } else if (way.kind === 'park' && way.closed) {
          const mesh = this._flatPolygon(way, MAT.park, 0.5);
          if (mesh) { this.scene.addObject(mesh); parks++; tris += this._triCount(mesh); }
        }
      } catch (_) { /* skip bad geometry silently */ }
    }

    this.scene.addObject(buildingGroup, true); // buildings are pickable
    return { buildings, roads: roads, water, parks, triangleCount: tris };
  }

  // ── Building extrusion ────────────────────────────────────────
  _buildingMesh(way, heightScale) {
    const coords = way.coords;
    if (coords.length < 3) return null;

    const h     = way.height * heightScale;
    const verts = coords.slice(0, -1); // drop closing vertex
    if (verts.length < 3) return null;

    // Triangulate the footprint with earcut
    const flat    = verts.flatMap(c => [c.x, c.z]);
    const indices = earcut(flat);
    if (!indices || !indices.length) return null;

    const geom = new THREE.BufferGeometry();

    // Positions: bottom ring + top ring + top face
    const n     = verts.length;
    const pos   = [];
    const nrm   = [];
    const idxArr = [];

    // Side walls
    for (let i = 0; i < n; i++) {
      const j   = (i + 1) % n;
      const ax  = verts[i].x, az = verts[i].z;
      const bx  = verts[j].x, bz = verts[j].z;
      const base = pos.length / 3;

      // 4 vertices per wall quad
      pos.push(ax, 0, az,  bx, 0, bz,  bx, h, bz,  ax, h, az);

      // Normal
      const dx = bx - ax, dz = bz - az;
      const len = Math.sqrt(dx*dx + dz*dz) || 1;
      const nx = -dz/len, nz = dx/len;
      for (let k = 0; k < 4; k++) nrm.push(nx, 0, nz);

      idxArr.push(base, base+1, base+2,  base, base+2, base+3);
    }

    // Top face
    const topBase = pos.length / 3;
    for (const v of verts) pos.push(v.x, h, v.z);
    for (let k = 0; k < n; k++) nrm.push(0, 1, 0);
    for (let k = 0; k < indices.length; k += 3) {
      idxArr.push(topBase + indices[k], topBase + indices[k+1], topBase + indices[k+2]);
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute('normal',   new THREE.Float32BufferAttribute(nrm, 3));
    geom.setIndex(idxArr);

    const mat  = MAT.building.clone();
    // Vary colour slightly per building
    const hue  = (way.id % 40) / 40;
    mat.color.setHSL(0.6 + hue * 0.1, 0.3, 0.12 + hue * 0.08);

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.userData      = { kind: 'building', tags: way.tags, height: h };
    return mesh;
  }

  // ── Road ribbon ───────────────────────────────────────────────
  _roadMesh(way) {
    const coords = way.coords;
    if (coords.length < 2) return null;

    const hw  = this._roadHalfWidth(way.tags.highway);
    const pos = [];
    const idx = [];

    for (let i = 0; i < coords.length; i++) {
      const prev = coords[i - 1] || coords[i];
      const next = coords[i + 1] || coords[i];
      const dx   = next.x - prev.x;
      const dz   = next.z - prev.z;
      const len  = Math.sqrt(dx*dx + dz*dz) || 1;
      const nx   = -dz / len, nz = dx / len;
      pos.push(
        coords[i].x + nx * hw, 0.1, coords[i].z + nz * hw,
        coords[i].x - nx * hw, 0.1, coords[i].z - nz * hw,
      );
      if (i > 0) {
        const b = (i - 1) * 2;
        idx.push(b, b+1, b+2,  b+1, b+3, b+2);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setIndex(idx);
    geom.computeVertexNormals();

    const mat  = MAT.road.clone();
    const mesh = new THREE.Mesh(geom, mat);
    mesh.receiveShadow = true;
    mesh.userData      = { kind: 'road', tags: way.tags };
    return mesh;
  }

  // ── Flat polygon (water / park) ───────────────────────────────
  _flatPolygon(way, baseMat, yOffset = 0) {
    const verts = way.coords.slice(0, -1);
    if (verts.length < 3) return null;
    const flat    = verts.flatMap(v => [v.x, v.z]);
    const indices = earcut(flat);
    if (!indices.length) return null;

    const pos = verts.flatMap(v => [v.x, yOffset, v.z]);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const mat  = baseMat.clone();
    return new THREE.Mesh(geom, mat);
  }

  // ── Road width by OSM highway tag ────────────────────────────
  _roadHalfWidth(highway) {
    const w = {
      motorway: 8, trunk: 6, primary: 5, secondary: 4,
      tertiary: 3, residential: 2.5, service: 1.5,
      footway: 1,  path: 0.8, cycleway: 1.2,
    };
    return w[highway] ?? 2;
  }

  _triCount(mesh) {
    if (!mesh.geometry || !mesh.geometry.index) return 0;
    return mesh.geometry.index.count / 3;
  }
}
