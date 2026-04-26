// roamingControls.js — Third-person boom-arm camera + capsule-collision physics.

import * as THREE from 'three';
import {StartCloneUse,GetMiscVect,CloneVector3} from './mrUtils.js';

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
    //
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
    //run updates here
    return this._charPos;
  }

  get isActive() { return this._active; }

  _teleportOOB() {
    //teleport to last grounded position when out of bounds
  }
  // ═══════════════════════════════════════════════════════════
  // INPUT
  // ═══════════════════════════════════════════════════════════

  _key(codes) { return codes.some(c => this._keys[c]); }

  _onKeyDown(e) {
    if (!this._active) return;
    this._keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
  }

  _onKeyUp(e) { this._keys[e.code] = false; }

  _onMouseMove(e) {
    if (!this._active || !document.pointerLockElement) return;
    //
  }

  _onWheel(e) {
    if (!this._active) return;
    e.preventDefault();
    //adapt for zooming 
    /*
    this._boomLen = THREE.MathUtils.clamp(
      this._boomLen + (e.deltaY > 0 ? 1 : -1) * BOOM_ZOOM_SPD,
      BOOM_MIN, BOOM_MAX
    );
    */
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
