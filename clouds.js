// clouds.js — Instanced horizontal cloud planes, weather-driven
// Viewed from below: soft noise puffs drifting overhead.
// One InstancedMesh = one draw call regardless of cloud count.
import * as THREE from 'three';

// ── Tunables ──────────────────────────────────────────────────
const CLOUD_FIELD      = 3000;  // half-width of cloud field (world units)
const MAX_CLOUDS       =  80;   // hard cap on instance count
const TEX_SIZE         = 256;   // canvas texture resolution

// Defaults (can be overridden via setProperties)
const DEFAULT_WIND_SPEED    =  18;   // world-units per second along X
const DEFAULT_WIND_ANGLE    = 0.22;  // radians off X-axis (slight diagonal)
const DEFAULT_ALTITUDE      = 380;   // base Y of cloud layer (metres above ground)
const DEFAULT_ALTITUDE_SPREAD =  60; // ± random variation in Y per cloud

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
function _buildCloudTexture() {
  const S = TEX_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');

  const id  = ctx.createImageData(S, S);
  const dat = id.data;

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const nx = (px / S) * 4;
      const ny = (py / S) * 4;
      let   n  = _fbm(nx, ny);
      n = Math.pow(n, 1.4);

      const dx = (px / S - 0.5) * 2;
      const dy = (py / S - 0.5) * 2;
      const r  = Math.sqrt(dx*dx + dy*dy);
      const vignette = Math.max(0, 1 - Math.pow(r / 0.85, 2.5));

      const a = Math.min(255, Math.round(n * vignette * 310));
      const idx = (py * S + px) * 4;
      dat[idx]   = 255;
      dat[idx+1] = 255;
      dat[idx+2] = 255;
      dat[idx+3] = a;
    }
  }
  ctx.putImageData(id, 0, 0);

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
    this._mesh      = null;
    this._count     = 0;
    this._positions = [];
    this._time      = 0;
    this._texture   = null;

    // Weather-driven targets
    this._targetOpacity  = 0.5;
    this._targetColor    = new THREE.Color(1, 1, 1);
    this._currentOpacity = 0.5;
    this._currentColor   = new THREE.Color(1, 1, 1);

    // Controllable properties (set via setProperties)
    this._windSpeed   = DEFAULT_WIND_SPEED;
    this._windAngle   = DEFAULT_WIND_ANGLE;
    this._altitude    = DEFAULT_ALTITUDE;
    this._altSpread   = DEFAULT_ALTITUDE_SPREAD;

    // Derived wind vector (updated when speed/angle change)
    this._windVec = new THREE.Vector2(
      Math.cos(DEFAULT_WIND_ANGLE) * DEFAULT_WIND_SPEED,
      Math.sin(DEFAULT_WIND_ANGLE) * DEFAULT_WIND_SPEED,
    );
  }

  // ── setProperties — called by SceneManager ─────────────────
  // windSpeed: world-units/sec (0–80)
  // windAngleDeg: compass degrees (0 = east, 90 = north, etc.)
  // altitude: metres above ground (100–1000)
  setProperties({ windSpeed, windAngleDeg, altitude } = {}) {
    let changed = false;

    if (windSpeed !== undefined && windSpeed !== this._windSpeed) {
      this._windSpeed = windSpeed;
      changed = true;
    }
    if (windAngleDeg !== undefined) {
      const rad = windAngleDeg * Math.PI / 180;
      if (rad !== this._windAngle) {
        this._windAngle = rad;
        changed = true;
      }
    }
    if (altitude !== undefined && altitude !== this._altitude) {
      this._altitude = altitude;
      // Re-distribute cloud Y positions to new altitude
      const rng = (lo, hi, seed) => lo + _smoothNoise(seed * 7.3, seed * 3.1) * (hi - lo);
      for (let i = 0; i < this._positions.length; i++) {
        this._positions[i].y = this._altitude + rng(-this._altSpread, this._altSpread, i * 2 + 7);
      }
    }

    if (changed) {
      this._windVec.set(
        Math.cos(this._windAngle) * this._windSpeed,
        Math.sin(this._windAngle) * this._windSpeed,
      );
    }
  }

  // ── init ───────────────────────────────────────────────────
  init(scene) {
    this._scene   = scene;
    this._texture = _buildCloudTexture();

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
      map:         this._texture,
      transparent: true,
      opacity:     0,
      depthWrite:  false,
      side:        THREE.DoubleSide,
      blending:    THREE.NormalBlending,
    });

    this._mesh = new THREE.InstancedMesh(geo, mat, MAX_CLOUDS);
    this._mesh.frustumCulled = false;
    this._mesh.renderOrder   = 2;
    this._mesh.count         = 0;
    scene.add(this._mesh);

    const dummy = new THREE.Object3D();
    this._positions = [];
    const rng = (lo, hi, seed) => lo + _smoothNoise(seed * 7.3, seed * 3.1) * (hi - lo);

    for (let i = 0; i < MAX_CLOUDS; i++) {
      const x      = rng(-CLOUD_FIELD, CLOUD_FIELD, i * 2);
      const z      = rng(-CLOUD_FIELD, CLOUD_FIELD, i * 2 + 1);
      const y      = this._altitude + rng(-this._altSpread, this._altSpread, i * 2 + 7);
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
  setWeather(cloudCover, weatherCode) {
    const cc = Math.max(0, Math.min(100, cloudCover));
    this._count = Math.round((cc / 100) * MAX_CLOUDS);
    this._targetOpacity = THREE.MathUtils.lerp(0.25, 0.82, cc / 100);

    let r, g, b;
    if (weatherCode >= 95) {
      r = g = b = 0.30;
    } else if (weatherCode >= 61) {
      r = g = b = 0.52;
    } else if (weatherCode >= 45) {
      r = g = b = 0.72;
    } else if (cc > 60) {
      r = g = b = 0.85;
    } else {
      r = 1; g = 1; b = 1;
    }
    this._targetColor.setRGB(r, g, b);
  }

  // ── tick ───────────────────────────────────────────────────
  tick(dt, cameraPosition) {
    if (!this._mesh) return;

    this._time += dt;

    const lerpK = 1 - Math.pow(0.02, dt);
    this._currentOpacity = THREE.MathUtils.lerp(this._currentOpacity, this._targetOpacity, lerpK);
    this._currentColor.lerp(this._targetColor, lerpK);

    this._mesh.material.opacity = this._currentOpacity;
    this._mesh.material.color.copy(this._currentColor);
    this._mesh.count = this._count;

    if (this._count === 0) return;

    const dummy  = new THREE.Object3D();
    const dx     = this._windVec.x * dt;
    const dz     = this._windVec.y * dt;
    const wrap   = CLOUD_FIELD * 2;

    for (let i = 0; i < this._count; i++) {
      const p = this._positions[i];
      p.x += dx;
      p.z += dz;

      if (p.x >  CLOUD_FIELD) p.x -= wrap;
      if (p.x < -CLOUD_FIELD) p.x += wrap;
      if (p.z >  CLOUD_FIELD) p.z -= wrap;
      if (p.z < -CLOUD_FIELD) p.z += wrap;

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

  setDayBrightness(factor) {
    const b = THREE.MathUtils.clamp(factor, 0, 1);
    if (this._mesh) {
      this._mesh.material.color.copy(this._currentColor).multiplyScalar(b);
    }
  }

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
