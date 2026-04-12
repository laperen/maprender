// js/scene.js — Three.js scene, camera, renderer, lights, controls
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { OrbitControlsImpl } from './orbitControls.js';

export class SceneManager {
  constructor(container) {
    this.container   = container;
    this.renderMode  = 'solid';
    this._objects    = [];
    this._clock      = new THREE.Clock();
    this._groundMesh = null;
    this._fpsFrames   = 0;
    this._fpsLastTime = performance.now();
    this._fpsEl       = null;
    this._sky         = null;
    this._sun         = null;
  }

  init() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled  = true;
    this.renderer.shadowMap.type     = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping        = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.5;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 20000);
    this.camera.position.set(0, 600, 1200);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControlsImpl(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.minDistance   = 50;
    this.controls.maxDistance   = 8000;

    this._initSky();
    this._addLights();

    // Flat placeholder — replaced by buildElevationGround()
    const groundGeo = new THREE.PlaneGeometry(6000, 6000);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x4a7a40 });
    this._groundMesh = new THREE.Mesh(groundGeo, groundMat);
    this._groundMesh.rotation.x       = -Math.PI / 2;
    this._groundMesh.receiveShadow    = true;
    this._groundMesh.userData.isGround = true;
    this.scene.add(this._groundMesh);

    this._createFPSCounter();

    this.raycaster  = new THREE.Raycaster();
    this.mouseNDC   = new THREE.Vector2();
    this._pickables = [];

    window.addEventListener('resize', () => this._onResize());
  }

  // ── Sky setup ─────────────────────────────────────────────────
  _initSky() {
    const sky  = new Sky();
    sky.scale.setScalar(450000);
    this.scene.add(sky);
    this._sky = sky;

    const uniforms = sky.material.uniforms;
    uniforms['turbidity'].value       = 10;
    uniforms['rayleigh'].value        = 2;
    uniforms['mieCoefficient'].value  = 0.005;
    uniforms['mieDirectionalG'].value = 0.8;

    // Default sun: elevation ~15°, azimuth ~135° (south-east) ≈ 10:00
    this._sunElevationDeg = 45;
    this._sunAzimuthDeg   = 135;
    this._applySunPosition();
  }

  // ── Public: update sun from elevation + azimuth degrees ───────
  setSunAngles(elevationDeg, azimuthDeg) {
    this._sunElevationDeg = elevationDeg;
    this._sunAzimuthDeg   = azimuthDeg;
    this._applySunPosition();
  }

  // ── Public: update sun from a time-of-day (0–24 h) ───────────
  // Simple analogue: hour maps to a sun arc across the sky.
  // elevation peaks at noon, azimuth sweeps east→west.
  setSunFromTime(hour) {
    // hour in [0, 24]
    const t = hour / 24; // 0–1

    // Elevation: sine arc, rises at 6h, peaks at 12h, sets at 18h
    // Give it a small negative floor so night is clearly dark.
    const sunriseH = 6, sunsetH = 18;
    const dayFrac  = (hour - sunriseH) / (sunsetH - sunriseH); // 0..1 during day
    let elevDeg;
    if (hour <= sunriseH || hour >= sunsetH) {
      elevDeg = -10; // below horizon → night
    } else {
      elevDeg = Math.sin(dayFrac * Math.PI) * 75; // 0° at sunrise/set, 75° at noon
    }

    // Azimuth: 90° (east) at sunrise → 180° (south) at noon → 270° (west) at sunset
    const azDeg = sunriseH <= hour && hour <= sunsetH
      ? 90 + dayFrac * 180
      : (hour < sunriseH ? 90 : 270);

    this.setSunAngles(elevDeg, azDeg);
    return { elevationDeg: elevDeg, azimuthDeg: azDeg };
  }

  _applySunPosition() {
    const elevRad = THREE.MathUtils.degToRad(this._sunElevationDeg);
    const aziRad  = THREE.MathUtils.degToRad(this._sunAzimuthDeg);

    // Standard spherical → cartesian (Y-up, Z-south)
    const sinElev = Math.sin(elevRad);
    const cosElev = Math.cos(elevRad);
    const sunPos  = new THREE.Vector3(
      cosElev * Math.sin(aziRad),
      sinElev,
      cosElev * Math.cos(aziRad)
    );

    // Update sky shader
    if (this._sky) {
      const uniforms = this._sky.material.uniforms;
      uniforms['sunPosition'].value.copy(sunPos);

      // Adjust sky atmosphere params based on sun height
      const t = Math.max(0, this._sunElevationDeg) / 75; // 0 = horizon, 1 = noon
      uniforms['rayleigh'].value  = 0.5 + t * 2.5;  // more blue scattering at noon
      uniforms['turbidity'].value = 4 + (1 - t) * 8; // hazier near horizon

      // Mie scattering: stronger near horizon for golden hour glow
      uniforms['mieCoefficient'].value  = 0.002 + (1 - t) * 0.025;
      uniforms['mieDirectionalG'].value = 0.7 + t * 0.2;
    }

    // Update directional light
    if (this.sun) {
      const dist = 1000;
      this.sun.position.set(
        sunPos.x * dist,
        sunPos.y * dist,
        sunPos.z * dist
      );

      // Night/sunset colour transitions
      const elevClamped = Math.max(-10, Math.min(75, this._sunElevationDeg));
      const tLight      = Math.max(0, elevClamped) / 75;
      const tHorizon    = 1 - Math.abs(elevClamped) / 75;

      // Noon: warm white. Horizon: deep orange. Night: off.
      const intensity = elevClamped <= 0 ? 0 : 0.4 + tLight * 2.6;

      // Interpolate colour: orange (horizon) → warm white (noon)
      const r = 1.0;
      const g = 0.6 + tLight * 0.38;
      const b = 0.3 + tLight * 0.58;
      this.sun.color.setRGB(r, g, b);
      this.sun.intensity = intensity;

      // Ambient: cool blue at noon, dim warm at dusk, nearly off at night
      if (this.ambientLight) {
        const aIntensity = elevClamped <= 0
          ? 0.05
          : 0.2 + tLight * 0.4;
        const aR = 0.5 + tLight * 0.2;
        const aG = 0.6 + tLight * 0.1;
        const aB = 0.8 + tLight * 0.1;
        this.ambientLight.color.setRGB(aR, aG, aB);
        this.ambientLight.intensity = aIntensity;
      }
    }

    // Exposure: brighter at noon, darker at dusk/night
    if (this.renderer) {
      const elevC = Math.max(-10, Math.min(75, this._sunElevationDeg));
      const tExp  = Math.max(0, elevC) / 75;
      this.renderer.toneMappingExposure = 0.15 + tExp * 0.45;
    }
  }

  _addLights() {
    const dist = 1000;
    const sunPos = new THREE.Vector3(
      Math.cos(THREE.MathUtils.degToRad(this._sunElevationDeg)) * Math.sin(THREE.MathUtils.degToRad(this._sunAzimuthDeg)),
      Math.sin(THREE.MathUtils.degToRad(this._sunElevationDeg)),
      Math.cos(THREE.MathUtils.degToRad(this._sunElevationDeg)) * Math.cos(THREE.MathUtils.degToRad(this._sunAzimuthDeg))
    );

    const sun = new THREE.DirectionalLight(0xfff5e0, 3.0);
    sun.position.set(sunPos.x * dist, sunPos.y * dist, sunPos.z * dist);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near   = 10;
    sun.shadow.camera.far    = 3000;
    sun.shadow.camera.left   = -800;
    sun.shadow.camera.right  =  800;
    sun.shadow.camera.top    =  800;
    sun.shadow.camera.bottom = -800;
    sun.shadow.bias = -0.0003;
    this.scene.add(sun);
    this.sun = sun;

    const ambient = new THREE.AmbientLight(0x90b0d8, 0.5);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    const rim = new THREE.DirectionalLight(0x4878c0, 0.4);
    rim.position.set(-400, 300, -500);
    this.scene.add(rim);
  }

  _fitShadowFrustum(radiusMeters) {
    const r = Math.min(radiusMeters * 1.2, 2000);
    this.sun.shadow.camera.left   = -r;
    this.sun.shadow.camera.right  =  r;
    this.sun.shadow.camera.top    =  r;
    this.sun.shadow.camera.bottom = -r;
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  _createFPSCounter() {
    const el = document.createElement('div');
    el.id = 'fps-counter';
    Object.assign(el.style, {
      position: 'fixed', top: '12px', right: '12px',
      background: 'rgba(8,9,12,0.75)', color: '#4fffb0',
      fontFamily: "'Space Mono', monospace", fontSize: '12px',
      fontWeight: '700', padding: '4px 10px', borderRadius: '4px',
      border: '1px solid #1e2130', zIndex: '100',
      pointerEvents: 'none', letterSpacing: '0.05em',
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

  // ── Point-in-polygon (ray casting in XZ) ─────────────────────
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

  // ── Elevation ground mesh ─────────────────────────────────────
  buildElevationGround(elevFn, gridSize, radiusMeters, buildingFootprints = []) {
    if (this._groundMesh) {
      this.scene.remove(this._groundMesh);
      this._groundMesh.geometry.dispose();
      this._groundMesh.material.dispose();
      this._groundMesh = null;
    }

    const segs   = gridSize - 1;
    const extent = radiusMeters * 2;
    const geo    = new THREE.PlaneGeometry(extent, extent, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      let y   = elevFn(x, z);

      for (const { verts, baseY } of buildingFootprints) {
        if (this._pointInPoly(x, z, verts)) {
          y = Math.min(y, baseY);
          break;
        }
      }

      pos.setY(i, y);
    }

    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mat  = new THREE.MeshLambertMaterial({ color: 0x4a7a40 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow     = true;
    mesh.userData.isGround = true;
    this.scene.add(mesh);
    this._groundMesh = mesh;

    this._fitShadowFrustum(radiusMeters);
  }

  // ── Expose terrain mesh for BVH raycasting ───────────────────
  getTerrainMesh() {
    return this._groundMesh;
  }

  // ── Satellite ground texture ──────────────────────────────────
  setGroundTexture(tex) {
    if (!this._groundMesh) return;
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
