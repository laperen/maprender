// roamingControls.js — Third-person boom-arm camera + capsule-collision physics.

import * as THREE from 'three';
import {StartCloneUse,GetMiscVect,CloneVector3} from './mrUtils.js';

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

    this.sensitivity = 1.5;

    this.mousex = 0;
    this.mousey = 0;
    this.mcount = false;
    this.prevmcount = false;

    this.camYDelta = 0;
    this.camXDelta = 0;
    this.camX = 0;

    this._spawnPos;
    this.surfacehit;
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  activate(spawnPos, yawDeg = 0) {
    if (this._active) return;
    this._active    = true;
    this._spawnPos = spawnPos;
    //
    this._bindEvents();
    this._requestPointerLock();
    player.useHeight = player.charHeight - CAPSULE_RADIUS;
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
      this.UpdateActor(player, deltaTime);
    }
    return this._charPos;
  }

  get isActive() { return this._active; }
  _teleportOOB(actor) {
    if (this._colliderMesh.position.y <= - 25 ) {
      actor.accelAccum.set(0,0,0);
      actor.airNudgeAccum.set(0,0,0);
      actor.gravityAccum = 0;
      actor.targetup.copy(upVector);
      this._colliderMesh.position.copy(this._spawnPos);//.set(this.spawnPos.x,this.spawnPos.y,this.spawnPos.z);
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

  SetFacings(actor){
    //set collider
    StartCloneUse();
    this._colliderMesh.up.copy(actor.targetup);
    if(actor.majorAxisChange){
        actor.forwardDir.applyAxisAngle(actor.axisOfChange, actor.angleOfChange);
        actor.majorAxisChange = false;
    }
    let miscvect = CloneVector3(actor.forwardDir);
    miscvect.cross(actor.targetup).add(this._colliderMesh.position);
    this._colliderMesh.lookAt(miscvect);
    /*
    //set visuals
    if(actor.visualMesh){
        //set up direction
        actor.visualMesh.up.copy(camboom.up);
        //set position
        miscvect.copy(camboom.up).setLength(actor.groundColliderData.radius);
        actor.visualMesh.position.copy(actor.groundColliderMesh.position).sub(miscvect);
        //set facing direction
        if(actor.accelAccum.lengthSq() > 0.1){
            actor.velocityDir.copy(actor.velocity).setLength(1);
        }
        actor.facingDir.copy(actor.velocityDir);
        actor.facingDir.cross(actor.targetup).cross(actor.visualMesh.up);
        //apply facing direction
        miscvect.copy(actor.visualMesh.position).add(actor.facingDir);
        actor.visualMesh.lookAt(miscvect);
    }
    */
  }
  playerControls(actor, deltaTime){
    if(this.mcount != this.prevmcount){//detects if mouse has truly been moved
        this.camYDelta = this.mousex * deltaTime * this.sensitivity;
        this.camXDelta = this.mousey * deltaTime * this.sensitivity;
    }else{
        this.camYDelta = 0;
        this.camXDelta = 0;
    }
    /*
    camY += camXDelta;
    if(camY > Math.PI){
        camY -= Math.PI;
    } else if(camY < -Math.PI){
        camY += Math.PI;
    }
    */
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
  ApplyControls(actor, deltaTime){
      let jumpinput = keyStates[ 'Space' ];
      if(jumpinput){
          actor.jump = jumpinput && jumpinput != actor.prevJump;
      }
      actor.prevJump = jumpinput;
      let reverseDamping = Math.exp( - 4 * deltaTime );
      if(this.surfacehit){
        //GroundMovement(actor, deltaTime, reverseDamping);
      }else{
        //AirMovement(actor, deltaTime, reverseDamping);
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
      let camdist = camhit?camhit.distance:this.maxCamDist;
      this._camera.position.z = camdist;
  }
  UpdateActor(actor, deltaTime){
    //surface detection here
    this.playerControls(actor, deltaTime);
    this.ApplyControls(actor, deltaTime);
    this.updateCamera(actor, deltaTime);
    this._teleportOOB(actor);
    this.SetFacings(actor);
    //apply velocity here
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
