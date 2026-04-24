// roamingControls.js — Third-person boom-arm camera + capsule-collision physics.
//
// Movement model ported from customMovement.js / customCollision.js:
//   • Capsule collider resolved via three-mesh-bvh shapecast (same BVH already
//     built by WorldBuilder for the terrain mesh).
//   • Inertia-based ground movement with air nudge and wall-ride detection.
//   • Gravity accumulator; double-jump with inertia gating.
//   • Wall-ride: player can run along steep surfaces briefly before gravity wins.
//
// Camera model retained from the original roamingControls.js:
//   • Boom-arm (yaw + pitch) with smooth lerp and geometry push-back.

import * as THREE from 'three';
import {StartCloneUse,GetMiscVect,CloneVector3} from './mrUtils.js';

// ── Tunables — camera ─────────────────────────────────────────
const BOOM_LENGTH     = 10;
const BOOM_MIN        =  2;
const BOOM_MAX        = 28;
const BOOM_ZOOM_SPD   =  2.5;
const PITCH_MIN       = -55;   // degrees
const PITCH_MAX       =  70;
const MOUSE_SENS_X    =  0.18;
const MOUSE_SENS_Y    =  0.14;
const LERP_CAM_K      = 14;
const USE_HEIGHT      =  1.6;  // eye offset above feet
const CAM_COLLISION_R =  0.6;

// ── Tunables — character ──────────────────────────────────────
const CAPSULE_RADIUS  =  0.5;   // metres — half-width of collision capsule
const CAPSULE_HEIGHT  =  0.7;   // inner segment length (total = height + 2*radius)

const FRICTION = 1.5;
// for collision, Tune this value (smaller = more accurate, more expensive)
const MAX_STEP = 0.5;

// Slope angle (radians) beyond which a surface is a wall, not ground
const SLOPE_LIMIT     = Math.PI / 4;  // 45°
const rad90 = Math.PI/2;// 90°

// ── Key map ───────────────────────────────────────────────────
const KEYS = {
  FORWARD : ['KeyW', 'ArrowUp'],
  BACK    : ['KeyS', 'ArrowDown'],
  LEFT    : ['KeyA', 'ArrowLeft'],
  RIGHT   : ['KeyD', 'ArrowRight'],
  JUMP    : ['Space'],
  SPRINT  : ['ShiftLeft', 'ShiftRight'],
};

// ── Scratch objects (module-level — no allocation per frame) ──
const _up        = new THREE.Vector3(0, 1, 0);


// ─────────────────────────────────────────────────────────────
export class RoamingControls {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {THREE.Scene}             scene
   * @param {HTMLElement}             domElement
   */
  constructor(camera, scene, domElement) {
    this._camera = camera;
    this._scene  = scene;
    this._dom    = domElement;
    this._active = false;

    // Set externally by WorldBuilder / SceneManager after each world build.
    // Each entry is a THREE.Mesh whose geometry already has a boundsTree (BVH).
    this.collidables = [];

    // ── Camera state ─────────────────────────────────────────
    this._yaw      = 0;
    this._pitch    = -10;
    this._boomLen  = BOOM_LENGTH;
    this._camTarget = new THREE.Vector3();
    this._firstTick = true;

    // Instance-level sensitivity (can be overridden by Settings panel)
    this._mouseSensX = MOUSE_SENS_X;
    this._mouseSensY = MOUSE_SENS_Y;

    // Scratch — camera
    this._boomDir  = new THREE.Vector3();
    this._pivot    = new THREE.Vector3();
    this._idealCam = new THREE.Vector3();
    this._camDir   = new THREE.Vector3();
    this._camRay   = new THREE.Raycaster();
    this._camRay.firstHitOnly = true;

    // ── Character physics state ───────────────────────────────
    // Feet position (bottom of capsule)
    this._charPos     = new THREE.Vector3();
    // The collider mesh is a simple invisible object whose world-space
    // position is the CENTRE of the capsule (feet + radius + height/2).
    this._colliderMesh = (() => {
      const m = new THREE.Mesh(
        new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HEIGHT, 2, 8),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      scene.add(m);
      return m;
    })();

    // Velocity components — mirrors customMovement.js split
    this._accelAccum    = new THREE.Vector3();  // ground horizontal inertia
    this._airNudgeAccum = new THREE.Vector3();  // air lateral nudge
    this._gravityAccum  = 0;                    // vertical accumulator (signed)
    this._velocity      = new THREE.Vector3();  // composite each frame

    // Surface state
    this._onSurface    = false;   // touching any collidable surface this frame
    this._targetUp     = new THREE.Vector3(0, 1, 0); // current "up" for the character
    this._wallRiding   = false;
    this._wallRideAngle = 0;      // angle between targetUp and world up
    this._inertiaMax   = 0;
    this._inertiaCurr  = 0;
    this._inertiaRefreshCurr = 0;
    this._airJumpCount = 0;       // mid-air jumps used

    // Input helpers
    this._prevJump = false;

    // Probe ray (fallback when BVH not available)
    this._probeRay    = new THREE.Raycaster();
    this._probeRay.firstHitOnly = true;
    this._probeOrigin = new THREE.Vector3();
    this._probeDown   = new THREE.Vector3(0, -1, 0);

    // ── Input state ───────────────────────────────────────────
    this._keys = {};

    // Bound handlers
    this._onKeyDown     = this._onKeyDown.bind(this);
    this._onKeyUp       = this._onKeyUp.bind(this);
    this._onMouseMove   = this._onMouseMove.bind(this);
    this._onWheel       = this._onWheel.bind(this);
    this._onCanvasClick = this._onCanvasClick.bind(this);

    /** Callback fired when the player presses Escape. */
    this.onExit = null;
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  activate(spawnPos, yawDeg = 0) {
    if (this._active) return;
    this._active    = true;
    this._yaw       = THREE.MathUtils.degToRad(yawDeg);
    this._pitch     = -10;
    this._boomLen   = BOOM_LENGTH;
    this._firstTick = true;

    // Place character at spawn
    this._charPos.copy(spawnPos);
    this._syncColliderToFeet();

    // Reset physics
    this._accelAccum.set(0, 0, 0);
    this._airNudgeAccum.set(0, 0, 0);
    this._gravityAccum  = 0;
    this._velocity.set(0, 0, 0);
    this._onSurface     = false;
    this._wallRiding    = false;
    this._targetUp.set(0, 1, 0);
    this._airJumpCount  = 0;
    this._inertiaMax    = 0;
    this._inertiaCurr   = 0;
    this._prevJump      = false;

    this.tempBox = new THREE.Box3();
    this.tempMat = new THREE.Matrix4();
    this.tempSegment = new THREE.Line3();
    this.triclone = new THREE.Triangle();

    this._bindEvents();
    this._requestPointerLock();
  }

  deactivate() {
    if (!this._active) return;
    this._active = false;
    this._unbindEvents();
    if (document.pointerLockElement === this._dom) document.exitPointerLock();
  }

  /**
   * Called every frame from SceneManager's animate loop.
   * Returns the current feet position so the character mesh can be synced.
   */
  tick(dt) {
    if (!this._active) return this._charPos;
    //this._updatePhysics(dt);
    this._positionCamera(dt);
    return this._charPos;
  }

  get isActive() { return this._active; }


  // ── Helpers ───────────────────────────────────────────────────

  /** Sync the invisible collider's centre Y from the feet position. */
  _syncColliderToFeet() {
    this._colliderMesh.position.set(
      this._charPos.x,
      this._charPos.y + CAPSULE_RADIUS + CAPSULE_HEIGHT * 0.5,
      this._charPos.z
    );
    this._colliderMesh.updateMatrixWorld();
  }

  /** Derive feet from collider centre (inverse of above). */
  _syncFeetFromCollider() {
    this._charPos.set(
      this._colliderMesh.position.x,
      this._colliderMesh.position.y - CAPSULE_RADIUS - CAPSULE_HEIGHT * 0.5,
      this._colliderMesh.position.z
    );
  }

  /** Return the triangle normal with the highest Y component (most "ground-like"). */
  _flattest(list) {
    if (!list || !list.length) return null;
    let best = null, bestY = -Infinity;
    for (const n of list) {
      if (n.y > bestY) { bestY = n.y; best = n; }
    }
    return best;
  }

  _teleportToOrigin() {
    this._charPos.set(0, 5, 0);
    this._syncColliderToFeet();
    this._accelAccum.set(0, 0, 0);
    this._airNudgeAccum.set(0, 0, 0);
    this._gravityAccum = 0;
    this._targetUp.set(0, 1, 0);
  }

  // ═══════════════════════════════════════════════════════════
  // Collision
  // ═══════════════════════════════════════════════════════════
  
  _worldCollision(deltaPosition){
    // adjust player position based on collisions
    this._colliderMesh.updateMatrixWorld();
    this.tempBox.makeEmpty();

    let gtp = [];
    let tp = [];
    let ngtp = [];
    let intersects = [];
    StartCloneUse();
    const deltaVector = GetMiscVect();
    let miscvect = GetMiscVect();
    let miscvect2 = GetMiscVect();
    for(let i = 0, max = this._scene.collidables.length; i < max; i++){
      let col = this._scene.collidables[i];
      this.tempMat.copy(col.matrixWorld).invert();
      this.tempSegment.copy(this._colliderMesh.matrixWorld).applyMatrix4(this.tempMat);
      // get the position of the capsule in the local space of the collider
      this.tempSegment.start.applyMatrix4(this._colliderMesh.matrixWorld).applyMatrix4(this.tempMat);
      this.tempSegment.end.applyMatrix4(this._colliderMesh.matrixWorld).applyMatrix4(this.tempMat);
      // get the axis aligned bounding box of the capsule
      this.tempBox.expandByPoint(this.tempSegment.start);
      this.tempBox.expandByPoint(this.tempSegment.end);
      this.tempBox.min.addScalar(-this._colliderMesh.radius);
      this.tempBox.max.addScalar(this._colliderMesh.radius);
      col.geometry.boundsTree.shapecast({
        intersectsBounds: box => box.intersectsBox( this.tempBox ),
        intersectsTriangle: tri => {
          // check if the triangle is intersecting the capsule and adjust the
          // capsule position if it is.
          const triPoint = deltaPosition;
          const capsulePoint = miscvect2;
          const distance = tri.closestPointToSegment(this.tempSegment, triPoint, capsulePoint);
          if(distance < this._colliderMesh.radius){
            const depth = this._colliderMesh.radius - distance;
            const direction = capsulePoint.sub(triPoint).normalize();
            this.tempSegment.start.addScaledVector(direction, depth);
            this.tempSegment.end.addScaledVector(direction, depth);
            tri.getNormal(miscvect);
            this.triclone.copy(tri);
            let mini = {
              x: miscvect.x,
              y: miscvect.y,
              z: miscvect.z
            };
            tp.push(mini);
            if(_up.angleTo(miscvect) < SLOPE_LIMIT){
              if(mini.y < 0){
                ngtp.push(mini);
              }else{
                gtp.push(mini);
              }
            }else{
              if(mini.y >= 0){
                ngtp.push(mini);
              }
            }
          }
        }
      });

      // get the adjusted position of the capsule collider in world space after checking
      // triangle collisions and moving it. capsuleInfo.segment.start is assumed to be
      // the origin of the player model.
      const newPosition = deltaPosition;
      newPosition,copy(this.tempSegment.start).applyMatrix4(col.matrixWorld);
      // check how much the collider was moved
      deltaVector.subVectors(newPosition, this._colliderMesh.position);
      const offset = Math.max(0,0,deltaVector.length() - 1e-5);
      deltaVector.normalize().multiplyScalar(offset);
      intersects.push(CloneVector3(deltaVector));

    }
    return {
      intersects: intersects,
      delta: deltaVector,
      tripoints: tp,
      groundtripoints: gtg,
      notgroundpoints: ngtp
    }
  }
  //playercontrols?


  // ═══════════════════════════════════════════════════════════
  // CAMERA  (retained from original roamingControls.js)
  // ═══════════════════════════════════════════════════════════

  _positionCamera(dt) {
    const pitchRad = THREE.MathUtils.degToRad(this._pitch);
    const cosPitch = Math.cos(pitchRad);
    const sinPitch = Math.sin(pitchRad);

    // Eye pivot — character feet + use-height
    this._pivot.copy(this._charPos);
    this._pivot.y += USE_HEIGHT;

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
    StartCloneUse();
    
    this._camDir.subVectors(idealPos, pivot).normalize();
    const dist = pivot.distanceTo(idealPos);
    this._camRay.set(pivot, this._camDir);
    this._camRay.far = dist + CAM_COLLISION_R;

    if (!this.collidables || !this.collidables.length) return idealPos;

    for (const mesh of this.collidables) {
      const hits = this._camRay.intersectObject(mesh, false);
      if (hits.length && hits[0].distance < dist) {
        const safeDist = Math.max(1.5, hits[0].distance - CAM_COLLISION_R);
        return CloneVector3(pivot).addScaledVector(this._camDir, safeDist);
      }
    }
    return idealPos;
  }

  // ═══════════════════════════════════════════════════════════
  // INPUT
  // ═══════════════════════════════════════════════════════════

  _key(codes) { return codes.some(c => this._keys[c]); }

  _onKeyDown(e) {
    if (!this._active) return;
    this._keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
    // Escape: exit roaming
    /*
    if (e.code === 'Escape') {
      if (typeof this.onExit === 'function') this.onExit();
    }
    */
  }

  _onKeyUp(e) { this._keys[e.code] = false; }

  _onMouseMove(e) {
    if (!this._active || !document.pointerLockElement) return;
    this._yaw   -= (e.movementX ?? 0) * this._mouseSensX * (Math.PI / 180);
    this._pitch  = THREE.MathUtils.clamp(
      this._pitch + (e.movementY ?? 0) * this._mouseSensY,
      PITCH_MIN, PITCH_MAX
    );
  }

  _onWheel(e) {
    if (!this._active) return;
    e.preventDefault();
    this._boomLen = THREE.MathUtils.clamp(
      this._boomLen + (e.deltaY > 0 ? 1 : -1) * BOOM_ZOOM_SPD,
      BOOM_MIN, BOOM_MAX
    );
  }

  _onCanvasClick() {
    if (this._active && !document.pointerLockElement) this._requestPointerLock();
  }

  _requestPointerLock() {
    try { this._dom.requestPointerLock(); } catch (_) {}
  }

  _bindEvents() {
    document.addEventListener('keydown',   this._onKeyDown,    { capture: false });
    document.addEventListener('keyup',     this._onKeyUp,      { capture: false });
    document.addEventListener('mousemove', this._onMouseMove,  { capture: false });
    this._dom.addEventListener('wheel',    this._onWheel,      { passive: false });
    this._dom.addEventListener('click',    this._onCanvasClick);
  }

  _unbindEvents() {
    document.removeEventListener('keydown',   this._onKeyDown);
    document.removeEventListener('keyup',     this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    this._dom.removeEventListener('wheel',    this._onWheel);
    this._dom.removeEventListener('click',    this._onCanvasClick);
    this._keys = {};
  }

  // ── Cleanup ───────────────────────────────────────────────────
  dispose() {
    this.deactivate();
    if (this._colliderMesh) {
      this._scene.remove(this._colliderMesh);
      this._colliderMesh.geometry.dispose();
      this._colliderMesh.material.dispose();
      this._colliderMesh = null;
    }
  }
}
