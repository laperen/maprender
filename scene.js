// js/scene.js — Three.js scene, camera, renderer, lights, controls
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { OrbitControlsImpl } from './orbitControls.js';

// ── Night-sky constants ───────────────────────────────────────
const STAR_COUNT    = 3000;
const STAR_SPHERE_R = 8000;   // must be < camera.far (20000)
const MOON_DIST     = 7500;   // distance from origin for moon sprite
const MOON_SIZE     = 320;    // world-units diameter of moon sprite

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

    // Night-layer references — all start invisible (phase = 0)
    this._moonLight    = null;   // DirectionalLight
    this._moonSprite   = null;   // Sprite
    this._starPoints   = null;   // Points
    this._nightAmbient = null;   // AmbientLight
    this._nightPhase   = 0;      // 0 = full day, 1 = full night
    this._starTime     = 0;      // accumulator for twinkle animation

    // Street-lamp emissive meshes registered by WorldBuilder
    this._lampMeshes   = [];
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
    this._initNightLayer();

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

  // ── Sky setup (unchanged) ─────────────────────────────────────
  _initSky() {
    const sky = new Sky();
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
  }

  // ── Day lights (unchanged) ────────────────────────────────────
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

    this.scene.add(new THREE.AmbientLight(0x90b0d8, 0.5));

    const rim = new THREE.DirectionalLight(0x4878c0, 0.4);
    rim.position.set(-400, 300, -500);
    this.scene.add(rim);
  }

  // ── Night layer: moon, stars, night ambient ───────────────────
  // All objects start at opacity/intensity 0 and are driven by
  // setTimeOfDay(). Day lights above are never touched here.
  _initNightLayer() {
    // Moon placed opposite the sun, elevated above horizon
    const moonPhi   = THREE.MathUtils.degToRad(90 - 40); // 40° elevation
    const moonTheta = THREE.MathUtils.degToRad(135 + 180); // opposite azimuth
    const moonDir   = new THREE.Vector3();
    moonDir.setFromSphericalCoords(1, moonPhi, moonTheta);
    this._moonDirection = moonDir.clone();

    // Moon directional light — blue-white, starts invisible
    this._moonLight = new THREE.DirectionalLight(0xc8d8ff, 0);
    this._moonLight.position.copy(moonDir.clone().multiplyScalar(1000));
    this.scene.add(this._moonLight);

    // Night ambient — deep indigo, starts invisible
    this._nightAmbient = new THREE.AmbientLight(0x0a1835, 0);
    this.scene.add(this._nightAmbient);

    // Moon sprite
    const moonTex = new THREE.CanvasTexture(this._makeMoonCanvas(256));
    const moonMat = new THREE.SpriteMaterial({
      map:         moonTex,
      transparent: true,
      opacity:     0,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });
    this._moonSprite = new THREE.Sprite(moonMat);
    this._moonSprite.scale.set(MOON_SIZE, MOON_SIZE, 1);

    // Place moon along its direction vector, ensuring it's above horizon
    const moonPos = moonDir.clone().multiplyScalar(MOON_DIST);
    if (moonPos.y < MOON_DIST * 0.15) moonPos.y = MOON_DIST * 0.15;
    this._moonSprite.position.copy(moonPos);
    this.scene.add(this._moonSprite);

    // Stars
    this._starPoints = this._makeStars();
    this.scene.add(this._starPoints);
  }

  // ── Moon canvas (glowing disc with subtle craters) ────────────
  _makeMoonCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2, cy = size / 2, r = size * 0.38;

    // Outer atmospheric glow
    const glow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 2.0);
    glow.addColorStop(0,   'rgba(200,220,255,0.15)');
    glow.addColorStop(1,   'rgba(200,220,255,0.0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // Moon disc — off-white with slight blue tint on limb
    const disc = ctx.createRadialGradient(
      cx - r * 0.18, cy - r * 0.18, r * 0.05,
      cx, cy, r
    );
    disc.addColorStop(0,    '#ffffff');
    disc.addColorStop(0.55, '#dde8ff');
    disc.addColorStop(1,    '#a8bce8');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = disc;
    ctx.fill();

    // Subtle craters
    const craters = [
      { x: 0.30, y: 0.25, r: 0.09 },
      { x: 0.62, y: 0.52, r: 0.06 },
      { x: 0.42, y: 0.66, r: 0.045 },
      { x: 0.66, y: 0.30, r: 0.055 },
      { x: 0.52, y: 0.38, r: 0.035 },
    ];
    for (const c of craters) {
      const ox = cx + (c.x - 0.5) * 2 * r;
      const oy = cy + (c.y - 0.5) * 2 * r;
      const cr = c.r * r;
      const cg = ctx.createRadialGradient(ox, oy, 0, ox, oy, cr);
      cg.addColorStop(0,   'rgba(150,170,210,0.25)');
      cg.addColorStop(1,   'rgba(150,170,210,0.0)');
      ctx.beginPath();
      ctx.arc(ox, oy, cr, 0, Math.PI * 2);
      ctx.fillStyle = cg;
      ctx.fill();
    }

    return canvas;
  }

  // ── Stars (Points on a sphere) ────────────────────────────────
  _makeStars() {
    const positions = new Float32Array(STAR_COUNT * 3);
    const sizes     = new Float32Array(STAR_COUNT);
    const alphas    = new Float32Array(STAR_COUNT);

    const v = new THREE.Vector3();
    for (let i = 0; i < STAR_COUNT; i++) {
      // Distribute across upper hemisphere + a bit below for camera tilt
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(1 - Math.random() * 1.65); // 0..~115° from zenith
      v.setFromSphericalCoords(STAR_SPHERE_R, phi, theta);
      positions[i * 3]     = v.x;
      positions[i * 3 + 1] = Math.max(v.y, STAR_SPHERE_R * 0.06);
      positions[i * 3 + 2] = v.z;
      // Randomise size: most small, few bright
      sizes[i]  = Math.random() < 0.07
        ? 2.5 + Math.random() * 1.5   // bright star
        : 0.6 + Math.random() * 1.8;  // normal star
      alphas[i] = 0.4 + Math.random() * 0.6;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes,     1));
    geo.setAttribute('aAlpha',   new THREE.BufferAttribute(alphas,    1));

    // Small radial-gradient sprite for each point
    const starCanvas = document.createElement('canvas');
    starCanvas.width = starCanvas.height = 32;
    const sc = starCanvas.getContext('2d');
    const sg = sc.createRadialGradient(16, 16, 0, 16, 16, 16);
    sg.addColorStop(0,    'rgba(255,255,255,1)');
    sg.addColorStop(0.3,  'rgba(220,235,255,0.7)');
    sg.addColorStop(1,    'rgba(200,220,255,0)');
    sc.fillStyle = sg;
    sc.fillRect(0, 0, 32, 32);
    const starTex = new THREE.CanvasTexture(starCanvas);

    // ShaderMaterial so we can drive per-star twinkle via uniforms
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uNightPhase: { value: 0.0 },
        uTime:       { value: 0.0 },
        uMap:        { value: starTex },
      },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute float aAlpha;
        varying   float vAlpha;

        uniform float uNightPhase;
        uniform float uTime;

        void main() {
          // Per-star hash drives a unique twinkle frequency
          float hash    = fract(sin(dot(position.xy, vec2(12.9898, 78.233))) * 43758.5453);
          float twinkle = 0.75 + 0.25 * sin(uTime * (1.2 + hash * 1.8) + hash * 6.2832);
          vAlpha        = aAlpha * uNightPhase * twinkle;

          vec4 mvPos    = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize  = aSize * (700.0 / -mvPos.z);
          gl_Position   = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying float vAlpha;

        void main() {
          vec4 col     = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(col.rgb, col.a * vAlpha);
          if (gl_FragColor.a < 0.01) discard;
        }
      `,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    points.renderOrder = -1;
    return points;
  }

  // ── setTimeOfDay ──────────────────────────────────────────────
  // t = 0 → full day (existing lights unchanged, night layer invisible)
  // t = 1 → full night (night layer fully visible)
  // Existing sun / sky / day ambient / rim lights are NEVER modified.
  setTimeOfDay(t) {
    // Smooth S-curve so transition happens in the middle third of the slider
    const phase = THREE.MathUtils.clamp(
      THREE.MathUtils.smoothstep(t, 0.28, 0.65),
      0, 1
    );
    this._nightPhase = phase;

    // Moon light: peak 0.35 intensity at full night
    if (this._moonLight) {
      this._moonLight.intensity = phase * 0.35;
    }

    // Night ambient: peak 0.65 intensity — keeps shadows readable
    if (this._nightAmbient) {
      this._nightAmbient.intensity = phase * 0.65;
    }

    // Moon sprite opacity
    if (this._moonSprite) {
      this._moonSprite.material.opacity = phase;
    }

    // Stars driven per-frame in _tickNight via shader uniform
    if (this._starPoints) {
      this._starPoints.material.uniforms.uNightPhase.value = phase;
    }

    // Street lamp glow — globes use emissiveIntensity, halos use opacity
    for (const mesh of this._lampMeshes) {
      const mat = mesh.material;
      if (mesh.userData.isLampGlobe) {
        // MeshLambertMaterial with emissive colour
        mat.emissiveIntensity = phase;
      } else if (mesh.userData.isLampHalo) {
        // MeshBasicMaterial — drive opacity directly
        mat.opacity = phase * 0.85;
        mat.needsUpdate = true;
      }
    }

    // Night fog — fades in toward midnight, absent at day
    if (phase > 0.01) {
      if (!this.scene.fog) {
        this.scene.fog = new THREE.Fog(0x050a18, 3000, 14000);
      }
      const fogColor = new THREE.Color().lerpColors(
        new THREE.Color(0x000000),
        new THREE.Color(0x050a18),
        phase
      );
      this.scene.fog.color.copy(fogColor);
      this.scene.fog.near = THREE.MathUtils.lerp(5000, 600,  phase);
      this.scene.fog.far  = THREE.MathUtils.lerp(14000, 5000, phase);
    } else {
      this.scene.fog = null;
    }
  }

  // ── Register lamp meshes so setTimeOfDay can drive their glow ─
  registerLampMeshes(meshes) {
    this._lampMeshes.push(...meshes);
  }

  // ── Tick night uniforms (called every frame) ──────────────────
  _tickNight(dt) {
    if (!this._starPoints) return;
    this._starTime += dt;
    this._starPoints.material.uniforms.uTime.value = this._starTime;
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
      this._tickNight(dt);
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
    this._objects    = [];
    this._pickables  = [];
    this._lampMeshes = [];

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
