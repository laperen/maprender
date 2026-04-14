// clouds.js — Instanced horizontal cloud planes, weather-driven
// Viewed from below: soft noise puffs drifting overhead.
// One InstancedMesh = one draw call regardless of cloud count.
import * as THREE from 'three';

// ── Tunables ──────────────────────────────────────────────────
const CLOUD_ALTITUDE   = 380;   // base Y of cloud layer (metres above ground)
const ALTITUDE_SPREAD  =  60;   // ± random variation in Y per cloud
const CLOUD_FIELD      = 3000;  // half-width of cloud field (world units)
const MAX_CLOUDS       =  80;   // hard cap on instance count
const WIND_SPEED       =  18;   // world-units per second along X
const WIND_ANGLE       = 0.22;  // radians off X-axis (slight diagonal)
const TEX_SIZE         = 256;   // canvas texture resolution

// Derive wind vector once
const WIND_VEC = new THREE.Vector2(
  Math.cos(WIND_ANGLE) * WIND_SPEED,
  Math.sin(WIND_ANGLE) * WIND_SPEED,
);

// ── Noise helpers (no external lib) ──────────────────────────
// Value noise: interpolate a grid of random values.
function _smoothNoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi,        yf = y - yi;
  const fade = t => t * t * (3 - 2 * t);
  const fx = fade(xf), fy = fade(yf);
  const hash = (ix, iy) => {
    let h = (ix * 1619 + iy * 31337 + seed * 1013) >>> 0;
    h ^= h >>> 13; h = (Math.imul(h, 0x3d6b3b59) >>> 0);
    h ^= h >>> 16;
    return (h >>> 0) / 0xffffffff;
  };
  return (
    hash(xi,   yi  ) * (1-fx) * (1-fy) +
    hash(xi+1, yi  ) *    fx  * (1-fy) +
    hash(xi,   yi+1) * (1-fx) *    fy  +
    hash(xi+1, yi+1) *    fx  *    fy
  );
}

function _fbm(x, y, octaves = 5) {
  let v = 0, amp = 0.5, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    v   += _smoothNoise(x * freq, y * freq, i) * amp;
    max += amp;
    amp  *= 0.5;
    freq *= 2.1;
  }
  return v / max;
}

// ── Build cloud texture ───────────────────────────────────────
// Returns a CanvasTexture with a soft cloud puff shape.
// offset/scale let each instance look different from the same texture
// by using different UV regions of a larger noise field.
function _buildCloudTexture() {
  const S = TEX_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');

  // Fill with noise into an ImageData for speed
  const id  = ctx.createImageData(S, S);
  const dat = id.data;

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      // Map pixel to noise space [0..4]
      const nx = (px / S) * 4;
      const ny = (py / S) * 4;
      let   n  = _fbm(nx, ny);
      n = Math.pow(n, 1.4);          // sharpen core

      // Radial vignette — fade to transparent at edges
      const dx = (px / S - 0.5) * 2;
      const dy = (py / S - 0.5) * 2;
      const r  = Math.sqrt(dx*dx + dy*dy);
      const vignette = Math.max(0, 1 - Math.pow(r / 0.85, 2.5));

      const a = Math.min(255, Math.round(n * vignette * 310));
      const idx = (py * S + px) * 4;
      dat[idx]   = 255;   // R
      dat[idx+1] = 255;   // G
      dat[idx+2] = 255;   // B
      dat[idx+3] = a;
    }
  }
  ctx.putImageData(id, 0, 0);

  // Soft blur pass via shadow — cheap substitute for a Gaussian
  const canvas2 = document.createElement('canvas');
  canvas2.width = canvas2.height = S;
  const ctx2 = canvas2.getContext('2d');
  ctx2.filter = 'blur(4px)';
  ctx2.drawImage(canvas, 0, 0);
  ctx2.filter = 'none';

  const tex = new THREE.CanvasTexture(canvas2);
  tex.premultiplyAlpha = false;
  return tex;
}

// ── CloudLayer class ──────────────────────────────────────────
export class CloudLayer {
  constructor() {
    this._mesh      = null;   // THREE.InstancedMesh
    this._count     = 0;      // active instance count
    this._positions = [];     // [{x,y,z,rotY,scaleX,scaleZ}] per instance
    this._time      = 0;
    this._texture   = null;

    // Target weather state
    this._targetOpacity = 0.5;
    this._targetColor   = new THREE.Color(1, 1, 1);
    this._currentOpacity = 0.5;
    this._currentColor   = new THREE.Color(1, 1, 1);
  }

  // Call once after SceneManager.init()
  init(scene) {
    this._scene   = scene;
    this._texture = _buildCloudTexture();

    const geo = new THREE.PlaneGeometry(1, 1);  // unit plane, scaled per instance
    geo.rotateX(-Math.PI / 2);                  // lie flat (horizontal)

    const mat = new THREE.MeshBasicMaterial({
      map:         this._texture,
      transparent: true,
      opacity:     0,              // starts invisible; setWeather drives this
      depthWrite:  false,
      side:        THREE.DoubleSide,
      blending:    THREE.NormalBlending,
    });

    this._mesh = new THREE.InstancedMesh(geo, mat, MAX_CLOUDS);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder   = 2;   // after terrain, before UI
    this._mesh.count         = 0;
    scene.add(this._mesh);

    // Populate all MAX_CLOUDS slots with stable random positions/sizes
    // so we can simply toggle count rather than rebuilding geometry.
    const dummy = new THREE.Object3D();
    this._positions = [];
    const rng = (lo, hi, seed) => lo + _smoothNoise(seed * 7.3, seed * 3.1) * (hi - lo);

    for (let i = 0; i < MAX_CLOUDS; i++) {
      const x      = rng(-CLOUD_FIELD, CLOUD_FIELD, i * 2);
      const z      = rng(-CLOUD_FIELD, CLOUD_FIELD, i * 2 + 1);
      const y      = CLOUD_ALTITUDE + rng(-ALTITUDE_SPREAD, ALTITUDE_SPREAD, i * 2 + 7);
      const rotY   = rng(0, Math.PI * 2, i * 3 + 0.5);
      const scaleX = rng(350, 900, i * 5 + 1.1);
      const scaleZ = rng(220, 600, i * 5 + 2.3);
      this._positions.push({ x, y, z, rotY, scaleX, scaleZ });

      dummy.position.set(x, y, z);
      dummy.rotation.y = rotY;
      dummy.scale.set(scaleX, 1, scaleZ);
      dummy.updateMatrix();
      this._mesh.setMatrixAt(i, dummy.matrix);
    }
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  // ── setWeather ─────────────────────────────────────────────
  // cloudCover: 0–100 (percent)
  // weatherCode: WMO code (0=clear, 1-3=partly cloudy, 45+=fog/overcast,
  //              61+=rain, 80+=showers, 95+=storm)
  setWeather(cloudCover, weatherCode) {
    const cc = Math.max(0, Math.min(100, cloudCover));

    // Cloud count: 0% → 0, 100% → MAX_CLOUDS
    this._count = Math.round((cc / 100) * MAX_CLOUDS);

    // Opacity: light wispy at low cover, solid at high cover
    this._targetOpacity = THREE.MathUtils.lerp(0.25, 0.82, cc / 100);

    // Colour: white (clear) → mid grey (overcast) → dark grey (storm)
    let r, g, b;
    if (weatherCode >= 95) {
      // Thunderstorm — dark
      r = g = b = 0.30;
    } else if (weatherCode >= 61) {
      // Rain
      r = g = b = 0.52;
    } else if (weatherCode >= 45) {
      // Fog / overcast
      r = g = b = 0.72;
    } else if (cc > 60) {
      // Mostly cloudy
      r = g = b = 0.85;
    } else {
      // Fair / partly cloudy
      r = 1; g = 1; b = 1;
    }
    this._targetColor.setRGB(r, g, b);
  }

  // ── tick — called every frame from SceneManager ────────────
  tick(dt, cameraPosition) {
    if (!this._mesh) return;

    this._time += dt;

    // Smoothly interpolate opacity and colour toward targets
    const lerpK = 1 - Math.pow(0.02, dt);   // ~98% in 1 s
    this._currentOpacity = THREE.MathUtils.lerp(this._currentOpacity, this._targetOpacity, lerpK);
    this._currentColor.lerp(this._targetColor, lerpK);

    this._mesh.material.opacity = this._currentOpacity;
    this._mesh.material.color.copy(this._currentColor);
    this._mesh.count = this._count;

    if (this._count === 0) return;

    // Drift cloud positions with wind, wrap around field boundary
    const dummy  = new THREE.Object3D();
    const dx     = WIND_VEC.x * dt;
    const dz     = WIND_VEC.y * dt;
    const wrap   = CLOUD_FIELD * 2;

    for (let i = 0; i < this._count; i++) {
      const p = this._positions[i];
      p.x += dx;
      p.z += dz;

      // Wrap: when a cloud drifts out of the field, teleport to opposite edge
      if (p.x >  CLOUD_FIELD) p.x -= wrap;
      if (p.x < -CLOUD_FIELD) p.x += wrap;
      if (p.z >  CLOUD_FIELD) p.z -= wrap;
      if (p.z < -CLOUD_FIELD) p.z += wrap;

      // Keep centred on camera (X/Z only) so clouds always fill the view
      dummy.position.set(
        cameraPosition.x + p.x,
        p.y,
        cameraPosition.z + p.z,
      );
      dummy.rotation.y = p.rotY;
      dummy.scale.set(p.scaleX, 1, p.scaleZ);
      dummy.updateMatrix();
      this._mesh.setMatrixAt(i, dummy.matrix);
    }
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  // Called each frame from setTimeOfDay — scales cloud colour by day brightness
  setDayBrightness(factor) {
    // factor: 1.0 = full day, 0.25 = deep night
    // Multiply the weather-derived target colour without overwriting it
    const b = THREE.MathUtils.clamp(factor, 0, 1);
    if (this._mesh) {
      this._mesh.material.color.copy(this._currentColor).multiplyScalar(b);
    }
  }

  // Call when clearing the world (does NOT remove the mesh — clouds persist)
  // If you want to reset weather call setWeather(0, 0).
  dispose() {
    if (this._mesh) {
      this._mesh.geometry.dispose();
      this._mesh.material.dispose();
      if (this._texture) this._texture.dispose();
      if (this._scene) this._scene.remove(this._mesh);
      this._mesh = null;
    }
  }
}
