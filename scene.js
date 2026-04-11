// js/scene.js — Three.js scene, camera, renderer, lights, controls
import * as THREE from 'three';
import { OrbitControlsImpl } from './orbitControls.js';

export class SceneManager {
  constructor(container) {
    this.container = container;
    this.renderMode = 'solid'; // solid | wireframe | xray
    this._objects   = [];       // tracked mesh groups
  }

  // ── Initialise Three.js ─────────────────────────────────────
  init() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08090c);
    this.scene.fog = new THREE.FogExp2(0x08090c, 0.0008);

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 20000);
    this.camera.position.set(0, 600, 1200);
    this.camera.lookAt(0, 0, 0);

    // Orbit controls (vanilla — no React)
    this.controls = new OrbitControlsImpl(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.minDistance   = 50;
    this.controls.maxDistance   = 8000;

    // Lights
    this._addLights();

    // Grid helper (ground reference)
    const grid = new THREE.GridHelper(4000, 80, 0x1e2130, 0x1e2130);
    grid.position.y = -0.5;
    this.scene.add(grid);

    // Ground plane
    const groundGeo  = new THREE.PlaneGeometry(8000, 8000);
    const groundMat  = new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 1 });
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = true;
    this.scene.add(groundMesh);

    // Raycaster for tooltip
    this.raycaster  = new THREE.Raycaster();
    this.mouseNDC   = new THREE.Vector2();
    this._pickables = [];

    window.addEventListener('resize', () => this._onResize());
  }

  _addLights() {
    // Ambient
    const ambient = new THREE.AmbientLight(0x3040a0, 0.4);
    this.scene.add(ambient);

    // Sun (directional)
    const sun = new THREE.DirectionalLight(0xfff0d0, 1.6);
    sun.position.set(800, 1200, 600);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far  = 5000;
    sun.shadow.camera.left = sun.shadow.camera.bottom = -1500;
    sun.shadow.camera.right = sun.shadow.camera.top  =  1500;
    sun.shadow.bias = -0.0003;
    this.scene.add(sun);

    // Accent fill (cool blue)
    const fill = new THREE.DirectionalLight(0x4080ff, 0.5);
    fill.position.set(-400, 200, -600);
    this.scene.add(fill);

    // Ground bounce
    const bounce = new THREE.HemisphereLight(0x1a2040, 0x080a10, 0.6);
    this.scene.add(bounce);
  }

  // ── Render loop ─────────────────────────────────────────────
  start() {
    this.init();
    const animate = () => {
      requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  // ── Object management ────────────────────────────────────────
  clearWorld() {
    for (const obj of this._objects) {
      this.scene.remove(obj);
      obj.traverse(child => {
        if (child.isMesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material))
            child.material.forEach(m => m.dispose());
          else
            child.material.dispose();
        }
      });
    }
    this._objects   = [];
    this._pickables = [];
  }

  addObject(obj, pickable = false) {
    this.scene.add(obj);
    this._objects.push(obj);
    if (pickable) this._pickables.push(obj);
  }

  // ── Render mode ─────────────────────────────────────────────
  setRenderMode(mode) {
    this.renderMode = mode;
    this._objects.forEach(group => {
      group.traverse(child => {
        if (!child.isMesh) return;
        if (child.userData.isGround) return;

        if (mode === 'wireframe') {
          child.material.wireframe = true;
          child.material.opacity   = 1;
          child.material.transparent = false;
        } else if (mode === 'xray') {
          child.material.wireframe    = false;
          child.material.transparent  = true;
          child.material.opacity      = 0.35;
        } else {
          child.material.wireframe    = false;
          child.material.transparent  = false;
          child.material.opacity      = 1;
        }
      });
    });
  }

  // ── Picking ─────────────────────────────────────────────────
  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouseNDC.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    this.mouseNDC.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const hits = this.raycaster.intersectObjects(this._pickables, true);
    return hits.length ? hits[0] : null;
  }

  // ── Resize ──────────────────────────────────────────────────
  _onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ── Fly camera to position ───────────────────────────────────
  flyTo(x, z, radius) {
    const dist = radius * 2.5;
    this.camera.position.set(x, dist * 0.8, z + dist);
    this.controls.target.set(x, 0, z);
    this.controls.update();
  }
}
