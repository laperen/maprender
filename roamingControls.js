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
const CHAR_HEIGHT     =  1.7;   // visual / eye height

const MAX_SPEED       = 20;     // world-units/sec top speed
const MAX_TOTAL_SPEED = 50;     // absolute max speed
const AIR_NUDGE       = 10;     // lateral speed while airborne
const JUMP_FORCE      =  7;     // upward impulse on jump
const GRAVITY_ACC     = -9.81;    // world-units/sec²
const MAX_JUMP_COUNT  =  2;     // allow double-jump
const WALL_RIDE_THRESH =  2;    // min speed² to initiate wall-ride
const INERTIA_REFRESH  =  0.5;  // seconds between wall-ride inertia top-ups
const SPRINT_MULT     =  2.0;

const FRICTION = 1.5;
// for collision, Tune this value (smaller = more accurate, more expensive)
const MAX_STEP = 0.5;

// Slope angle (radians) beyond which a surface is a wall, not ground
const SLOPE_LIMIT     = Math.PI / 4;  // 45°

// Ground-probe fallback origin (used when BVH unavailable)
const GROUND_PROBE_Y  = 2000;

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
const _misc      = new THREE.Vector3();
const _tempBox   = new THREE.Box3();
const _tempMat   = new THREE.Matrix4();
const _tempSeg   = new THREE.Line3();
const _capsuleA  = new THREE.Vector3();  // segment start (world)
const _capsuleB  = new THREE.Vector3();  // segment end   (world)
const _triNormal = new THREE.Vector3();
const _triPoint  = new THREE.Vector3();
const _capPoint  = new THREE.Vector3();
const _delta     = new THREE.Vector3();
const _newPos    = new THREE.Vector3();


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
    this._updatePhysics(dt);
    this._positionCamera(dt);
    return this._charPos;
  }

  get isActive() { return this._active; }

  // ═══════════════════════════════════════════════════════════
  // PHYSICS UPDATE  (ported from customMovement.js)
  // ═══════════════════════════════════════════════════════════

  _updatePhysics(dt) {
    const jumpPressed = this._key(KEYS.JUMP);
    // Edge-detect — only trigger on the frame the key is first pressed
    const jumpTrigger = jumpPressed && !this._prevJump;
    this._prevJump = jumpPressed;

    const moving = this._key(KEYS.FORWARD) || this._key(KEYS.BACK) ||
                   this._key(KEYS.LEFT)    || this._key(KEYS.RIGHT);
    const speed  = MAX_SPEED * (this._key(KEYS.SPRINT) ? SPRINT_MULT : 1);

    // Build horizontal input direction in world space (yaw only)
    const fwdX = Math.sin(this._yaw), fwdZ = Math.cos(this._yaw);
    const rtX  = Math.cos(this._yaw), rtZ  = -Math.sin(this._yaw);
    const fB   = (this._key(KEYS.FORWARD) ? 1 : 0) - (this._key(KEYS.BACK)  ? 1 : 0);
    const lR   = (this._key(KEYS.LEFT)    ? 1 : 0) - (this._key(KEYS.RIGHT) ? 1 : 0);
    _misc.set(fwdX * fB + rtX * lR, 0, fwdZ * fB + rtZ * lR);

    if (_misc.lengthSq() > 0) {
      _misc.normalize();
      _misc.projectOnPlane(this._targetUp).normalize();

      // 🔑 If wall riding, restrict input to current motion direction
      if (this._wallRiding && this._velocity.lengthSq() > 0) {
        const wallForward = this._velocity.clone().normalize();
      
        // Project input onto current travel direction (like grinding)
        const alignment = _misc.dot(wallForward);
      
        if (alignment > 0) {
          _misc.copy(wallForward).multiplyScalar(alignment);
        } else {
          // Prevent reversing direction on wall
          _misc.set(0, 0, 0);
        }
      }
    }
    // _misc is now the unit horizontal input direction

    // ── Ground vs air movement ────────────────────────────────
    const reverseDamping = Math.exp(-4 * dt);
    

    if (this._velocity.length() > MAX_TOTAL_SPEED) {
      this._velocity.setLength(MAX_TOTAL_SPEED);
    }
    if (this._onSurface) {
      this._groundMovement(_misc, moving, speed, dt, reverseDamping, jumpTrigger);
    } else {
      this._airMovement(_misc, moving, dt, reverseDamping, jumpTrigger);
    }

    // ── Composite velocity ────────────────────────────────────
    this._velocity.copy(this._accelAccum);
    this._velocity.y += this._gravityAccum;
    this._velocity.add(this._airNudgeAccum);
    if (this._onSurface && _misc.lengthSq() > 0 && this._velocity.lengthSq() > 0) {
      const turnSpeed = 6.0;
    
      const desired = _misc.clone().multiplyScalar(this._velocity.length());
      this._velocity.lerp(desired, 1 - Math.exp(-turnSpeed * dt));
    }

    // ── Move and resolve collisions ───────────────────────────
    this._surfaceDetection(dt);

    // ── OOB check ─────────────────────────────────────────────
    if (this._charPos.y < -25) this._teleportToOrigin();
  }

  // ── Ground movement (mirrors GroundMovement in customMovement.js) ─
  _groundMovement(inputDir, moving, speed, dt, reverseDamping, jumpTrigger) {
    const speedDelta = dt * speed;

    if (moving) {
      // Accelerate in input direction
      _misc.copy(inputDir).multiplyScalar(speedDelta);
      this._accelAccum.add(_misc);
    } else {
      // Apply smooth friction instead of hard stop
      const frictionFactor = Math.exp(-FRICTION * dt);
      this._accelAccum.multiplyScalar(frictionFactor);
      if (this._onSurface) {
        const rollDrag = 0.98;
        this._accelAccum.multiplyScalar(rollDrag);
      }
    }
    const horizontalSpeed = Math.hypot(this._accelAccum.x, this._accelAccum.z);
    if (horizontalSpeed > speed) {
      const scale = speed / horizontalSpeed;
      this._accelAccum.x *= scale;
      this._accelAccum.z *= scale;
    }
    
    // Always damp vertical a bit
    this._accelAccum.y *= reverseDamping;

    if (jumpTrigger) {
      const wallPct = this._wallRideAngle / (Math.PI / 2);

      // Transition to air — halve horizontal inertia
      this._accelAccum.multiplyScalar(
        THREE.MathUtils.lerp(1.0, (MAX_SPEED - AIR_NUDGE) / MAX_SPEED, 1)
      );
      // Reflect over targetUp (wall jump launches along surface normal)
      this._accelAccum.reflect(this._targetUp);

      _misc.copy(this._targetUp).multiplyScalar(JUMP_FORCE * wallPct);
      this._accelAccum.add(_misc);

      this._gravityAccum = JUMP_FORCE * (1 - wallPct) + this._accelAccum.y;
      this._accelAccum.y = 0;

      // After jumping off a wall, face away from it
      if (this._wallRiding) {
        // flip forward direction — handled by yaw not changing here; feel is fine
      }

      this._targetUp.set(0, 1, 0);
      this._inertiaMax = 0;
      this._onSurface  = false;
    }
  }

  // ── Air movement (mirrors AirMovement in customMovement.js) ──
  _airMovement(inputDir, moving, dt, reverseDamping, jumpTrigger) {
    if (moving) {
      _misc.copy(inputDir).multiplyScalar(AIR_NUDGE * dt);
      this._airNudgeAccum.add(_misc);
      this._airNudgeAccum.multiplyScalar(reverseDamping);
    }

    // Mid-air jump (double jump)
    if (jumpTrigger && this._airJumpCount < MAX_JUMP_COUNT) {
      this._airJumpCount++;
      this._gravityAccum = JUMP_FORCE;
      this._targetUp.set(0, 1, 0);
    }
  }

  // ── Surface detection & capsule collision resolve ─────────────
  // (ported from SurfaceDetection + WorldCollision in customMovement/customCollision.js)
  _surfaceDetection(dt) {
    // 🔑 Break movement into smaller steps to prevent tunneling
    const totalMove = _misc.copy(this._velocity).multiplyScalar(dt);


    const steps = Math.ceil(totalMove.length() / MAX_STEP);
    const stepMove = totalMove.clone().multiplyScalar(1 / steps);

    let result = { intersects: false, groundTris: [], notGroundTris: [] };

    for (let i = 0; i < steps; i++) {
      // Move a small step
      this._colliderMesh.position.add(stepMove);
      this._colliderMesh.updateMatrixWorld();

      // Resolve collision at this step
      const stepResult = this._worldCollision(stepMove);

      this._colliderMesh.position.add(stepResult.delta);
      this._colliderMesh.updateMatrixWorld();

      // Accumulate results (for surface logic later)
      if (stepResult.intersects) {
        result.intersects = true;
        result.groundTris.push(...stepResult.groundTris);
        result.notGroundTris.push(...stepResult.notGroundTris);
      }
    }

    // Derive feet position from collider centre
    this._syncFeetFromCollider();
    if (this._onSurface) {
      // 🔑 Remove ALL velocity into the surface (not just negative)
      const normalComponent = this._velocity.dot(this._targetUp);
    
      _misc.copy(this._targetUp).multiplyScalar(normalComponent);
      this._velocity.sub(_misc);
    
      // Re-project cleanly
      this._velocity.projectOnPlane(this._targetUp);
      
      // 🔑 Extra: lock direction when wall riding
      if (this._wallRiding && this._velocity.lengthSq() > 0) {
        // Wall forward = direction along wall surface
        const wallForward = _misc
          .copy(this._velocity)
          .projectOnPlane(this._targetUp)
          .normalize();

        const speed = this._velocity.length();

        // Rebuild velocity strictly along wall
        this._velocity.copy(wallForward.multiplyScalar(speed));
      }
    }
    // ── Surface normal analysis ────────────────────────────────
    let tempUp = this._targetUp.clone();

    if (result.intersects) {
      const gp = this._flattest(result.groundTris);
      if (gp) {
        tempUp.set(gp.x, gp.y, gp.z);
        this._wallRiding = false;
      } else {
        const wp = this._flattest(result.notGroundTris);
        const spd2 = this._velocity.lengthSq();
        if (wp && spd2 > WALL_RIDE_THRESH * WALL_RIDE_THRESH &&
            this._accelAccum.lengthSq() > WALL_RIDE_THRESH * WALL_RIDE_THRESH) {
          this._wallRiding = this._wallRideAngle >= SLOPE_LIMIT;
          tempUp.set(wp.x, wp.y, wp.z);
        }
      }
    }

    // Gravity accumulation
    if (this._onSurface) {
      // 🔑 Gravity along slope (causes downhill acceleration)
      const gravityVec = _misc.set(0, GRAVITY_ACC, 0);
    
      const tangentGravity = gravityVec.projectOnPlane(this._targetUp);
      this._velocity.addScaledVector(tangentGravity, dt);
    
      // 🔑 Small stick force to keep contact
      const stickForce = 6.0;
      this._velocity.addScaledVector(this._targetUp, -stickForce * dt);
    } else {
      this._gravityAccum += dt * GRAVITY_ACC;
    }

    // Angle of surface vs world up
    const angDiff = this._targetUp.angleTo(tempUp);
    if (angDiff > SLOPE_LIMIT) {
      this._inertiaMax  = 0; // reset on sharp surface change
    }

    // Tick wall-ride inertia
    this._inertiaCurr = THREE.MathUtils.clamp(
      this._inertiaCurr - dt, 0, this._inertiaMax
    );

    if (this._wallRiding) {
      this._inertiaRefreshCurr = THREE.MathUtils.clamp(
        this._inertiaRefreshCurr - dt, 0, INERTIA_REFRESH
      );
      if (this._inertiaCurr <= 0) {
        tempUp.set(0, 1, 0);
        this._wallRiding = false;
      }
    } else {
      if (this._onSurface) this._inertiaMax = 0;
      if (this._inertiaMax <= 0 && angDiff > SLOPE_LIMIT) {
        const vLen = this._accelAccum.length() * 0.8;
        this._inertiaMax  = vLen;
        this._inertiaCurr = vLen;
      }
    }

    // Probe for actual surface contact below the character
    const surfaceBelow = this._probeSurface(tempUp);

    if (this._wallRiding) {
      this._inertiaRefreshCurr = THREE.MathUtils.clamp(
        this._inertiaRefreshCurr - dt, 0, INERTIA_REFRESH
      );
      // Replenish inertia while sliding along wall
      if (this._inertiaRefreshCurr <= 0 && surfaceBelow) {
        this._inertiaCurr = THREE.MathUtils.clamp(
          this._inertiaCurr + this._inertiaMax * 0.1,
          0, this._inertiaMax
        );
        this._inertiaRefreshCurr = INERTIA_REFRESH;
      }
    }
    
    if (this._wallRiding && this._inertiaMax > 0) {
      const climbFactor = this._inertiaCurr / this._inertiaMax;
    
      // As inertia fades → push player down along wall
      const downForce = (1 - climbFactor) * 5.0;
    
      _misc.copy(this._targetUp).multiplyScalar(-downForce * dt);
      this._velocity.add(_misc);
    }

    if (surfaceBelow) {
      if (result.intersects) {
        // Just landed or still grounded
        this._airNudgeAccum.set(0, 0, 0);
        this._airJumpCount = 0;
        if (!this._wallRiding || (this._wallRiding && this._inertiaMax > 0 && this._inertiaCurr > 0)) {
          // Clamp gravity so it doesn't accumulate underground
          this._gravityAccum = dt * GRAVITY_ACC;
        }
      }
      this._targetUp.copy(surfaceBelow);
    }
    if (this._onSurface && !this._wallRiding) {
      // 🔑 Damp tiny vertical jitter
      if (Math.abs(this._velocity.y) < 0.5) {
        this._velocity.y = 0;
      }
    }

    this._wallRideAngle = this._targetUp.angleTo(_up);
    this._onSurface     = result.intersects;
  }

  // ── BVH capsule vs world (mirrors WorldCollision in customCollision.js) ──
  _worldCollision(deltaPosition) {
    const groundTris    = [];
    const notGroundTris = [];
  
    if (!this.collidables || !this.collidables.length) {
      return { intersects: false, delta: new THREE.Vector3(), groundTris, notGroundTris };
    }
  
    // Work entirely in world space. Keep a running world-space capsule centre
    // that accumulates corrections from every collidable in the loop.
    const colliderPos = this._colliderMesh.position.clone();
    let anyHit = false;
  
    for (const mesh of this.collidables) {
      const bvh = mesh.geometry?.boundsTree;
      if (!bvh) continue;
  
      // Transform capsule segment endpoints to mesh local space
      _tempMat.copy(mesh.matrixWorld).invert();
  
      const segStart = new THREE.Vector3(
        colliderPos.x,
        colliderPos.y - CAPSULE_HEIGHT * 0.5,
        colliderPos.z
      ).applyMatrix4(_tempMat);
  
      const segEnd = new THREE.Vector3(
        colliderPos.x,
        colliderPos.y + CAPSULE_HEIGHT * 0.5,
        colliderPos.z
      ).applyMatrix4(_tempMat);
  
      _tempSeg.set(segStart, segEnd);
  
      _tempBox.makeEmpty();
      _tempBox.expandByPoint(segStart);
      _tempBox.expandByPoint(segEnd);
      _tempBox.min.subScalar(CAPSULE_RADIUS);
      _tempBox.max.addScalar(CAPSULE_RADIUS);
  
      let meshHit = false;
  
      bvh.shapecast({
        intersectsBounds: box => box.intersectsBox(_tempBox),
        intersectsTriangle: tri => {
          const triPt = _triPoint;
          const capPt = _capPoint;
          const dist  = tri.closestPointToSegment(_tempSeg, triPt, capPt);
  
          if (dist < CAPSULE_RADIUS) {
            meshHit = true;
            anyHit  = true;
            const depth = (CAPSULE_RADIUS - dist) * 0.8;
            const direction = capPt.clone().sub(triPt).normalize();
  
            _tempSeg.start.addScaledVector(direction, depth);
            _tempSeg.end.addScaledVector(direction, depth);
  
            tri.getNormal(_triNormal);
            // Transform normal to world space
            _triNormal.transformDirection(mesh.matrixWorld).normalize();
            const n = { x: _triNormal.x, y: _triNormal.y, z: _triNormal.z };
  
            const angle = _up.angleTo(_triNormal);
            if (angle < SLOPE_LIMIT) {
              if (n.y < 0) notGroundTris.push(n);
              else         groundTris.push(n);
            } else {
              if (n.y >= 0) notGroundTris.push(n);
            }
          }
          return false;
        },
      });
  
      if (meshHit) {
        // Convert corrected segment midpoint back to world space to get new collider centre
        const correctedCentre = new THREE.Vector3()
          .addVectors(_tempSeg.start, _tempSeg.end)
          .multiplyScalar(0.5)
          .applyMatrix4(mesh.matrixWorld);
  
        // Accumulate the world-space correction into colliderPos
        colliderPos.copy(correctedCentre);
      }
    }
  
    _delta.subVectors(colliderPos, this._colliderMesh.position);
  
    return {
      intersects:   anyHit,
      delta:        _delta.clone(),
      groundTris,
      notGroundTris,
    };
  }

  // ── Probe downward from character for surface contact ─────────
  // Returns the surface normal THREE.Vector3 or null.
  _probeSurface(tempUp) {
    if (!this.collidables || !this.collidables.length) return null;

    // Cast a short ray in the -targetUp direction from just above feet
    const origin = this._charPos.clone();
    origin.y += CAPSULE_RADIUS * 2;
    _misc.copy(tempUp).negate();

    this._probeRay.set(origin, _misc);
    this._probeRay.far = CAPSULE_RADIUS * 4 + 0.3;

    for (const mesh of this.collidables) {
      const hits = this._probeRay.intersectObject(mesh, false);
      if (hits.length) return hits[0].face ? hits[0].face.normal.clone() : tempUp.clone();
    }
    return null;
  }

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
    this._camDir.subVectors(idealPos, pivot).normalize();
    const dist = pivot.distanceTo(idealPos);
    this._camRay.set(pivot, this._camDir);
    this._camRay.far = dist + CAM_COLLISION_R;

    if (!this.collidables || !this.collidables.length) return idealPos;

    for (const mesh of this.collidables) {
      const hits = this._camRay.intersectObject(mesh, false);
      if (hits.length && hits[0].distance < dist) {
        const safeDist = Math.max(1.5, hits[0].distance - CAM_COLLISION_R);
        return pivot.clone().addScaledVector(this._camDir, safeDist);
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
