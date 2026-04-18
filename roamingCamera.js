// roamingCamera.js — Third-person boom-arm camera for roaming mode.
// Adapts the boom-arm pattern from customCamera.js to the existing
// SceneManager architecture. Reuses the scene's existing camera —
// no second camera is created. OrbitControls are disabled while active.

import * as THREE from 'three';

// ── Tunables ─────────────────────────────────────────────────
const MOVE_SPEED        =  8;     // world-units/sec base walk speed
const SPRINT_MULT       =  2.8;   // held-Shift multiplier
const BOOM_LENGTH       = 10;     // default camera distance behind character
const BOOM_MIN          =  2;     // minimum zoom distance (scroll in)
const BOOM_MAX          = 28;     // maximum zoom distance (scroll out)
const BOOM_ZOOM_SPEED   =  2.5;   // scroll wheel sensitivity
const PITCH_MIN         = -55;    // degrees — look-down limit
const PITCH_MAX         =  70;    // degrees — look-up limit
const MOUSE_SENS_X      =  0.18;  // horizontal look sensitivity (deg/px)
const MOUSE_SENS_Y      =  0.14;  // vertical look sensitivity (deg/px)
const LERP_CAM_K        = 14;     // camera position exponential-smoothing rate
const USE_HEIGHT        =  1.6;   // eye-level offset above character feet (m)
const GROUND_PROBE_Y    = 2000;   // raycast origin height for terrain snapping
const GRAVITY           = 18;     // downward acceleration (world-units/sec^2)
const JUMP_VEL          =  7;     // initial upward velocity on jump
const SNAP_DIST         =  0.4;   // tolerance before gravity kicks in
const CAM_COLLISION_R   =  0.6;   // camera push-back sphere radius

// ── Key map ──────────────────────────────────────────────────
const KEYS = {
  FORWARD : ['KeyW', 'ArrowUp'],
  BACK    : ['KeyS', 'ArrowDown'],
  LEFT    : ['KeyA', 'ArrowLeft'],
  RIGHT   : ['KeyD', 'ArrowRight'],
  JUMP    : ['Space'],
  SPRINT  : ['ShiftLeft', 'ShiftRight'],
};

export class RoamingCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera     the scene's existing camera
   * @param {THREE.Scene}             scene      Three.js scene (kept for compat)
   * @param {HTMLElement}             domElement renderer canvas
   */
  constructor(camera, scene, domElement) {
    this._camera = camera;
    this._scene  = scene;
    this._dom    = domElement;
    this._active = false;

    //this._terrainMesh = null;
    this.collidables = null;
    // Boom-arm state
    this._yaw     = 0;
    this._pitch   = -10;
    this._boomLen = BOOM_LENGTH;

    // Character physics
    this._charPos  = new THREE.Vector3();
    this._charVelY = 0;
    this._onGround = false;

    // Smooth camera target
    this._camTarget = new THREE.Vector3();
    this._firstTick = true;

    // Pre-allocated scratch objects
    this._fwd       = new THREE.Vector3();
    this._right     = new THREE.Vector3();
    this._ray       = new THREE.Raycaster();
    this._ray.firstHitOnly = true;
    this._rayOrigin = new THREE.Vector3();
    this._rayDown   = new THREE.Vector3(0, -1, 0);
    this._boomDir   = new THREE.Vector3();
    this._pivot     = new THREE.Vector3();
    this._idealCam  = new THREE.Vector3();
    this._camDir    = new THREE.Vector3();

    // Key state
    this._keys = {};

    // Bound handlers
    this._onKeyDown     = this._onKeyDown.bind(this);
    this._onKeyUp       = this._onKeyUp.bind(this);
    this._onMouseMove   = this._onMouseMove.bind(this);
    this._onWheel       = this._onWheel.bind(this);
    //this._onPLChange    = this._onPLChange.bind(this);
    this._onCanvasClick = this._onCanvasClick.bind(this);

    /** Callback fired when the player exits (pointer lock released). */
    this.onExit = null;
  }

  // ── Public API ────────────────────────────────────────────────

  activate(spawnPos, yawDeg = 0) {
    if (this._active) return;
    this._active      = true;
    //this._terrainMesh = terrain;
    this._charPos.copy(spawnPos);
    this._yaw       = THREE.MathUtils.degToRad(yawDeg);
    this._pitch     = -10;
    this._boomLen   = BOOM_LENGTH;
    this._charVelY  = 0;
    this._onGround  = false;
    this._firstTick = true;
    this._bindEvents();
    this._requestPointerLock();
  }

  deactivate() {
    if (!this._active) return;
    this._active = false;
    this._unbindEvents();
    if (document.pointerLockElement === this._dom) document.exitPointerLock();
  }

  tick(dt) {
    if (!this._active) return this._charPos;
    this._moveCharacter(dt);
    this._positionCamera(dt);
    return this._charPos;
  }

  get isActive() { return this._active; }

  // ── Movement ──────────────────────────────────────────────────

  _moveCharacter(dt) {
    const fwd   = this._key(KEYS.FORWARD) ? 1 : 0;
    const back  = this._key(KEYS.BACK)    ? 1 : 0;
    const left  = this._key(KEYS.LEFT)    ? 1 : 0;
    const right = this._key(KEYS.RIGHT)   ? 1 : 0;
    const speed = MOVE_SPEED * (this._key(KEYS.SPRINT) ? SPRINT_MULT : 1);

    // Horizontal directions from yaw only (pitch doesn't tilt movement)
    this._fwd.set(  Math.sin(this._yaw), 0,  Math.cos(this._yaw));
    this._right.set(Math.cos(this._yaw), 0, -Math.sin(this._yaw));

    this._charPos.x += (this._fwd.x * (fwd - back)  + this._right.x * (left - right)) * speed * dt;
    this._charPos.z += (this._fwd.z * (fwd - back)  + this._right.z * (left - right)) * speed * dt;

    // Gravity & ground snap
    const groundY = this._getGroundY(this._charPos.x, this._charPos.z);
    const feetY   = groundY + SNAP_DIST;

    if (this._charPos.y > feetY + 0.05) {
      this._charVelY  -= GRAVITY * dt;
      this._charPos.y += this._charVelY * dt;
      this._onGround   = false;
    } else {
      this._charPos.y = feetY;
      this._charVelY  = 0;
      this._onGround  = true;
    }

    if (this._key(KEYS.JUMP) && this._onGround) {
      this._charVelY = JUMP_VEL;
      this._onGround = false;
    }
  }
  _intersectObject(collidables){
    let rethits = [];
    for(let i = 0, max = collidables.length; i < max; i++){
      let col = collidables[i];
      let hits = this._ray.intersectObject(col, false);
      rethits.push(...hits);
    }
    return rethits;
  }
  _getGroundY(x, z) {
    if (!this.collidables || !this.collidables.length) return 0;
    this._rayOrigin.set(x, GROUND_PROBE_Y, z);
    this._ray.set(this._rayOrigin, this._rayDown);
    const hits = this._intersectObject(this.collidables, false);
    return hits.length ? hits[0].point.y : 0;
  }

  // ── Camera (boom-arm) ─────────────────────────────────────────

  _positionCamera(dt) {
    const pitchRad = THREE.MathUtils.degToRad(this._pitch);
    const cosPitch = Math.cos(pitchRad);
    const sinPitch = Math.sin(pitchRad);

    // Eye pivot — character feet + use-height (mirrors camvert.position in original)
    this._pivot.copy(this._charPos);
    this._pivot.y += USE_HEIGHT;

    // Boom direction: rotate -Z by pitch then by yaw (mirrors camboom + camvert hierarchy)
    this._boomDir.set(
      -Math.sin(this._yaw) * cosPitch,
       sinPitch,
      -Math.cos(this._yaw) * cosPitch
    ).normalize();

    this._idealCam.copy(this._pivot).addScaledVector(this._boomDir, this._boomLen);

    const finalCam = this._resolveCamera(this._pivot, this._idealCam);

    if (this._firstTick) {
      this._camTarget.copy(finalCam);
      this._firstTick = false;
    } else {
      this._camTarget.lerp(finalCam, 1 - Math.exp(-LERP_CAM_K * dt));
    }

    this._camera.position.copy(this._camTarget);
    this._camera.lookAt(this._pivot);
  }

  _resolveCamera(pivot, idealPos) {
    // Pull the camera toward the character if terrain blocks the boom arm
    this._camDir.subVectors(idealPos, pivot).normalize();
    const dist = pivot.distanceTo(idealPos);
    this._ray.set(pivot, this._camDir);
    this._ray.far = dist + CAM_COLLISION_R;
    if (!this.collidables || !this.collidables.length) return idealPos;
    const hits = this._intersectObject(this.collidables, false);
    if (hits.length && hits[0].distance < dist) {
      const safeDist = Math.max(1.5, hits[0].distance - CAM_COLLISION_R);
      return pivot.clone().addScaledVector(this._camDir, safeDist);
    }
    return idealPos;
  }

  // ── Input ─────────────────────────────────────────────────────

  _key(codes) { return codes.some(c => this._keys[c]); }

  _onKeyDown(e) {
    if (!this._active) return;
    this._keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
  }

  _onKeyUp(e) { this._keys[e.code] = false; }

  _onMouseMove(e) {
    if (!this._active || !document.pointerLockElement) return;
    this._yaw   -= (e.movementX ?? 0) * MOUSE_SENS_X * (Math.PI / 180);
    this._pitch  = THREE.MathUtils.clamp(
      this._pitch + (e.movementY ?? 0) * MOUSE_SENS_Y,
      PITCH_MIN, PITCH_MAX
    );
  }

  _onWheel(e) {
    if (!this._active) return;
    e.preventDefault();
    this._boomLen = THREE.MathUtils.clamp(
      this._boomLen + (e.deltaY > 0 ? 1 : -1) * BOOM_ZOOM_SPEED,
      BOOM_MIN, BOOM_MAX
    );
  }

  // Re-acquire pointer lock if user clicks after pressing Esc
  _onCanvasClick() {
    if (this._active && !document.pointerLockElement) this._requestPointerLock();
  }
  /*
  _onPLChange() {
    // Pointer lock lost (Esc) — notify caller so UIController can exit roaming
    if (this._active && !document.pointerLockElement) {
      if (typeof this.onExit === 'function') this.onExit();
    }
  }
  */

  _requestPointerLock() {
    try { this._dom.requestPointerLock(); } catch (_) {}
  }

  _bindEvents() {
    document.addEventListener('keydown',           this._onKeyDown,    { capture: false });
    document.addEventListener('keyup',             this._onKeyUp,      { capture: false });
    document.addEventListener('mousemove',         this._onMouseMove,  { capture: false });
    this._dom.addEventListener('wheel',            this._onWheel,      { passive: false });
    this._dom.addEventListener('click',            this._onCanvasClick);
    //document.addEventListener('pointerlockchange', this._onPLChange);
  }

  _unbindEvents() {
    document.removeEventListener('keydown',           this._onKeyDown);
    document.removeEventListener('keyup',             this._onKeyUp);
    document.removeEventListener('mousemove',         this._onMouseMove);
    this._dom.removeEventListener('wheel',            this._onWheel);
    this._dom.removeEventListener('click',            this._onCanvasClick);
    //document.removeEventListener('pointerlockchange', this._onPLChange);
    this._keys = {};
  }
}
