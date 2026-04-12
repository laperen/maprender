// js/scene.js — Three.js scene, camera, renderer, lights, controls
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { OrbitControlsImpl } from './orbitControls.js';

// ── Day/night tuning constants ─────────────────────────────────
// dayPhase: 0.0 = solar noon, 1.0 = midnight (wraps)
// Sun is below horizon for dayPhase roughly 0.25–0.75.

const STAR_COUNT = 3000;

// How far the star sphere sits from the camera (world units).
// Must be < camera.far (20000). We place it just inside far plane.
const STAR_RADIUS = 18000;

// Lamp post spacing along road centrelines (metres)
export const LAMP_SPACING = 35;

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

    // Night-sky objects
    this._moonLight    = null;   // DirectionalLight (blue-white, dim)
    this._moonSprite   = null;   // Sprite canvas disc
    this._starPoints   = null;   // THREE.Points
    this._starTime     = 0;      // accumulated seconds for twinkle

    // day/night phase — exposed so ui.js can read it
    this.dayPhase      = 0;      // 0 = noon, 1 = midnight

    // Street lamp groups added by WorldBuilder
    this._lampGroup    = null;
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
    this._initMoon();
    this._initStars();

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

    // Sun position: elevation ~15°, azimuth ~135° (south-east)
    const phi   = THREE.MathUtils.degToRad(90 - 15);
    const theta = THREE.MathUtils.degToRad(135);

    const sunPos = new THREE.Vector3();
    sunPos.setFromSphericalCoords(1, phi, theta);
    uniforms['sunPosition'].value.copy(sunPos);

    this._sunDirection = sunPos.clone().normalize();

    // Moon direction is directly opposite the sun in XZ, slightly elevated
    this._moonDirection = new THREE.Vector3(
      -this._sunDirection.x,
       0.25,
      -this._sunDirection.z,
    ).normalize();
  }

  _addLights() {
    const dist = 1000;
    const dir  = this._sunDirection;

    const sun = new THREE.DirectionalLight(0xfff5e0, 3.0);
    sun.position.set(dir.x * dist, dir.y * dist, dir.z * dist);
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

    this._ambient = new THREE.AmbientLight(0x90b0d8, 0.5);
    this.scene.add(this._ambient);

    this._rim = new THREE.DirectionalLight(0x4878c0, 0.4);
    this._rim.position.set(-400, 300, -500);
    this.scene.add(this._rim);
  }

  // ── Moon: sprite disc + directional light ─────────────────────
  _initMoon() {
    // Directional light from moon direction
    const ml = new THREE.DirectionalLight(0xc8d8ff, 0);   // starts off
    const md = this._moonDirection;
    ml.position.set(md.x * 1000, md.y * 1000, md.z * 1000);
    this.scene.add(ml);
    this._moonLight = ml;

    // Canvas disc for the sprite
    const size   = 128;
    const canvas = document.createElement('canvas');
    canvas.width  = size;
    canvas.height = size;
    const ctx    = canvas.getContext('2d');
    const cx     = size / 2;

    // Outer glow
    const glow = ctx.createRadialGradient(cx, cx, cx * 0.45, cx, cx, cx);
    glow.addColorStop(0,   'rgba(220,235,255,0.18)');
    glow.addColorStop(1,   'rgba(220,235,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // Moon disc
    const disc = ctx.createRadialGradient(cx * 0.9, cx * 0.85, 1, cx, cx, cx * 0.45);
    disc.addColorStop(0,   '#f0f4ff');
    disc.addColorStop(0.6, '#d8e4f8');
    disc.addColorStop(1,   '#b0c4e8');
    ctx.beginPath();
    ctx.arc(cx, cx, cx * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = disc;
    ctx.fill();

    const tex    = new THREE.CanvasTexture(canvas);
    const mat    = new THREE.SpriteMaterial({
      map:         tex,
      transparent: true,
      opacity:     0,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(mat);

    // Place sprite along moon direction at sky distance
    const moonDist = STAR_RADIUS * 0.92;
    sprite.position.set(
      md.x * moonDist,
      md.y * moonDist,
      md.z * moonDist,
    );
    sprite.scale.setScalar(moonDist * 0.08);   // ~8% of sky radius
    this.scene.add(sprite);
    this._moonSprite = sprite;
  }

  // ── Stars: Points on a sphere ──────────────────────────────────
  _initStars() {
    const positions = new Float32Array(STAR_COUNT * 3);
    const sizes     = new Float32Array(STAR_COUNT);

    // Seeded-like but deterministic — just use Math.random at init time,
    // it only runs once.
    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform distribution on sphere surface
      const u     = Math.random() * 2 - 1;         // cos(polar)
      const phi   = Math.random() * Math.PI * 2;
      const r     = Math.sqrt(1 - u * u);
      const x     = r * Math.cos(phi) * STAR_RADIUS;
      const y     = u * STAR_RADIUS;
      const z     = r * Math.sin(phi) * STAR_RADIUS;
      positions[i * 3]     = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      // Random base size 1–3.5
      sizes[i] = 1.0 + Math.random() * 2.5;
    }

    // Star sprite canvas: soft glowing dot
    const sc  = document.createElement('canvas');
    sc.width  = 32;
    sc.height = 32;
    const sCtx = sc.getContext('2d');
    const sg   = sCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
    sg.addColorStop(0,    'rgba(255,255,255,1)');
    sg.addColorStop(0.25, 'rgba(200,220,255,0.8)');
    sg.addColorStop(1,    'rgba(200,220,255,0)');
    sCtx.fillStyle = sg;
    sCtx.fillRect(0, 0, 32, 32);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('size',     new THREE.BufferAttribute(sizes,     1));

    // We drive twinkle by slightly randomising per-vertex opacity via a
    // custom shader. To keep dependencies minimal we use a standard
    // PointsMaterial and animate its overall opacity in _updateStarTwinkle.
    const mat = new THREE.PointsMaterial({
      color:       0xd0e0ff,
      size:        2.2,
      sizeAttenuation: false,   // fixed screen-space size — no depth scaling
      map:         new THREE.CanvasTexture(sc),
      transparent: true,
      opacity:     0,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    this._starPoints = new THREE.Points(geo, mat);
    // Stars live at world origin — they'll always be far away.
    // We recentre them on the camera each frame in the render loop
    // so they never go behind the far plane.
    this.scene.add(this._starPoints);
  }

  // ── Day/Night cycle driver ─────────────────────────────────────
  // t: 0.0 = solar noon  →  0.5 = midnight  →  1.0 = noon again
  // Convention: night = t ∈ [0.25, 0.75]
  setTimeOfDay(t) {
    this.dayPhase = t;

    // nightFactor: 0 at noon, 1 at midnight — smooth S-curve
    const raw         = Math.cos(t * Math.PI * 2);          // 1 at noon, -1 at midnight
    const nightFactor = (1 - raw) / 2;                      // 0 → 1

    // Smooth step for sharper dawn/dusk transitions
    const ns  = _smoothStep(0.35, 0.65, nightFactor);       // hard night ramp
    const ds  = 1 - ns;                                     // day fraction

    // ── Sun ─────────────────────────────────────────────────────
    // Drive the sun below the horizon smoothly using nightFactor.
    // At noon (nf=0) sun is at its day elevation; at night it goes below 0.
    const sunElevDeg  = 15 - nightFactor * 110;             // +15° → -95°
    const sunPhi      = THREE.MathUtils.degToRad(90 - sunElevDeg);
    const sunTheta    = THREE.MathUtils.degToRad(135);
    const sunPos      = new THREE.Vector3();
    sunPos.setFromSphericalCoords(1, sunPhi, sunTheta);
    this._sky.material.uniforms['sunPosition'].value.copy(sunPos);

    // Sky turbidity: hazy at day, crisp at night
    this._sky.material.uniforms['turbidity'].value      = _lerp(10, 0.5, ns);
    this._sky.material.uniforms['rayleigh'].value       = _lerp(2,  0.1, ns);
    this._sky.material.uniforms['mieCoefficient'].value = _lerp(0.005, 0.0005, ns);

    // Sun directional light intensity + colour
    this.sun.intensity = _lerp(3.0, 0, ds > 0 ? ds : 0);
    this.sun.position.set(sunPos.x * 1000, sunPos.y * 1000, sunPos.z * 1000);

    // ── Ambient ─────────────────────────────────────────────────
    // Day: warm blue-white. Night: deep indigo.
    const ambDay   = new THREE.Color(0x90b0d8);
    const ambNight = new THREE.Color(0x08101e);
    this._ambient.color.lerpColors(ambDay, ambNight, ns);
    this._ambient.intensity = _lerp(0.5, 0.18, ns);

    // Rim light fades out at night
    this._rim.intensity = _lerp(0.4, 0, ns);

    // Tone mapping exposure: brighter day, darker night
    this.renderer.toneMappingExposure = _lerp(0.5, 0.12, ns);

    // ── Moon ────────────────────────────────────────────────────
    const moonStrength = _smoothStep(0.35, 0.65, nightFactor);
    this._moonLight.intensity          = moonStrength * 0.18;
    this._moonSprite.material.opacity  = moonStrength;

    // ── Stars ───────────────────────────────────────────────────
    this._starPoints.material.opacity = moonStrength;

    // ── Lamp posts ──────────────────────────────────────────────
    if (this._lampGroup) {
      const lampStrength = _smoothStep(0.3, 0.55, nightFactor);
      this._lampGroup.traverse(child => {
        if (!child.isMesh) return;
        const m = child.material;
        if (m.emissive) {
          m.emissiveIntensity = child.userData.isGlow
            ? lampStrength * 0.85
            : lampStrength;
        }
        if (child.userData.isGlow) {
          m.opacity = 0.12 + lampStrength * 0.7;
        }
      });
    }
  }

  // ── Lamp group registration (called by WorldBuilder) ──────────
  registerLampGroup(group) {
    this._lampGroup = group;
  }

  // ── Per-frame star recentering + twinkle ──────────────────────
  _tickNightSky(dt) {
    if (!this._starPoints) return;

    // Keep star sphere centred on camera so stars never clip the far plane
    this._starPoints.position.copy(this.camera.position);

    // Gentle twinkle: vary opacity ±8 % with a slow sine
    this._starTime += dt;
    const base = this._starPoints.material.opacity;
    if (base > 0.01) {
      // We modulate size instead of opacity to avoid fighting setTimeOfDay
      // Do nothing per-frame here — size animation would need a shader.
      // As a cheap alternative: micro-wobble the overall opacity.
      // Only apply when stars are actually visible.
      this._starPoints.material.opacity =
        base * (0.93 + 0.07 * Math.sin(this._starTime * 1.3));
    }
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

  getTerrainMesh() {
    return this._groundMesh;
  }

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
      const dt = this._clock.getDelta();
      this.controls.update();
      this._tickNightSky(dt);
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
    this._lampGroup = null;

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
            mat.transparent = !!(child.userData.isWater || child.userData.isGlow);
            mat.opacity     = child.userData.isWater ? 0.85
                            : child.userData.isGlow  ? 0
                            : 1;
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

// ── Tiny math helpers ─────────────────────────────────────────
function _lerp(a, b, t)                    { return a + (b - a) * t; }
function _clamp(v, lo, hi)                 { return v < lo ? lo : v > hi ? hi : v; }
function _smoothStep(lo, hi, t) {
  const x = _clamp((t - lo) / (hi - lo), 0, 1);
  return x * x * (3 - 2 * x);
}
