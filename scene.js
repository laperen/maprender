// js/scene.js — Three.js scene, camera, renderer, lights, controls
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { OrbitControlsImpl } from './orbitControls.js';
import { CloudLayer }        from './clouds.js';

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
    this._lodFrame     = 0;

    // Cloud layer
    this._clouds = new CloudLayer();
    this.$enterWorldBtn  = document.getElementById('enter-world-btn');
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
    this.raycaster.firstHitOnly = true;
    this.mouseNDC   = new THREE.Vector2();
    this._pickables = [];

    // Clouds sit above the scene — init after scene exists
    this._clouds.init(this.scene);

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
    // ── 1. Normalize time (0–24 → 0–1) ───────────────
    const t = ((hour % 24) + 24) % 24;
    const phase = t / 24;
  
    // ── 2. Smooth orbital angles (NO clamping, NO max()) ───────
    // Elevation: full sinusoidal orbit (-1..1)
    const elev = Math.sin(phase * Math.PI * 2 - Math.PI / 2);
  
    // Map elevation to sky angle (no hard cutoffs)
    const elevDeg = elev * 75; // ±75° smooth arc
  
    // Azimuth: full 360° rotation
    const aziDeg = phase * 360;
  
    const phi   = THREE.MathUtils.degToRad(90 - elevDeg);
    const theta = THREE.MathUtils.degToRad(aziDeg);
  
    const sunPos = new THREE.Vector3();
    sunPos.setFromSphericalCoords(1, phi, theta);
  
    this._skyUniforms['sunPosition'].value.copy(sunPos);
  
    this._sunDirection = sunPos.clone().normalize();
  
    // ── 3. Moon is always exact inverse (stable now) ───────────
    this._moonDirection = this._sunDirection.clone().negate();
  
    // ── 4. Atmosphere tuning (based on elevation, not clamped sin) ─
    const isDay = elev > 0;
  
    const nightFactor = THREE.MathUtils.smoothstep(-0.1, 0.1, elev);
    const dayFactor   = 1 - nightFactor;
  
    const turbidity = isDay
      ? THREE.MathUtils.lerp(0.6, 1.4, dayFactor)
      : 0.5;

    const rayleigh = isDay
      ? THREE.MathUtils.lerp(0.15, 0.3, dayFactor)  // balanced blue
      : 0.1;

    const mieCoefficient = isDay ? 0.0025 : 0.0008;  // reduce haze
    const mieDirectionalG = 0.75; // slightly less forward scattering

    this._skyUniforms['turbidity'].value = turbidity;
    this._skyUniforms['rayleigh'].value = rayleigh;
    this._skyUniforms['mieCoefficient'].value = mieCoefficient;
    this._skyUniforms['mieDirectionalG'].value = mieDirectionalG;
  
    return sunPos;
  }
  _getAtmosphereColors(elevDeg) {
    const daySky   = new THREE.Color(0x4da6ff);  // richer blue
    const sunset   = new THREE.Color(0xffa060);
    const nightSky = new THREE.Color(0x050816);
  
    const sky = new THREE.Color();
  
    // ── 1. Compute golden factor DIRECTLY from elevation ──
    // Peak golden at horizon (0°), fade out above ~20°
    const goldenFactor = 1.0 - THREE.MathUtils.smoothstep(0, 20, elevDeg);
  
    // Optional: include below-horizon glow slightly
    const twilightBoost = THREE.MathUtils.smoothstep(-6, 2, elevDeg);
  
    const finalGolden = goldenFactor * twilightBoost;
  
    // ── 2. Blend sky colors ──
    if (elevDeg > -6) {
      sky.lerpColors(daySky, sunset, finalGolden);
    } else {
      sky.copy(nightSky);
    }
  
    return {
      sky,
      fog: elevDeg > -6 ? sky.clone() : nightSky.clone()
    };
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
    //const moonGeo = new THREE.PlaneGeometry(MOON_SIZE, MOON_SIZE);
    const moonMat = new THREE.MeshBasicMaterial({
      //map: moonTex,
      transparent: true,
      opacity: 0,
      //alphaTest: 0.2,
      depthWrite: false,
      depthTest: true,
      //blending: THREE.NormalBlending,
    });
    this._moonMesh = new THREE.Mesh(moonGeo, moonMat);
    
    this._moonMesh.material.map = null;
    this._moonMesh.material.color.set(0xffffff);
    this._moonMesh.material.blending = THREE.AdditiveBlending;
    this._moonMesh.material.fog = false;

    this._moonMesh.renderOrder    = 0;  // same as geometry; depthTest:false means it paints over sky bg
    this._moonMesh.frustumCulled  = false; // always render — repositioned each frame

    // Position updated each frame in _tickNight (camera-relative)
    this._moonMesh.position.set(0, MOON_DIST * 0.3, -MOON_DIST * 0.4);
    //this._moonMesh.position.set(0,0, 0);
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
      depthTest:  true,
      blending:   THREE.AdditiveBlending,
    });
    this._moonHalo = new THREE.Mesh(haloGeo, haloMat);
    this._moonHalo.renderOrder   = -1; // draws before geometry (stars also at -1, both are sky bg)
    this._moonHalo.frustumCulled = false; // always render
    // Position updated each frame in _tickNight (synced to moon)
    this._moonHalo.position.set(0, MOON_DIST * 0.3, -MOON_DIST * 0.4);
    this._moonHalo.material.fog = false;
    //this._moonHalo.position.set(0, 0, 0);
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
      let y = v.y;
      // compress slightly but don't clamp
      y = y * 0.9;

      // optional: allow deeper negative values occasionally
      if (Math.random() < 0.15) {
        y -= STAR_SPHERE_R * 0.2 * Math.random();
      }
      positions[i * 3 + 1] = y;// Math.max(v.y, STAR_SPHERE_R * 0.06);
      positions[i * 3 + 2] = v.z;
      sizes[i]  = 1.0 + Math.random() * 2.5; // fixed screen-space px — looks natural
        //? 2.5 + Math.random() * 1.5 : 0.6 + Math.random() * 1.8;
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
        
          // Stars are a skybox layer — use fixed screen-space size (no depth attenuation).
          // Depth-attenuating at STAR_SPHERE_R (~8000 units) shrinks points to <1px.
          gl_PointSize = aSize;
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
    points.material.depthTest = true;
    points.material.depthWrite = false; // keep this off
    points.renderOrder = -1;
    //points.material.depthTest  = false;
    //points.material.depthWrite = false;
    return points;
  }
  setTimeOfDay(hour) {
    // ── 1. Normalize time to cyclic 24h domain ───────────────
    const t = ((hour % 24) + 24) % 24;
    this._currentHour = t;
  
    const phase = t / 24;              // 0..1 cyclic
    const angle = phase * Math.PI * 2; // full circular driver
  
    // ── 2. Core sun model (continuous cycle, no seams) ───────
    // Sun height: smooth periodic curve
    const elevDeg = -20 + 95 * Math.max(0, Math.sin(angle - Math.PI / 2));
  
    const elevNorm = THREE.MathUtils.clamp(elevDeg / 75, -0.267, 1);
  
    // Smooth day/night split (stable across wrap)
    const sunDayPhase = THREE.MathUtils.smoothstep(elevNorm, -0.05, 0.18);
    const nightPhase = 1 - sunDayPhase;
    this._nightPhase = nightPhase;
  
    // ── 3. Update sun direction via Sky system ───────────────
    this._setSkyPosition(t);
  
    const dist = 1000;
  
    this.sun.position.set(
      this._sunDirection.x * dist,
      this._sunDirection.y * dist,
      this._sunDirection.z * dist
    );
  
    // ── 4. Sun color (golden hour smoothing stays stable) ────
    const sunColor = new THREE.Color();
    // Better golden hour factor: strongest near horizon, fades upward
    const horizonFactor = 1.0 - Math.abs(elevDeg) / 75;
    const golden = THREE.MathUtils.clamp(horizonFactor, 0, 1);

    // smooth curve so it "blooms" instead of snapping
    const goldenSoft = Math.pow(golden, 2.2);
  
    if (goldenSoft > 0.01) {
      sunColor.lerpColors(
        new THREE.Color(0xff8830),
        new THREE.Color(0xfff5e0),
        THREE.MathUtils.clamp(elevDeg / 22, 0, 1)
      );
    } else {
      sunColor.set(0xfff5e0);
    }
  
    this.sun.color.copy(sunColor);
    this.sun.intensity = sunDayPhase * 3.0;
  
    const atmos = this._getAtmosphereColors(elevDeg);
    // Skybox / scene background
    this.scene.background = atmos.sky;

    // Sky shader still used (kept intact)
    if (this._sky) this._sky.visible = true;
    // Fog now matches atmosphere exactly
    if (sunDayPhase > 0.01) {
      if (!this.scene.fog) {
        this.scene.fog = new THREE.Fog(atmos.fog, 2000, 14000);
      }
      this.scene.fog.color.copy(atmos.fog);
    } else {
      if (!this.scene.fog) {
        this.scene.fog = new THREE.Fog(atmos.fog, 3000, 14000);
      }
      this.scene.fog.color.copy(atmos.fog);
    }
    // ── 5. Ambient & rim light ───────────────────────────────
    if (this._dayAmbient) {
      this._dayAmbient.intensity = sunDayPhase * 0.5;
    }
  
    if (this._rimLight) {
      this._rimLight.intensity = sunDayPhase * 0.4;
    }
  
    // ── 7. Moon light + ambient ──────────────────────────────
    if (this._moonLight) {
      this._moonLight.intensity = nightPhase * 1.2;
      this._moonLight.position.copy(this._moonDirection).multiplyScalar(1000);
    }
  
    if (this._nightAmbient) {
      this._nightAmbient.color.set(0x1a3a6a);
      this._nightAmbient.intensity = nightPhase * 0.8;
    }
  
    if (this._moonMesh) {
      this._moonMesh.material.opacity = nightPhase;
    }
  
    if (this._moonHalo) {
      this._moonHalo.material.opacity = nightPhase * 0.8;
    }
  
    // ── 8. Stars ─────────────────────────────────────────────
    if (this._starPoints) {
      this._starPoints.material.uniforms.uNightPhase.value = nightPhase;
    }
  
    // ── 9. Lamps ─────────────────────────────────────────────
    const lampPhase = THREE.MathUtils.clamp(
      THREE.MathUtils.smoothstep(nightPhase, 0.25, 0.65),
      0,
      1
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
    // ── 11. Tone mapping ─────────────────────────────────────
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(
      0.45,
      0.5,
      sunDayPhase
    );
  
    // ── 12. Clouds ───────────────────────────────────────────
    if (this._clouds) {
      this._clouds.setDayBrightness(
        THREE.MathUtils.lerp(0.25, 1.0, sunDayPhase)
      );
    }
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
    if (this._moonMesh || this._moonHalo) {
      const moonPos = this.camera.position.clone()
        .addScaledVector(this._moonDirection, MOON_DIST);
    
      if (this._moonMesh) {
        this._moonMesh.position.copy(moonPos);
      }
    
      if (this._moonHalo) {
        this._moonHalo.position.copy(moonPos);
        this._moonHalo.quaternion.copy(this.camera.quaternion); // billboard only for halo
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
      position: 'fixed', top: '0', right: '0',
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

  // ── Lamp LOD — hide lamps too far from camera to be visible ──
  // Runs every 15 frames (~4×/sec at 60fps) to amortise the cost
  // of iterating _lampMeshes. Y is included because the camera can
  // be high above the scene during top-down views.
  _tickLampLOD() {
    this._lodFrame++;
    if (this._lodFrame % 15 !== 0) return;

    const camPos  = this.camera.position;
    const THRESH2 = 600 * 600;

    for (const mesh of this._lampMeshes) {
      const dx = mesh.position.x - camPos.x;
      const dy = mesh.position.y - camPos.y;
      const dz = mesh.position.z - camPos.z;
      mesh.visible = (dx * dx + dy * dy + dz * dz) < THRESH2;
    }
  }

  start() {
    this.init();
    const animate = () => {
      requestAnimationFrame(animate);
      this._timer.update();
      const dt = this._timer.getDelta();
      this._tickNight(dt);
      this._tickLampLOD();
      this._tickBeacon(dt);
      if (this._transitionTick) this._transitionTick(dt);
      this._clouds.tick(dt, this.camera.position);
      this.controls.update(dt);
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

  // ── Weather / clouds ──────────────────────────────────────────
  setWeather(cloudCover, weatherCode) {
    this._clouds.setWeather(cloudCover, weatherCode);
  }

  // windSpeed: world-units/sec, windAngleDeg: 0–360°, altitude: metres
  setCloudProperties({ windSpeed, windAngleDeg, altitude } = {}) {
    this._clouds.setProperties({ windSpeed, windAngleDeg, altitude });
  }

  flyTo(x, z, radius) {
    const dist = radius * 2.5;
    this.camera.position.set(x, dist * 0.8, z + dist);
    this.controls.target.set(x, 0, z);
    this.controls.update();
  }

  // ═══════════════════════════════════════════════════════════════
  // LOCATION SELECTION MODE
  // ═══════════════════════════════════════════════════════════════

  enterSelectionMode() {
    this._selectionMode = true;
    this.controls.enabled = true;
    // Attach click handler for ground picking
    this._selectionHandler = (e) => this._onSelectionClick(e);
    this.renderer.domElement.addEventListener('click', this._selectionHandler);
  }

  exitSelectionMode() {
    this._selectionMode = false;
    if (this._selectionHandler) {
      this.renderer.domElement.removeEventListener('click', this._selectionHandler);
      this._selectionHandler = null;
    }
  }

  _onSelectionClick(e) {
    if (!this._selectionMode) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndx  =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    const ndy  = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    const mouse = new THREE.Vector2(ndx, ndy);

    this.raycaster.setFromCamera(mouse, this.camera);

    // Pick against ground and all scene objects
    const allMeshes = [];
    this.scene.traverse(child => { if (child.isMesh) allMeshes.push(child); });
    const hits = this.raycaster.intersectObjects(allMeshes, false);
    if(!hits.length || hits[0].object.uuid === this._sky.uuid){
      this.removeBeacon();
      if (this.$enterWorldBtn) this.$enterWorldBtn.disabled = true;
      return;
    }
    const pt = hits[0].point;
    this.placeBeacon(pt.x, pt.y, pt.z);

    // Fire callback if set
    if (this._onBeaconPlaced) this._onBeaconPlaced(pt.x, pt.y, pt.z);
  }

  // Called by UIController to be notified when beacon is placed
  onBeaconPlaced(cb) {
    this._onBeaconPlaced = cb;
  }

  // ── Beacon ────────────────────────────────────────────────────
  placeBeacon(x, y, z) {
    this.removeBeacon();

    this._beaconPos = new THREE.Vector3(x, y, z);
    this._beaconGroup = new THREE.Group();
    this._beaconGroup.name = 'beacon';

    // Ground ring (flat cylinder)
    const ringGeo = new THREE.CylinderGeometry(3.5, 3.5, 0.25, 48, 1, true);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x47d7ff, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(x, y + 0.15, z);
    this._beaconGroup.add(ring);

    // Filled disc glow under beacon
    const discGeo = new THREE.CircleGeometry(3.5, 48);
    const discMat = new THREE.MeshBasicMaterial({
      color: 0x47d7ff, transparent: true, opacity: 0.18,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, y + 0.1, z);
    this._beaconGroup.add(disc);

    // Vertical beam (thin cylinder, very tall, additive)
    const beamGeo = new THREE.CylinderGeometry(0.22, 1.8, 600, 12, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x47d7ff, transparent: true, opacity: 0.10,
      side: THREE.DoubleSide, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(x, y + 300, z);
    this._beaconGroup.add(beam);

    // Diamond marker at eye level
    const diamondGeo = new THREE.OctahedronGeometry(1.4, 0);
    const diamondMat = new THREE.MeshBasicMaterial({
      color: 0x47d7ff, wireframe: false, transparent: true, opacity: 0.92,
    });
    const diamond = new THREE.Mesh(diamondGeo, diamondMat);
    diamond.position.set(x, y + 12, z);
    diamond.userData.isBeaconDiamond = true;
    this._beaconGroup.add(diamond);

    // Diamond wireframe outline
    const diamondWF = new THREE.Mesh(diamondGeo.clone(), new THREE.MeshBasicMaterial({
      color: 0xffffff, wireframe: true, transparent: true, opacity: 0.4,
    }));
    diamondWF.position.copy(diamond.position);
    this._beaconGroup.add(diamondWF);

    this.scene.add(this._beaconGroup);
    this._beaconTime = 0;
  }

  removeBeacon() {
    if (this._beaconGroup) {
      this.scene.remove(this._beaconGroup);
      this._beaconGroup.traverse(c => {
        if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
      });
      this._beaconGroup = null;
    }
    this._beaconPos = null;
  }

  // ── Animate beacon ────────────────────────────────────────────
  _tickBeacon(dt) {
    if (!this._beaconGroup) return;
    this._beaconTime = (this._beaconTime || 0) + dt;
    const t = this._beaconTime;

    // Pulse ring opacity
    this._beaconGroup.children.forEach(c => {
      if (c.userData.isBeaconDiamond) {
        c.rotation.y = t * 1.8;
        c.position.y = this._beaconPos.y + 12 + Math.sin(t * 2.5) * 1.5;
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CHARACTER
  // ═══════════════════════════════════════════════════════════════

  spawnCharacter(x, y, z) {
    this.removeCharacter();

    const group = new THREE.Group();
    group.name = 'character';

    // Body (capsule approximated as cylinder + two hemispheres)
    const bodyH  = 1.2;
    const capR   = 0.38;
    const totalH = bodyH + capR * 2;

    // Main body cylinder
    const bodyGeo = new THREE.CylinderGeometry(capR, capR * 0.88, bodyH, 16, 1);
    const bodyMat = new THREE.MeshToonMaterial({ color: 0x3d8eff });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = capR + bodyH / 2;
    body.castShadow = true;
    group.add(body);

    // Top cap
    const topCapGeo = new THREE.SphereGeometry(capR, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const cap = new THREE.Mesh(topCapGeo, bodyMat);
    cap.position.y = capR + bodyH;
    cap.castShadow = true;
    group.add(cap);

    // Bottom cap
    const botCapGeo = new THREE.SphereGeometry(capR * 0.88, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    const botCap = new THREE.Mesh(botCapGeo, bodyMat);
    botCap.position.y = capR;
    botCap.castShadow = true;
    group.add(botCap);

    // Head
    const headGeo = new THREE.SphereGeometry(capR * 0.72, 16, 12);
    const headMat = new THREE.MeshToonMaterial({ color: 0xf5c9a0 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = capR + bodyH + capR * 0.9;
    head.castShadow = true;
    group.add(head);

    group.position.set(x, y, z);
    this._characterGroup = group;
    this._characterPos   = new THREE.Vector3(x, y, z);
    // Store character height so camera can offset above feet
    this._characterHeight = totalH;

    this.scene.add(group);
    return group;
  }

  removeCharacter() {
    if (this._characterGroup) {
      this.scene.remove(this._characterGroup);
      this._characterGroup.traverse(c => {
        if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
      });
      this._characterGroup = null;
    }
    this._characterPos = null;
  }

  // ═══════════════════════════════════════════════════════════════
  // CAMERA TRANSITION TO ROAMING
  // Smoothly animates camera from current orbit position to a
  // 3rd-person position behind and above the character.
  // ═══════════════════════════════════════════════════════════════

  transitionToRoaming(onComplete) {
    if (!this._characterPos) { if (onComplete) onComplete(); return; }

    // Disable orbit controls during transition
    this.controls.enabled = false;

    const charPos   = this._characterPos.clone();
    const charH     = this._characterHeight || 2.0;

    // Target: behind character (positive Z = "south"), slightly elevated
    const targetCamPos = new THREE.Vector3(
      charPos.x,
      charPos.y + charH + 4.0,   // eye height above character
      charPos.z + 10.0            // behind character
    );
    const targetLookAt = new THREE.Vector3(
      charPos.x,
      charPos.y + charH * 0.6,   // look at mid-chest
      charPos.z
    );

    const startCamPos  = this.camera.position.clone();
    const startLookAt  = this.controls.target.clone();

    const duration = 1.2; // seconds
    let   elapsed  = 0;

    this._transitionActive = true;
    this._transitionTick = (dt) => {
      elapsed += dt;
      const t = Math.min(1, elapsed / duration);
      // Smooth ease-in-out
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      this.camera.position.lerpVectors(startCamPos, targetCamPos, ease);
      const lookAt = new THREE.Vector3().lerpVectors(startLookAt, targetLookAt, ease);
      this.camera.lookAt(lookAt);

      if (t >= 1) {
        this._transitionActive = false;
        this._transitionTick   = null;
        this._roamingCamPos    = targetCamPos.clone();
        this._roamingLookAt    = targetLookAt.clone();
        if (onComplete) onComplete();
      }
    };
  }

  transitionToOrbit(x, z, radius, onComplete) {
    this.controls.enabled = false;

    const dist = radius * 2.5;
    const targetCamPos = new THREE.Vector3(x, dist * 0.8, z + dist);
    const targetLookAt = new THREE.Vector3(x, 0, z);

    const startCamPos = this.camera.position.clone();
    const startLookAt = this._roamingLookAt
      ? this._roamingLookAt.clone()
      : new THREE.Vector3(x, 0, z);

    const duration = 1.0;
    let elapsed = 0;

    this._transitionActive = true;
    this._transitionTick = (dt) => {
      elapsed += dt;
      const t = Math.min(1, elapsed / duration);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      this.camera.position.lerpVectors(startCamPos, targetCamPos, ease);
      const lookAt = new THREE.Vector3().lerpVectors(startLookAt, targetLookAt, ease);
      this.camera.lookAt(lookAt);
      this.controls.target.lerpVectors(startLookAt, targetLookAt, ease);

      if (t >= 1) {
        this._transitionActive = false;
        this._transitionTick   = null;
        this.controls.enabled  = true;
        this.controls.update();
        if (onComplete) onComplete();
      }
    };
  }

  getBeaconPosition() {
    return this._beaconPos ? this._beaconPos.clone() : null;
  }

  getCharacterPosition() {
    return this._characterPos ? this._characterPos.clone() : null;
  }
}