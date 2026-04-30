// roamingControls.js — Third-person boom-arm camera + capsule-collision physics.

import * as THREE from 'three';
import {StartCloneUse,GetMiscVect,CloneVector3,CheckVector3Equals} from './mrUtils.js';

let player = {
  //rendering settings
  //meshpath: "./assets/kazu.glb",
  //texturepath: "./assets/kazu_tex.png",
  //renderstyle: RenderStyle.Toon,//ignored if texture path isn't provided
  //castShadow: false,
  //receiveShadow: false,
  //collision settings
  charHeight: 1.7,
  //groundColliderData: CapsuleColliderData(0.5, 1),
  //collisiontag: CollisionTags.Actors,
  //rendering
  //visualMesh: null,
  //groundColliderMesh: null,
  //controls
  inputDir: new THREE.Vector3(),
  forwardDir: new THREE.Vector3(),
  intersected: false,
  moving: false,
  jump: false,
  prevJump: false,
  wallDir: null,
  //stats
  gravity: -10,
  maxSpeed: 50,// 20, //mps = meters per second. downhill on rollerblades: 37mps. fastest mobility scooter: 45mps
  airNudge: 10,
  jumpForce: 7,
  wallRideThreshold: 2,
  inertiaRefeshTime: 0.5,
  maxjumpcount: 2,
  //generated
  airMovePercentage: 0,
  wallRideThresholdSqr: 0,
  useHeight: 0,
  maxSpeedSqr: 0,
  airjumpcount: 0,
  //simulation
  targetup: new THREE.Vector3(0,1,0),
  velocity: new THREE.Vector3(),
  velocityDir: new THREE.Vector3(),
  accelAccum: new THREE.Vector3(),
  airNudgeAccum: new THREE.Vector3(),
  gravityAccum: 0,
  inertiamax: 0,
  inertiacurr: 0,
  majorAxisChange: false,
  axisOfChange: new THREE.Vector3(),
  angleOfChange: 0,
  wallrideangle: 0,
  wallriding: false,
  currRefresh: 0,
  //visuals
  facingDir: new THREE.Vector3()
}
const STEPS_PER_FRAME = 5;
let keyStates = {};
// ── Tunables — character ──────────────────────────────────────
const CAPSULE_RADIUS  =  0.5;   // metres — half-width of collision capsule
const CAPSULE_HEIGHT  =  0.7;   // inner segment length (total = height + 2*radius)
const closeToZero = 0.001 * 0.001;
const zerovect = new THREE.Vector3(0,0,0);

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
const rad90 = Math.PI/2;
const upVector = new THREE.Vector3( 0, 1, 0 );

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
    // Bound handlers
    this._onKeyDown     = this._onKeyDown.bind(this);
    this._onKeyUp       = this._onKeyUp.bind(this);
    this._onMouseMove   = this._onMouseMove.bind(this);
    this._onWheel       = this._onWheel.bind(this);
    this._onCanvasClick = this._onCanvasClick.bind(this);

    /** Callback fired when the player presses Escape. */
    this.onExit = null;

    
    this.maxCamDist = 3;
    this.camraycaster = new THREE.Raycaster();
    this.camraycaster.firstHitOnly = true;
    this.camraycaster.far = this.maxCamDist;

    this.camboom = new THREE.Group();
    this.camboom.rotation.set(0,0,0);
    this.camvert =  new THREE.Group();
    this.camboom.add(this.camvert);
    this.camvert.rotation.set(0,0,0);

    this.mousex = 0;
    this.mousey = 0;
    this.mcount = false;
    this.prevmcount = false;

    this.camYDelta = 0;
    this.camXDelta = 0;
    this.camX = 0;

    this._spawnPos;
    this.surfacehit;

    this.tempBox = new THREE.Box3();
    this.tempMat = new THREE.Matrix4();
    this.tempSegment = new THREE.Line3();
    this.triclone = new THREE.Triangle();
    this.tempVector2 = new THREE.Vector3();
    this.slopelimit = Math.PI/4;
    this.charraycaster = new THREE.Raycaster();
    this.charraycaster.firstHitOnly = true;
    this.lastGroundPos = new THREE.Vector3();
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  activate(spawnPos, yawDeg = 0, visualMesh = null) {
    StartCloneUse();
    if (this._active) return;
    this._active    = true;
    this._spawnPos = CloneVector3(spawnPos);
    player.visualMesh = visualMesh;
    this._spawnPos.y += 5;
    //
    this._bindEvents();
    this._requestPointerLock();
    player.airMovePercentage = (player.maxSpeed-player.airNudge)/player.maxSpeed;
    player.useHeight = player.charHeight - CAPSULE_RADIUS;
    player.maxSpeedSqr = player.maxSpeed * player.maxSpeed;
    player.wallRideThresholdSqr = player.wallRideThreshold * player.wallRideThreshold;
    this.charraycaster.far = CAPSULE_RADIUS + 0.3;
    this.capsuleSegment = new THREE.Line3( new THREE.Vector3(0,0,0), new THREE.Vector3(0,player.useHeight-CAPSULE_RADIUS,0) )
    this._colliderMesh.position.copy(this._spawnPos);//.set(this.spawnPos.x,this.spawnPos.y,this.spawnPos.z);
    this.SetupCamera(player);
    this.camvert.add(this._camera);
  }

  deactivate() {
    if (!this._active) return;
    this._camera.removeFromParent();
    this._active = false;
    this._unbindEvents();
    if (document.pointerLockElement === this._dom) document.exitPointerLock();
    player.visualMesh = null;
  }

  /**
   * Called every frame from SceneManager's animate loop.
   * Returns the current feet position so the character mesh can be synced.
   */
  tick(dt) {
    if (!this._active) return this._charPos;
    //run updates here
	  const deltaTime = Math.min( dt, 0.1 ) / STEPS_PER_FRAME;
    for ( let i = 0; i < STEPS_PER_FRAME; i ++ ) {
      this.SurfaceDetection(player, deltaTime);//must come before playerControls for surface conforming movement and y rotation to work properly
    }
    this.playerControls(player, dt);
    this.ApplyControls(player, dt);
    this.updateCamera(player, dt);
    this._teleportOOB(player);
    this.SetFacings(player);
    this.ApplyVelocity(player);
    return this._charPos;
  }

  get isActive() { return this._active; }
  _teleportOOB(actor) {
    if (this._colliderMesh.position.y <= - 25 ) {
      actor.accelAccum.set(0,0,0);
      actor.airNudgeAccum.set(0,0,0);
      actor.gravityAccum = 0;
      actor.targetup.copy(upVector);
      console.log(this.lastGroundPos);
      this._colliderMesh.position.copy(this.lastGroundPos);//.set(this.spawnPos.x,this.spawnPos.y,this.spawnPos.z);
    }
  }
  // ═══════════════════════════════════════════════════════════
  // INPUT
  // ═══════════════════════════════════════════════════════════

  _key(codes) { return codes.some(c => keyStates[c]); }

  _onKeyDown(e) {
    if (!this._active) return;
    keyStates[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
  }

  _onKeyUp(e) { keyStates[e.code] = false; }

  _onMouseMove(e) {
    if (!this._active || !document.pointerLockElement) return;
    this.mousex = -e.movementX;
    this.mousey = -e.movementY;
    this.mcount = !this.mcount;
  }

  _onWheel(e) {
    if (!this._active) return;
    e.preventDefault();
    //adapt for zooming 
    this.maxCamDist = THREE.MathUtils.clamp(
      this.maxCamDist * (e.deltaY > 0 ? 1.1 : 0.9),
      0.5, 20
    );
    this.camraycaster.far = this.maxCamDist;
  }

  // ═══════════════════════════════════════════════════════════
  // COLLISION
  // ═══════════════════════════════════════════════════════════

  WorldCollision(deltaPosition){
    StartCloneUse();
    // adjust player position based on collisions
    this._colliderMesh.updateMatrixWorld();
    let gtp = [];
    //let ctp = [];
    //let wtp = [];
    let tp = [];
    let ngtp = [];
    this.tempBox.makeEmpty();
    let intersection = false;
    let useDelta = GetMiscVect();
    let farx = 0;
    let fary = 0;
    let farz = 0;
    let miscvect = GetMiscVect();
    for(let i = 0, max = this.collidables.length; i < max; i++){
      let mesh = this.collidables[i];
      this.tempMat.copy(mesh.matrixWorld).invert();
      this.tempSegment.copy(this.capsuleSegment);
      // get the position of the capsule in the local space of the collider
      this.tempSegment.start.applyMatrix4(this._colliderMesh.matrixWorld ).applyMatrix4( this.tempMat );
      this.tempSegment.end.applyMatrix4(this._colliderMesh.matrixWorld ).applyMatrix4( this.tempMat );
      // get the axis aligned bounding box of the capsule
      this.tempBox.expandByPoint( this.tempSegment.start );
      this.tempBox.expandByPoint( this.tempSegment.end );
      this.tempBox.min.addScalar( - CAPSULE_RADIUS );
      this.tempBox.max.addScalar( CAPSULE_RADIUS );

      mesh.geometry.boundsTree.shapecast( {
        intersectsBounds: box => box.intersectsBox( this.tempBox ),
        intersectsTriangle: tri => {
          // check if the triangle is intersecting the capsule and adjust the
          // capsule position if it is.
          const triPoint = deltaPosition;
          const capsulePoint = this.tempVector2;
          const distance = tri.closestPointToSegment( this.tempSegment, triPoint, capsulePoint );
          if ( distance < CAPSULE_RADIUS) {
            const depth = CAPSULE_RADIUS - distance;
            const direction = capsulePoint.sub( triPoint ).normalize();
    
            this.tempSegment.start.addScaledVector( direction, depth );
            this.tempSegment.end.addScaledVector( direction, depth );
    
            tri.getNormal(miscvect);
            
            //let ysq = miscvect.y * miscvect.y;
            //let xz =  (miscvect.x * miscvect.x) + (miscvect.z * miscvect.z);
            this.triclone.copy(tri);
            let mini = {
              x: miscvect.x,
              y: miscvect.y,
              z: miscvect.z
            };
            tp.push(mini);
            //if(ysq > xz){
            if(upVector.angleTo(miscvect) < this.slopelimit){//ground tri points not being properly discerned, but ignoring that for now to fix camera rotation
              if(mini.y < 0){
                //ctp.push(mini);
                ngtp.push(mini);
              }else{
                gtp.push(mini);
              }
            }else{
              if(mini.y >= 0 ){
                //wtp.push(mini);
                ngtp.push(mini);
              }
            }
          }
        }
      } );
      const newPosition = deltaPosition;
      newPosition.copy( this.tempSegment.start ).applyMatrix4(mesh.matrixWorld );
      // check how much the collider was moved
      const deltaVector = this.tempVector2;
      deltaVector.subVectors( newPosition, this._colliderMesh.position );
      const offset = Math.max( 0.0, deltaVector.length() - 1e-5 );
      deltaVector.normalize().multiplyScalar( offset );
      let lsq = deltaVector.lengthSq();
      if(!intersection){
        intersection = lsq > 0;
      }
      if (Math.abs(deltaVector.x) > Math.abs(farx)) {
        farx = deltaVector.x;
      }
      if (Math.abs(deltaVector.y) > Math.abs(fary)) {
        fary = deltaVector.y;
      }
      if (Math.abs(deltaVector.z) > Math.abs(farz)) {
        farz = deltaVector.z;
      }
    }
  
    // get the adjusted position of the capsule collider in world space after checking
    // triangle collisions and moving it. capsuleInfo.segment.start is assumed to be
    // the origin of the player model.
    useDelta.set(farx, fary, farz);
    return {
        intersects: intersection,
        delta: useDelta,
        tripoints: tp,
        groundtripoints: gtp,
        notgroundpoints: ngtp
    }
  }
  GetFlatestTriPoint(list){
    if(null == list || list.length <= 0){
      return null;
    }
    let ycheck = -1;
    let retval;
      for(let i = 0, max = list.length; i < max; i++){
          let tri = list[i];
          if(tri.y > ycheck){
              ycheck = tri.y;
              retval = tri;
          }
      }
    return retval;
  }
  checkOnSurface(actor, normal){
    StartCloneUse();
    this.charraycaster.ray.origin.copy(this._colliderMesh.position);
    let miscvect = CloneVector3(normal);//miscvect.copy(normal);
    this.charraycaster.ray.direction.copy(miscvect.negate());
    return this.worldIntersect(this.charraycaster);
  }
  SurfaceDetection(actor, deltaTime){
      StartCloneUse();
      let miscvect = CloneVector3(actor.velocity);
      miscvect.multiplyScalar( deltaTime );
      let prevpos = CloneVector3(this._colliderMesh.position);
      this._colliderMesh.position.add( miscvect );
      let worldCollisionResult = this.WorldCollision(miscvect);//each collision check will be done this way
      this._colliderMesh.position.add( worldCollisionResult.delta );
      let tempUp = CloneVector3(actor.targetup);
      let truespeed = prevpos.sub(this._colliderMesh.position).lengthSq()/(deltaTime * deltaTime);
      //set gravity
      if(worldCollisionResult.intersects){
          if(actor.intersects != worldCollisionResult.intersects && actor.accelAccum.y > 2){
              actor.accelAccum.y = 0;
          }
          let gp = this.GetFlatestTriPoint(worldCollisionResult.groundtripoints);
          if(gp){
              tempUp.set(gp.x, gp.y, gp.z);
              actor.wallriding = false;
          } else {
              let wp = this.GetFlatestTriPoint(worldCollisionResult.notgroundpoints);
              if(wp && truespeed > actor.wallRideThresholdSqr && actor.accelAccum.lengthSq() > actor.wallRideThresholdSqr){
                  actor.wallriding = actor.wallrideangle >= this.slopelimit;
                  tempUp.set(wp.x, wp.y, wp.z);
              }
          }
      }
      actor.gravityAccum += deltaTime * actor.gravity;
      let anglediff = actor.targetup.angleTo(tempUp);
      if(anglediff > this.slopelimit){
          actor.majorAxisChange = true;
          actor.axisOfChange.copy(actor.targetup).cross(tempUp);
          actor.angleOfChange = anglediff;
      }
      actor.inertiacurr = THREE.MathUtils.clamp(actor.inertiacurr - deltaTime, 0, actor.inertiamax); 
      if(actor.wallriding){
          //reduce inertia resource
          /*
          if(isplayer){ 
              inertiaback.style.display = "block";
              inertiabar.style.width = `${actor.inertiacurr/actor.inertiamax * 100}%`;
          }
              */
          if(actor.inertiacurr <= 0){
              tempUp.copy(upVector);
              actor.wallriding = false;
          }
      }else{
          if(this.surfacehit){
              actor.inertiamax = 0;
          }
          if(actor.inertiamax <= 0 && anglediff > this.slopelimit){//mainly for transitioning from ground to wall
            let vlength = actor.accelAccum.length() * 0.8 * actor.gravityAccum>0?2:1;
            actor.inertiamax = vlength;
            actor.inertiacurr = vlength;
          }
          /*
          if(isplayer){ 
              inertiaback.style.display = "none";
          }
              */
      }
      this.surfacehit = this.checkOnSurface(actor, tempUp);
      if(actor.wallriding){
        actor.currRefresh = THREE.MathUtils.clamp(actor.currRefresh - deltaTime, 0, actor.inertiaRefeshTime);
        if(actor.currRefresh <= 0 && this.surfacehit && !CheckVector3Equals(actor.targetup, this.surfacehit.normal)){
          actor.inertiacurr = THREE.MathUtils.clamp(actor.inertiacurr + (actor.inertiamax * 0.1), 0, actor.inertiamax); 
          actor.currRefresh = actor.inertiaRefeshTime;
        }
      }else{
        if(this.surfacehit){
          this.lastGroundPos.copy(this._colliderMesh.position);
        }
      }
      if(this.surfacehit){
          if(worldCollisionResult.intersects){
              actor.airNudgeAccum.set(0,0,0);
              if(!actor.wallriding || (actor.wallriding && actor.inertiamax > 0 && actor.inertiacurr > 0)){
                  actor.gravityAccum = 0;//deltaTime * actor.gravity;
              }
          }
          actor.targetup.copy(this.surfacehit.normal);
      }
      actor.wallrideangle = actor.targetup.angleTo(upVector);
      actor.intersects = worldCollisionResult.intersects;
  }

  SetFacings(actor){
    //set collider
    StartCloneUse();
    this._colliderMesh.up.copy(actor.targetup);
    //slope
    if(actor.majorAxisChange){
      actor.forwardDir.applyAxisAngle(actor.axisOfChange, actor.angleOfChange);
      actor.majorAxisChange = false;
    }
    //facing direction
    let miscvect = CloneVector3(actor.forwardDir);
    miscvect.cross(actor.targetup).add(this._colliderMesh.position);
    this._colliderMesh.lookAt(miscvect);
    
    //set visuals
    if(actor.visualMesh){
      //set up direction
      actor.visualMesh.up.copy(this.camboom.up);
      //set position: offset downward from collider centre by capsule radius so feet sit on ground
      miscvect.copy(this.camboom.up).setLength(CAPSULE_RADIUS);
      actor.visualMesh.position.copy(this._colliderMesh.position).sub(miscvect);
      //set facing direction — only update velocityDir when actually moving
      if(actor.accelAccum.lengthSq() > 0.2){
        actor.velocityDir.copy(actor.velocity).setLength(1);
        
        actor.facingDir.copy(actor.velocityDir);
        actor.facingDir.cross(actor.targetup).cross(actor.visualMesh.up);
        //apply facing direction
        miscvect.copy(actor.visualMesh.position).add(actor.facingDir);
        actor.visualMesh.lookAt(miscvect);
      }
    }
  }
  playerControls(actor, deltaTime){
    if(this.mcount != this.prevmcount){//detects if mouse has truly been moved
        this.camYDelta = this.mousex * deltaTime * this._mouseSensY;
        this.camXDelta = this.mousey * deltaTime * this._mouseSensX;
    }else{
        this.camYDelta = 0;
        this.camXDelta = 0;
    }
    this.camX = THREE.MathUtils.clamp(this.camX + this.camXDelta, -rad90, rad90);
    let forward = keyStates[ 'KeyW' ];
    let backward = keyStates[ 'KeyS' ];
    let left = keyStates[ 'KeyA' ];
    let right = keyStates[ 'KeyD' ];
    actor.moving = (forward || backward || right || left);
    actor.inputDir.set( left?-1:right?1:0, 0, forward?-1:backward?1:0 ).transformDirection(this._colliderMesh.matrixWorld);
    actor.forwardDir.set(1,0,0).transformDirection(this._colliderMesh.matrixWorld).applyAxisAngle(actor.targetup, this.camYDelta);
    this.prevmcount = this.mcount;
  }
  //TODO player falls through the buildings and ground eventually, even when standing still.
  GroundMovement(actor, deltaTime, reverseDamping){
    StartCloneUse();
    let miscvect = GetMiscVect();
    let speedDelta = deltaTime * actor.maxSpeed;
    if(actor.moving){
        miscvect.copy(actor.inputDir).setLength(speedDelta);
        actor.accelAccum.add(miscvect);
        actor.accelAccum.x *= reverseDamping;
        actor.accelAccum.z *= reverseDamping;
    }else{
        miscvect.copy(actor.accelAccum).setLength(speedDelta * 0.5);
        actor.accelAccum.copy(this.GetCloseToZero(actor.accelAccum.sub(miscvect)));
        //actor.accelAccum.sub(miscvect);
    }
    actor.accelAccum.y *= reverseDamping;
    if(actor.jump){
        let wallpercent = actor.wallrideangle/rad90;

        actor.accelAccum.multiplyScalar(actor.airMovePercentage);
        actor.accelAccum.reflect(actor.targetup);
        miscvect.copy(actor.targetup).setLength(actor.jumpForce * wallpercent);
        actor.accelAccum.add(miscvect);

        //ArrowHelper(actor, actor.targetup);
        actor.gravityAccum = actor.jumpForce * (1-wallpercent) + actor.accelAccum.y;
        actor.accelAccum.y = 0;

        if(actor.wallriding){
            actor.forwardDir.applyAxisAngle(upVector, Math.PI);
        }
        actor.targetup.copy(upVector);
        actor.inertiamax = 0;
    }
  }
  AirMovement(actor, deltaTime, reverseDamping){
    StartCloneUse();
    let miscvect = GetMiscVect();
    if(actor.moving){
        miscvect.copy(actor.inputDir).setLength(actor.airNudge * deltaTime);
        actor.airNudgeAccum.add(miscvect);
        actor.airNudgeAccum.multiplyScalar(reverseDamping);
    }
    if(actor.jump){
      //mid air jump
      actor.majorAxisChange = true;
      actor.angleOfChange = actor.targetup.angleTo(upVector);
      actor.axisOfChange.copy(actor.targetup).cross(upVector);

      actor.targetup.copy(upVector);
    }
  }
  ApplyControls(actor, deltaTime){
      let jumpinput = keyStates[ 'Space' ];
      if(jumpinput){
          actor.jump = jumpinput && jumpinput != actor.prevJump;
      }
      actor.prevJump = jumpinput;
      let reverseDamping = Math.exp( - 4 * deltaTime );
      if(this.surfacehit){
        this.GroundMovement(actor, deltaTime, reverseDamping);
      }else{
        this.AirMovement(actor, deltaTime, reverseDamping);
      }
  }
  worldIntersect(raycaster){
    let camhit = null;
    for(let i = 0, max = this.collidables.length; i < max; i++){
      let mesh = this.collidables[i];
      let newhit = raycaster.intersectObject(mesh)[0];
      if((!camhit && newhit) || (camhit && newhit && (newhit.distance < camhit.distance))){
        camhit = newhit;
      }
    }
    return camhit;
  }
  GetCloseToZero(vect){
    let magnitude = vect.lengthSq();
    return magnitude <= closeToZero?zerovect:vect;
  }
  ApplyVelocity(actor){
    //composite velocity
    actor.velocity.copy(this.GetCloseToZero(actor.accelAccum));
    actor.velocity.y += actor.gravityAccum;
    actor.velocity.add(this.GetCloseToZero(actor.airNudgeAccum));
  }
  SetupCamera(actor){
    this.camraycaster.far = this.maxCamDist;
    this.camvert.position.set(0,actor.useHeight,0);
    this._camera.rotation.set(0,0,0);
    this._camera.position.set(0,0,this.maxCamDist);
  }
  updateCamera(actor, deltaTime){
    StartCloneUse();
    this.camboom.position.copy(this._colliderMesh.position);
    this.camboom.up.lerp(actor.targetup, deltaTime * 2);
    let miscvect = CloneVector3(actor.forwardDir);
    miscvect.cross(this.camboom.up).add(this._colliderMesh.position);
    this.camboom.lookAt(miscvect);
    
    this.camvert.rotation.x = this.camX;
    miscvect.copy(this.camboom.up).setLength(actor.useHeight);
    this.camraycaster.ray.origin.copy(this._colliderMesh.position).add(miscvect);
    this._camera.getWorldDirection(miscvect);
    this.camraycaster.ray.direction.copy(miscvect.negate());
    const camhit = this.worldIntersect(this.camraycaster);// this.camraycaster.intersectObject(world.layers[CollisionTags.Environment].collider )[ 0 ];
    let camdist = camhit?camhit.distance-0.2:this.maxCamDist;
    this._camera.position.z = camdist;
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
    keyStates = {};
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