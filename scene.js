// js/scene.js — Three.js scene, camera, renderer, lights, controls
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { OrbitControlsImpl } from './orbitControls.js';

// ── Night-sky constants ───────────────────────────────────────
const STAR_COUNT    = 3000;
const STAR_SPHERE_R = 8000;
const MOON_DIST     = 7500;
const MOON_SIZE     = 320;

export class SceneManager {
  constructor(container) {
    this.container   = container;
    this.renderMode  = 'solid';
    this._objects    = [];
    this._timer      = new THREE.Timer();
    this._groundMesh = null;
    this._fpsFrames   = 0;
    this._fpsLastTime = performance.now();
    this._fpsEl       = null;
    this._sky         = null;
    this._skyUniforms = null;

    // Day lights
    this.sun         = null;       // DirectionalLight (sun)
    this._dayAmbient = null;       // AmbientLight (sky bounce)
    this._rimLight   = null;       // DirectionalLight (fill)

    // Night-layer references
    this._moonLight    = null;
    this._moonSprite   = null;
    this._starPoints   = null;
    this._nightAmbient = null;
    this._nightPhase   = 0;
    this._starTime     = 0;
    this._lampMeshes   = [];

    // Current hour (0–24) cached for re-use
    this._currentHour  = 12;
  }

  init() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled  = true;
    this.renderer.shadowMap.type     = THREE.PCFShadowMap;
    this.renderer.toneMapping        = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.5;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 30000);
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

    // Flat placeholder ground
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
    const sky = new Sky();
    sky.scale.setScalar(450000);
    this.scene.add(sky);
    this._sky = sky;

    const uniforms = sky.material.uniforms;
    uniforms['turbidity'].value       = 10;
    uniforms['rayleigh'].value        = 2;
    uniforms['mieCoefficient'].value  = 0.005;
    uniforms['mieDirectionalG'].value = 0.8;
    this._skyUniforms = uniforms;

    // Initial sun position (noon, south-east azimuth)
    this._setSkyPosition(12);
  }

  // Compute sun world-space direction from hour (0–24) and push to sky shader
  _setSkyPosition(hour) {
    // Map 0–24h to an elevation angle:
    // Noon (12h) = 75° elevation; sunrise/sunset (~6/18h) = 0°; night = below horizon
    const normalised = (hour - 6) / 12; // 0 at 6am, 1 at noon, 2 at 6pm
    const elevDeg    = Math.max(-20, 75 * Math.sin(normalised * Math.PI));

    // Azimuth: sun travels from east (90°) at sunrise to west (270°) at sunset
    const aziFrac  = THREE.MathUtils.clamp(normalised, 0, 2) / 2; // 0..1 (E→W)
    const aziDeg   = 90 + aziFrac * 180;

    const phi   = THREE.MathUtils.degToRad(90 - elevDeg);
    const theta = THREE.MathUtils.degToRad(aziDeg);

    const sunPos = new THREE.Vector3();
    sunPos.setFromSphericalCoords(1, phi, theta);

    this._skyUniforms['sunPosition'].value.copy(sunPos);
    this._sunDirection = sunPos.clone().normalize();

    // Update Sky atmosphere tint for different times
    const isDay = elevDeg > 0;
    // Golden-hour turbidity bump
    const goldenHour = 1 - Math.abs(normalised - 1); // peaks at 1 near 6/18h
    const turbidity  = isDay
      ? THREE.MathUtils.lerp(8, 18, Math.pow(Math.max(0, goldenHour - 0.7) / 0.3, 2))
      : 2;
    const rayleigh   = isDay
      ? THREE.MathUtils.lerp(1.5, 4, Math.pow(Math.max(0, goldenHour - 0.7) / 0.3, 2))
      : 0.1;
    this._skyUniforms['turbidity'].value = turbidity;
    this._skyUniforms['rayleigh'].value  = rayleigh;

    return sunPos;
  }

  // ── Day lights ────────────────────────────────────────────────
  _addLights() {
    const dist = 1000;
    // Placeholder direction; _setSkyPosition updates it
    const dir  = new THREE.Vector3(0.5, 0.7, -0.3).normalize();

    this.sun = new THREE.DirectionalLight(0xfff5e0, 3.0);
    this.sun.position.set(dir.x * dist, dir.y * dist, dir.z * dist);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near   = 10;
    this.sun.shadow.camera.far    = 3000;
    this.sun.shadow.camera.left   = -800;
    this.sun.shadow.camera.right  =  800;
    this.sun.shadow.camera.top    =  800;
    this.sun.shadow.camera.bottom = -800;
    this.sun.shadow.bias = -0.0003;
    this.scene.add(this.sun);

    this._dayAmbient = new THREE.AmbientLight(0x90b0d8, 0.5);
    this.scene.add(this._dayAmbient);

    this._rimLight = new THREE.DirectionalLight(0x4878c0, 0.4);
    this._rimLight.position.set(-400, 300, -500);
    this.scene.add(this._rimLight);
  }

  // ── Night layer ───────────────────────────────────────────────
  _initNightLayer() {
    // Moon sits opposite the sun, 50° above horizon
    const moonPhi   = THREE.MathUtils.degToRad(90 - 50);
    const moonTheta = THREE.MathUtils.degToRad(135 + 180);
    const moonDir   = new THREE.Vector3();
    moonDir.setFromSphericalCoords(1, moonPhi, moonTheta);
    this._moonDirection = moonDir.clone();

    // Moon directional light — blue-white, starts at 0 intensity
    this._moonLight = new THREE.DirectionalLight(0xc8d8ff, 0);
    this._moonLight.position.copy(moonDir.clone().multiplyScalar(1000));
    this._moonLight.castShadow = false; // soft moonlight, no hard shadows
    this.scene.add(this._moonLight);

    // Night ambient — deep indigo, starts at 0
    this._nightAmbient = new THREE.AmbientLight(0x0a1835, 0);
    this.scene.add(this._nightAmbient);

    // ── Moon mesh — emissive sphere, always self-lit ───────────
    // A Sprite with AdditiveBlending is invisible against a dark sky.
    // Using MeshBasicMaterial (unlit, ignores scene lights) with a
    // canvas texture means the moon is always its own colour regardless
    // of scene lighting, and NormalBlending composites it cleanly.
    const moonTex = new THREE.CanvasTexture(this._makeMoonCanvas(512));
    const moonGeo = new THREE.SphereGeometry(MOON_SIZE * 0.5, 32, 32);
    const moonMat = new THREE.MeshBasicMaterial({
      map:         moonTex,
      transparent: true,
      opacity:     0,           // driven by setTimeOfDay
      depthWrite:  false,
      depthTest:   true,        // buildings correctly occlude moon
      blending:    THREE.NormalBlending,
    });
    this._moonMesh = new THREE.Mesh(moonGeo, moonMat);
    this._moonMesh.renderOrder    = 0;  // same as geometry; depthTest:false means it paints over sky bg
    this._moonMesh.frustumCulled  = false; // always render — repositioned each frame

    // Position updated each frame in _tickNight (camera-relative)
    this._moonMesh.position.set(0, MOON_DIST * 0.3, -MOON_DIST * 0.4);
    this.scene.add(this._moonMesh);

    // Atmospheric glow halo around moon (separate plane, additive)
    const haloSize = MOON_SIZE * 2.2;
    const haloGeo  = new THREE.PlaneGeometry(haloSize, haloSize);
    const haloTex  = new THREE.CanvasTexture(this._makeMoonHaloCanvas(128));
    const haloMat  = new THREE.MeshBasicMaterial({
      map:        haloTex,
      transparent: true,
      opacity:    0,
      depthWrite: false,
      depthTest:  false,
      blending:   THREE.AdditiveBlending,
    });
    this._moonHalo = new THREE.Mesh(haloGeo, haloMat);
    this._moonHalo.renderOrder   = -1; // draws before geometry (stars also at -1, both are sky bg)
    this._moonHalo.frustumCulled = false; // always render
    // Position updated each frame in _tickNight (synced to moon)
    this._moonHalo.position.set(0, MOON_DIST * 0.3, -MOON_DIST * 0.4);
    this.scene.add(this._moonHalo);

    // ── Stars ─────────────────────────────────────────────────
    this._starPoints = this._makeStars();
    this._starPoints.frustumCulled = false; // always render — bounding sphere is huge
    this.scene.add(this._starPoints);
  }

  // ── Moon halo canvas (soft glow ring) ────────────────────────
  _makeMoonHaloCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const grd = ctx.createRadialGradient(cx, cy, size * 0.12, cx, cy, size * 0.5);
    grd.addColorStop(0,   'rgba(180,210,255,0.35)');
    grd.addColorStop(0.4, 'rgba(160,200,255,0.12)');
    grd.addColorStop(1,   'rgba(140,180,255,0.0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);
    return canvas;
  }

  // ── Moon canvas ───────────────────────────────────────────────
  _makeMoonCanvas(size) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cx = size / 2, cy = size / 2, r = size * 0.38;

    const glow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 2.0);
    glow.addColorStop(0, 'rgba(200,220,255,0.15)');
    glow.addColorStop(1, 'rgba(200,220,255,0.0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    const disc = ctx.createRadialGradient(cx - r * 0.18, cy - r * 0.18, r * 0.05, cx, cy, r);
    disc.addColorStop(0,    '#ffffff');
    disc.addColorStop(0.55, '#dde8ff');
    disc.addColorStop(1,    '#a8bce8');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = disc;
    ctx.fill();

    const craters = [
      { x: 0.30, y: 0.25, r: 0.09 }, { x: 0.62, y: 0.52, r: 0.06 },
      { x: 0.42, y: 0.66, r: 0.045 }, { x: 0.66, y: 0.30, r: 0.055 },
      { x: 0.52, y: 0.38, r: 0.035 },
    ];
    for (const c of craters) {
      const ox = cx + (c.x - 0.5) * 2 * r, oy = cy + (c.y - 0.5) * 2 * r;
      const cr = c.r * r;
      const cg = ctx.createRadialGradient(ox, oy, 0, ox, oy, cr);
      cg.addColorStop(0, 'rgba(150,170,210,0.25)');
      cg.addColorStop(1, 'rgba(150,170,210,0.0)');
      ctx.beginPath();
      ctx.arc(ox, oy, cr, 0, Math.PI * 2);
      ctx.fillStyle = cg;
      ctx.fill();
    }
    return canvas;
  }

  // ── Stars ─────────────────────────────────────────────────────
  _makeStars() {
    const positions = new Float32Array(STAR_COUNT * 3);
    const sizes     = new Float32Array(STAR_COUNT);
    const alphas    = new Float32Array(STAR_COUNT);
    const v = new THREE.Vector3();
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      //const phi   = Math.acos(1 - Math.random() * 1.65);
      const phi = Math.acos(2 * Math.random() - 1);
      v.setFromSphericalCoords(STAR_SPHERE_R, phi, theta);
      positions[i * 3]     = v.x;
      positions[i * 3 + 1] = Math.max(v.y, STAR_SPHERE_R * 0.06);
      positions[i * 3 + 2] = v.z;
      sizes[i]  = Math.random() < 0.07
        ? 2.5 + Math.random() * 1.5 : 0.6 + Math.random() * 1.8;
      alphas[i] = 1;//0.4 + Math.random() * 0.6;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aAlpha',   new THREE.BufferAttribute(alphas, 1));

    const starCanvas = document.createElement('canvas');
    starCanvas.width = starCanvas.height = 32;
    const sc = starCanvas.getContext('2d');
    const sg = sc.createRadialGradient(16, 16, 0, 16, 16, 16);
    sg.addColorStop(0,   'rgba(255,255,255,1)');
    sg.addColorStop(0.3, 'rgba(220,235,255,0.7)');
    sg.addColorStop(1,   'rgba(200,220,255,0)');
    sc.fillStyle = sg;
    sc.fillRect(0, 0, 32, 32);
    const starTex = new THREE.CanvasTexture(starCanvas);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uNightPhase: { value: 0.0 },
        uTwinkle:    { value: 0.0 },
        uMap:        { value: starTex },
      },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute float aAlpha;
        varying   float vAlpha;
        uniform float uNightPhase;
        uniform float uTwinkle;
        void main() {
          float hash = fract(sin(dot(position.xy, vec2(12.9898, 78.233))) * 43758.5453);
          float twinkle = 0.80 + 0.20 * fract(uTwinkle + hash);
        
          vAlpha = aAlpha * uNightPhase * twinkle;
        
          // 1. FIRST: transform position to view space
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        
          // 2. THEN: projection
          gl_Position = projectionMatrix * mvPosition;
        
          // 3. IMPORTANT: size based on depth (distance attenuation)
          gl_PointSize = aSize * (300.0 / -mvPosition.z);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying float vAlpha;
        void main() {
          vec4 col = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(col.rgb, col.a * vAlpha);
          if (gl_FragColor.a < 0.01) discard;
        }
      `,
      transparent: true, depthWrite: true, blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    // renderOrder -1 — stars paint as a skybox background BEFORE all scene geometry.
    // Buildings and ground use renderOrder 0 (default) with depthTest:true so they
    // naturally overdraw the stars. depthTest:false on stars means they always paint
    // on the background pass regardless of depth buffer state — exactly what we want.
    points.material.depthTest = false;
    points.material.depthWrite = false; // keep this off
    points.renderOrder = -1;
    //points.material.depthTest  = false;
    //points.material.depthWrite = false;
    return points;
  }

  // ── setTimeOfDay — THE main integration point ─────────────────
  // hour: 0–24 (float). Drives sky, sun, moon, stars, lamps, fog.
  setTimeOfDay(hour) {
    this._currentHour = hour;

    // ── Sun elevation for this hour ───────────────────────────
    const sunPos = this._setSkyPosition(hour);

    // sunElevation: 1 = noon, 0 = horizon, negative = below
    const normalised  = (hour - 6) / 12; // 0 at 6am, 2 at 6pm
    const elevDeg     = Math.max(-20, 75 * Math.sin(normalised * Math.PI));
    const elevNorm    = THREE.MathUtils.clamp(elevDeg / 75, -0.267, 1); // -1..1 range clamped

    // sunDayPhase: 1 = full bright day, 0 = below horizon, smooth twilight band
    const sunDayPhase = THREE.MathUtils.clamp(
      THREE.MathUtils.smoothstep(elevNorm, -0.05, 0.18), 0, 1
    );

    // nightPhase: 1 = full night, 0 = full day
    const nightPhase = 1 - sunDayPhase;
    this._nightPhase = nightPhase;

    // ── Update sun directional light ──────────────────────────
    const dist = 1000;
    this.sun.position.set(
      this._sunDirection.x * dist,
      this._sunDirection.y * dist,
      this._sunDirection.z * dist,
    );

    // Colour transition: blue-white at noon → warm orange at golden hour → off at night
    const goldenFrac = THREE.MathUtils.clamp(1 - Math.abs(normalised - 1) / 0.3, 0, 1);
    const isGolden   = elevDeg > 0 && elevDeg < 22;
    const sunColor   = new THREE.Color();
    if (isGolden) {
      sunColor.lerpColors(new THREE.Color(0xff8830), new THREE.Color(0xfff5e0), elevDeg / 22);
    } else {
      sunColor.set(0xfff5e0);
    }
    this.sun.color.copy(sunColor);
    this.sun.intensity = sunDayPhase * 3.0;

    // Day ambient fades with sun
    if (this._dayAmbient) {
      this._dayAmbient.intensity = sunDayPhase * 0.5;
    }
    if (this._rimLight) {
      this._rimLight.intensity = sunDayPhase * 0.4;
    }

    // ── Night sky background ──────────────────────────────────
    // The Sky shader goes near-black when sun is below horizon. We layer a
    // deep navy scene.background that crossfades in as the sky goes dark,
    // giving a proper deep-blue night sky behind the stars and moon.
    if (nightPhase > 0.3) {
      const nightSkyColor = new THREE.Color().lerpColors(
        new THREE.Color(0x0a1428),  // deep midnight navy
        new THREE.Color(0x040810),  // near-black at full night
        Math.max(0, nightPhase - 0.5) * 2
      );
      // Blend from sky-shader to night colour
      this.scene.background = nightSkyColor;
      // Hide the Sky mesh so it doesn't occlude moon/stars through tone mapping
      if (this._sky) this._sky.visible = false;
    } else {
      this.scene.background = null; // let Sky shader render normally
      if (this._sky) this._sky.visible = true;
    }

    // ── Moon light & ambient ───────────────────────────────────
    // Moonlight intensity must be meaningful against a dark scene.
    // toneMappingExposure at night is kept at 0.45 (see below) so
    // these raw intensities translate to visible illumination.
    if (this._moonLight) {
      this._moonLight.intensity = nightPhase * 1.2;   // blue-white directional
    }
    if (this._nightAmbient) {
      // Colour: mid-blue so night scenes have a cool ambient fill
      this._nightAmbient.color.set(0x1a3a6a);
      this._nightAmbient.intensity = nightPhase * 0.8;
    }
    // Moon mesh and halo fade in with night
    if (this._moonMesh) this._moonMesh.material.opacity = nightPhase;
    if (this._moonHalo) this._moonHalo.material.opacity = nightPhase * 0.8;

    // ── Stars ─────────────────────────────────────────────────
    if (this._starPoints) {
      this._starPoints.material.uniforms.uNightPhase.value = nightPhase;
    }

    // ── Street lamps ──────────────────────────────────────────
    // Lamps turn on when nightPhase > 0.25 (dusk), full at nightPhase > 0.6
    const lampPhase = THREE.MathUtils.clamp(
      THREE.MathUtils.smoothstep(nightPhase, 0.25, 0.65), 0, 1
    );
    for (const mesh of this._lampMeshes) {
      const mat = mesh.material;
      if (mesh.userData.isLampGlobe) {
        mat.emissiveIntensity = lampPhase;
      } else if (mesh.userData.isLampHalo) {
        mat.opacity = lampPhase * 0.85;
        mat.needsUpdate = true;
      }
    }

    // ── Fog ───────────────────────────────────────────────────
    if (nightPhase > 0.01) {
      if (!this.scene.fog) {
        this.scene.fog = new THREE.Fog(0x050a18, 3000, 14000);
      }
      const fogColor = new THREE.Color().lerpColors(
        new THREE.Color(0x000000), new THREE.Color(0x050a18), nightPhase
      );
      this.scene.fog.color.copy(fogColor);
      this.scene.fog.near = THREE.MathUtils.lerp(5000, 600,  nightPhase);
      this.scene.fog.far  = THREE.MathUtils.lerp(14000, 5000, nightPhase);
    } else {
      this.scene.fog = null;
    }

    // ── Tone mapping exposure ─────────────────────────────────
    // Day: 0.5 (standard). Night: 0.45 — NOT very low, because all
    // scene lights are already dim; crushing exposure further makes
    // moonlight and ambient invisible. A near-constant exposure lets
    // the light intensities themselves control the perceived brightness.
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(0.45, 0.5, sunDayPhase);
  }

  registerLampMeshes(meshes) {
    this._lampMeshes.push(...meshes);
  }

  _tickNight(dt) {
    if (this._starPoints) {
      this._starTime += dt;
      // uTwinkle advances slowly and wraps at 1.0 — the vertex shader uses fract()
      // so no discontinuity. Much cheaper than driving a sin() per vertex per frame.
      this._starPoints.material.uniforms.uTwinkle.value = (this._starTime * 0.08) % 1.0;
    }

    // Move star sphere to follow camera so stars always fill the sky
    if (this._starPoints) {
      this._starPoints.position.copy(this.camera.position);
    }

    // Keep moon in sky relative to camera — billboard + reposition each frame.
    // Fixed world-space position causes the moon to disappear when the camera moves
    // away or rotates such that the fixed point falls behind the near clip plane.
    if (this._moonMesh || this._moonHalo) {
      const moonPos = this.camera.position.clone()
        .add(this._moonDirection.clone().multiplyScalar(MOON_DIST * 0.5));
      // Ensure moon stays above horizon from camera's perspective
      if (moonPos.y < this.camera.position.y + MOON_DIST * 0.15) {
        moonPos.y = this.camera.position.y + MOON_DIST * 0.15;
      }
      if (this._moonMesh) {
        this._moonMesh.position.copy(moonPos);
        this._moonMesh.quaternion.copy(this.camera.quaternion);
      }
      if (this._moonHalo) {
        this._moonHalo.position.copy(moonPos);
        this._moonHalo.quaternion.copy(this.camera.quaternion);
      }
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
    const now = performance.now(), elapsed = now - this._fpsLastTime;
    if (elapsed >= 500) {
      const fps = Math.round(this._fpsFrames / (elapsed / 1000));
      this._fpsEl.style.color =
        fps >= 50 ? '#4fffb0' : fps >= 30 ? '#ffd060' : '#ff4f6b';
      this._fpsEl.textContent  = `${fps} fps`;
      this._fpsFrames   = 0;
      this._fpsLastTime = now;
    }
  }

  _pointInPoly(px, pz, verts) {
    let inside = false;
    const n = verts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = verts[i].x, zi = verts[i].z;
      const xj = verts[j].x, zj = verts[j].z;
      if (((zi > pz) !== (zj > pz)) &&
          (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
  }

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
      const x = pos.getX(i), z = pos.getZ(i);
      let y = elevFn(x, z);
      for (const { verts, baseY } of buildingFootprints) {
        if (this._pointInPoly(x, z, verts)) { y = Math.min(y, baseY); break; }
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

  getTerrainMesh() { return this._groundMesh; }

  setGroundTexture(tex) {
    if (!this._groundMesh) return;
    tex.needsUpdate = true;
    this._groundMesh.material.map   = tex;
    this._groundMesh.material.color.set(0xffffff);
    this._groundMesh.material.needsUpdate = true;
  }

  start() {
    this.init();
    const animate = () => {
      requestAnimationFrame(animate);
      this._timer.update();
      const dt = this._timer.getDelta();
      this._tickNight(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this._updateFPS();
    };
    animate();
  }

  clearWorld() {
    for (const obj of this._objects) {
      this.scene.remove(obj);
      obj.traverse(child => {
        if (child.isMesh) {
          child.geometry.dispose();
          const mats = Array.isArray(child.material) ? child.material : [child.material];
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
        const mats = Array.isArray(child.material) ? child.material : [child.material];
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
    const w = this.container.clientWidth, h = this.container.clientHeight;
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