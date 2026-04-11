// js/scene.js — Three.js scene, camera, renderer, lights, controls
import * as THREE from 'three';
import { OrbitControlsImpl } from './orbitControls.js';

export class SceneManager {
  constructor(container) {
    this.container  = container;
    this.renderMode = 'solid';
    this._objects   = [];
    this._clock     = new THREE.Clock();
    this._groundMesh = null;
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
    // Toon shading looks better without heavy tone mapping
    this.renderer.toneMapping        = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8aa8c8); // soft anime sky blue
    this.scene.fog = new THREE.Fog(0x8aa8c8, 800, 4000);

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

    // Lights (toon-friendly — fewer, stronger, more directional)
    this._addLights();

    // Ground plane — large enough to catch shadows beyond the OSM area.
    // Material is plain until the satellite texture loads via setGroundTexture().
    const groundGeo  = new THREE.PlaneGeometry(6000, 6000);
    const groundMat  = new THREE.MeshLambertMaterial({ color: 0x3a4a30 });
    this._groundMesh = new THREE.Mesh(groundGeo, groundMat);
    this._groundMesh.rotation.x    = -Math.PI / 2;
    this._groundMesh.receiveShadow  = true;
    this._groundMesh.userData.isGround = true;
    this.scene.add(this._groundMesh);

    // Raycaster for tooltip
    this.raycaster  = new THREE.Raycaster();
    this.mouseNDC   = new THREE.Vector2();
    this._pickables = [];

    window.addEventListener('resize', () => this._onResize());
  }

  _addLights() {
    // Toon shading needs clean directional light with minimal fill so the
    // gradient map steps are visible. Too much ambient washes out the effect.

    // Main sun — warm daylight angle
    const sun = new THREE.DirectionalLight(0xfff5e0, 2.0);
    sun.position.set(600, 1000, 400);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near   = 10;
    sun.shadow.camera.far    = 5000;
    sun.shadow.camera.left   = -1500;
    sun.shadow.camera.right  =  1500;
    sun.shadow.camera.top    =  1500;
    sun.shadow.camera.bottom = -1500;
    sun.shadow.bias = -0.0003;
    this.scene.add(sun);
    this.sun = sun; // expose for future day/night cycle

    // Soft sky ambient — anime scenes have a coloured ambient from the sky
    const ambient = new THREE.AmbientLight(0x6080c0, 0.5);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    // Cool rim/fill from opposite side — gives the characteristic anime
    // blue-shadow look on building faces away from the sun
    const rim = new THREE.DirectionalLight(0x4060a0, 0.6);
    rim.position.set(-400, 300, -500);
    this.scene.add(rim);
  }

  // ── Render loop ─────────────────────────────────────────────
  start() {
    this.init();
    const animate = () => {
      requestAnimationFrame(animate);
      this.controls.update();

      // Animate water UV offset for gentle flow effect
      const t = this._clock.getElapsedTime();
      this._objects.forEach(group => {
        group.traverse(child => {
          if (child.isMesh && child.userData.isWater) {
            const mat = child.material;
            if (mat && mat.map) {
              mat.map.offset.set(t * 0.012, t * 0.006);
              mat.map.needsUpdate = true;
            }
          }
        });
      });

      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  // ── Satellite ground texture ─────────────────────────────────
  // Called by WorldBuilder once the tile fetch resolves.
  // Scales the texture so one unit = one metre on the ground plane.
  setGroundTexture(tex, radiusMeters) {
    if (!this._groundMesh) return;

    // The ground plane is 6000×6000 units.
    // The satellite composite covers 3 tiles wide. At the chosen zoom the
    // tile covers roughly 2×radiusMeters in world space, so the 3-tile
    // composite covers ~6×radiusMeters. We scale the UV repeat so the
    // texture exactly fills the 6000-unit plane.
    const planeSize   = 6000;
    const coverageM   = radiusMeters * 6;
    const repeat      = planeSize / coverageM;

    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(repeat, repeat);
    tex.center.set(0.5, 0.5);
    tex.needsUpdate = true;

    this._groundMesh.material.map     = tex;
    this._groundMesh.material.color.set(0xffffff); // let texture show through
    this._groundMesh.material.needsUpdate = true;
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

    // Reset ground to plain colour while next satellite tile loads
    if (this._groundMesh) {
      if (this._groundMesh.material.map) {
        this._groundMesh.material.map.dispose();
        this._groundMesh.material.map = null;
      }
      this._groundMesh.material.color.set(0x3a4a30);
      this._groundMesh.material.needsUpdate = true;
    }
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
        if (!child.isMesh)               return;
        if (child.userData.isGround)     return;

        const mats = Array.isArray(child.material)
          ? child.material
          : [child.material];

        mats.forEach(mat => {
          if (mode === 'wireframe') {
            mat.wireframe   = true;
            mat.transparent = false;
            mat.opacity     = 1;
          } else if (mode === 'xray') {
            mat.wireframe   = false;
            mat.transparent = true;
            mat.opacity     = 0.35;
          } else {
            mat.wireframe   = false;
            mat.transparent = child.userData.isWater;
            mat.opacity     = child.userData.isWater ? 0.88 : 1;
          }
        });
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
