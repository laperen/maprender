// js/scene.js — Three.js scene, camera, renderer, lights, controls
import * as THREE from 'three';
import { OrbitControlsImpl } from './orbitControls.js';

export class SceneManager {
  constructor(container) {
    this.container   = container;
    this.renderMode  = 'solid';
    this._objects    = [];
    this._clock      = new THREE.Clock();
    this._groundMesh = null;

    // FPS tracking
    this._fpsFrames   = 0;
    this._fpsLastTime = performance.now();
    this._fpsEl       = null;
  }

  init() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled  = true;
    this.renderer.shadowMap.type     = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping        = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8ab0d0);
    this.scene.fog = new THREE.Fog(0x8ab0d0, 1000, 4000);

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 20000);
    this.camera.position.set(0, 600, 1200);
    this.camera.lookAt(0, 0, 0);

    // Orbit controls
    this.controls = new OrbitControlsImpl(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.minDistance   = 50;
    this.controls.maxDistance   = 8000;

    // Placeholder flat ground (replaced by elevation mesh after build)
    const groundGeo  = new THREE.PlaneGeometry(6000, 6000);
    const groundMat  = new THREE.MeshLambertMaterial({ color: 0x4a7a40 });
    this._groundMesh = new THREE.Mesh(groundGeo, groundMat);
    this._groundMesh.rotation.x       = -Math.PI / 2;
    this._groundMesh.receiveShadow    = true;
    this._groundMesh.userData.isGround = true;
    this.scene.add(this._groundMesh);

    this._addLights();
    this._createFPSCounter();

    this.raycaster  = new THREE.Raycaster();
    this.mouseNDC   = new THREE.Vector2();
    this._pickables = [];

    window.addEventListener('resize', () => this._onResize());
  }

  _addLights() {
    const sun = new THREE.DirectionalLight(0xfff5e0, 2.2);
    sun.position.set(600, 1000, 400);
    sun.castShadow = true;
    // 1024 instead of 2048 — ~4× cheaper shadow rendering
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near   = 10;
    sun.shadow.camera.far    = 3000;
    // Frustum sized to a typical 500m area — tighten after generate if needed
    sun.shadow.camera.left   = -800;
    sun.shadow.camera.right  =  800;
    sun.shadow.camera.top    =  800;
    sun.shadow.camera.bottom = -800;
    sun.shadow.bias = -0.0003;
    this.scene.add(sun);
    this.sun = sun;

    const ambient = new THREE.AmbientLight(0x90b0d8, 0.7);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    const rim = new THREE.DirectionalLight(0x4878c0, 0.5);
    rim.position.set(-400, 300, -500);
    this.scene.add(rim);
  }

  // ── Tighten shadow frustum to the actual area radius ─────────
  _fitShadowFrustum(radiusMeters) {
    const r = Math.min(radiusMeters * 1.2, 2000);
    this.sun.shadow.camera.left   = -r;
    this.sun.shadow.camera.right  =  r;
    this.sun.shadow.camera.top    =  r;
    this.sun.shadow.camera.bottom = -r;
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  // ── FPS counter ───────────────────────────────────────────────
  _createFPSCounter() {
    const el = document.createElement('div');
    el.id = 'fps-counter';
    Object.assign(el.style, {
      position:      'fixed',
      top:           '12px',
      right:         '12px',
      background:    'rgba(8,9,12,0.75)',
      color:         '#4fffb0',
      fontFamily:    "'Space Mono', monospace",
      fontSize:      '12px',
      fontWeight:    '700',
      padding:       '4px 10px',
      borderRadius:  '4px',
      border:        '1px solid #1e2130',
      zIndex:        '100',
      pointerEvents: 'none',
      letterSpacing: '0.05em',
    });
    el.textContent = '-- fps';
    document.body.appendChild(el);
    this._fpsEl = el;
  }

  _updateFPS() {
    this._fpsFrames++;
    const now     = performance.now();
    const elapsed = now - this._fpsLastTime;
    if (elapsed >= 500) {
      const fps = Math.round(this._fpsFrames / (elapsed / 1000));
      this._fpsEl.style.color =
        fps >= 50 ? '#4fffb0' : fps >= 30 ? '#ffd060' : '#ff4f6b';
      this._fpsEl.textContent  = `${fps} fps`;
      this._fpsFrames   = 0;
      this._fpsLastTime = now;
    }
  }

  // ── Elevation-displaced ground mesh ──────────────────────────
  // Called by WorldBuilder after the elevation grid is fetched.
  // Replaces the flat placeholder with a subdivided plane whose
  // vertices are displaced by the elevation data.
  buildElevationGround(elevGrid, gridSize, radiusMeters, centreElev) {
    // Remove old ground
    if (this._groundMesh) {
      this.scene.remove(this._groundMesh);
      this._groundMesh.geometry.dispose();
      this._groundMesh.material.dispose();
    }

    const segs    = gridSize - 1;
    const extent  = radiusMeters * 2; // plane side length in metres
    const geo     = new THREE.PlaneGeometry(extent, extent, segs, segs);
    geo.rotateX(-Math.PI / 2);

    if (elevGrid) {
      const positions = geo.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        const row = Math.floor(i / gridSize);
        const col = i % gridSize;
        const idx = row * gridSize + col;
        const relElev = elevGrid[idx] - centreElev;
        positions.setY(i, relElev);
      }
      positions.needsUpdate = true;
      geo.computeVertexNormals();
    }

    const mat  = new THREE.MeshLambertMaterial({ color: 0x4a7a40 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow     = true;
    mesh.userData.isGround = true;
    this.scene.add(mesh);
    this._groundMesh = mesh;

    this._fitShadowFrustum(radiusMeters);
  }

  // ── Satellite ground texture ──────────────────────────────────
  setGroundTexture(tex, radiusMeters) {
    if (!this._groundMesh) return;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    // PlaneGeometry UVs already span [0,1] — no repeat needed
    tex.needsUpdate = true;
    this._groundMesh.material.map   = tex;
    this._groundMesh.material.color.set(0xffffff);
    this._groundMesh.material.needsUpdate = true;
  }

  // ── Render loop ───────────────────────────────────────────────
  start() {
    this.init();
    const animate = () => {
      requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this._updateFPS();
    };
    animate();
  }

  // ── Object management ─────────────────────────────────────────
  clearWorld() {
    for (const obj of this._objects) {
      this.scene.remove(obj);
      obj.traverse(child => {
        if (child.isMesh) {
          child.geometry.dispose();
          const mats = Array.isArray(child.material)
            ? child.material : [child.material];
          mats.forEach(m => m.dispose());
        }
      });
    }
    this._objects   = [];
    this._pickables = [];

    // Reset ground to plain colour
    if (this._groundMesh) {
      if (this._groundMesh.material.map) {
        this._groundMesh.material.map.dispose();
        this._groundMesh.material.map = null;
      }
      this._groundMesh.material.color.set(0x4a7a40);
      this._groundMesh.material.needsUpdate = true;
    }
  }

  addObject(obj, pickable = false) {
    this.scene.add(obj);
    this._objects.push(obj);
    if (pickable) this._pickables.push(obj);
  }

  setRenderMode(mode) {
    this.renderMode = mode;
    this._objects.forEach(group => {
      group.traverse(child => {
        if (!child.isMesh || child.userData.isGround) return;
        const mats = Array.isArray(child.material)
          ? child.material : [child.material];
        mats.forEach(mat => {
          if (mode === 'wireframe') {
            mat.wireframe = true; mat.transparent = false; mat.opacity = 1;
          } else if (mode === 'xray') {
            mat.wireframe = false; mat.transparent = true; mat.opacity = 0.35;
          } else {
            mat.wireframe   = false;
            mat.transparent = !!child.userData.isWater;
            mat.opacity     = child.userData.isWater ? 0.85 : 1;
          }
        });
      });
    });
  }

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouseNDC.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    this.mouseNDC.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const hits = this.raycaster.intersectObjects(this._pickables, true);
    return hits.length ? hits[0] : null;
  }

  _onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  flyTo(x, z, radius) {
    const dist = radius * 2.5;
    this.camera.position.set(x, dist * 0.8, z + dist);
    this.controls.target.set(x, 0, z);
    this.controls.update();
  }
}
