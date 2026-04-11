// js/orbitControls.js — Lightweight orbit controls (no R3F, vanilla Three.js)
// Adapted from Three.js OrbitControls r128 source.
import * as THREE from 'three';

const STATE = { NONE: -1, ROTATE: 0, DOLLY: 1, PAN: 2, TOUCH_ROTATE: 3, TOUCH_PAN: 4, TOUCH_DOLLY_PAN: 5 };
const EPS   = 0.000001;
const TWO_PI = Math.PI * 2;

export class OrbitControlsImpl {
  constructor(camera, domElement) {
    this.camera      = camera;
    this.domElement  = domElement;
    this.enabled     = true;
    this.target      = new THREE.Vector3();

    this.minDistance = 0;
    this.maxDistance = Infinity;
    this.minPolarAngle = 0;
    this.maxPolarAngle = Math.PI;
    this.enableDamping  = false;
    this.dampingFactor  = 0.05;
    this.rotateSpeed    = 1.0;
    this.zoomSpeed      = 1.2;
    this.panSpeed       = 0.8;
    this.enableZoom     = true;
    this.enableRotate   = true;
    this.enablePan      = true;

    // internals
    this._spherical      = new THREE.Spherical();
    this._sphericalDelta = new THREE.Spherical();
    this._scale          = 1;
    this._panOffset      = new THREE.Vector3();
    this._rotateStart    = new THREE.Vector2();
    this._rotateEnd      = new THREE.Vector2();
    this._rotateDelta    = new THREE.Vector2();
    this._panStart       = new THREE.Vector2();
    this._panEnd         = new THREE.Vector2();
    this._panDelta       = new THREE.Vector2();
    this._dollyStart     = new THREE.Vector2();
    this._dollyEnd       = new THREE.Vector2();
    this._dollyDelta     = new THREE.Vector2();
    this._state          = STATE.NONE;

    this._v  = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._quat   = new THREE.Quaternion().setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0));
    this._quatInverse = this._quat.clone().invert();
    this._lastPos    = new THREE.Vector3();

    this._bindEvents();
    this.update();
  }

  update() {
    const offset   = this._offset;
    const position = this.camera.position;
    offset.copy(position).sub(this.target);
    offset.applyQuaternion(this._quat);
    this._spherical.setFromVector3(offset);

    this._spherical.theta += this._sphericalDelta.theta;
    this._spherical.phi   += this._sphericalDelta.phi;
    this._spherical.phi    = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, this._spherical.phi));
    this._spherical.makeSafe();
    this._spherical.radius *= this._scale;
    this._spherical.radius  = Math.max(this.minDistance, Math.min(this.maxDistance, this._spherical.radius));

    this.target.addScaledVector(this._panOffset, 1);

    offset.setFromSpherical(this._spherical);
    offset.applyQuaternion(this._quatInverse);
    position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);

    if (this.enableDamping) {
      this._sphericalDelta.theta *= 1 - this.dampingFactor;
      this._sphericalDelta.phi   *= 1 - this.dampingFactor;
      this._panOffset.multiplyScalar(1 - this.dampingFactor);
    } else {
      this._sphericalDelta.set(0, 0, 0);
      this._panOffset.set(0, 0, 0);
    }
    this._scale = 1;
    return false;
  }

  _rotateLeft(angle)  { this._sphericalDelta.theta -= angle; }
  _rotateUp(angle)    { this._sphericalDelta.phi   -= angle; }
  _dollyIn(scale)     { this._scale /= scale; }
  _dollyOut(scale)    { this._scale *= scale; }

  _pan(deltaX, deltaY) {
    const el = this.domElement;
    const pos = this.camera.position;
    const offset = this._v.copy(pos).sub(this.target);
    let targetDistance = offset.length();
    targetDistance *= Math.tan((this.camera.fov / 2) * Math.PI / 180);
    this._panLeft(2 * deltaX * targetDistance / el.clientHeight, this.camera.matrix);
    this._panUp  (2 * deltaY * targetDistance / el.clientHeight, this.camera.matrix);
  }

  _panLeft(distance, matrix) {
    this._v.setFromMatrixColumn(matrix, 0);
    this._v.multiplyScalar(-distance);
    this._panOffset.add(this._v);
  }

  _panUp(distance, matrix) {
    this._v.setFromMatrixColumn(matrix, 1);
    this._v.multiplyScalar(distance);
    this._panOffset.add(this._v);
  }

  _getZoomScale() { return Math.pow(0.95, this.zoomSpeed); }

  _bindEvents() {
    const el = this.domElement;
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', e => this._onPointerDown(e));
    el.addEventListener('pointermove', e => this._onPointerMove(e));
    el.addEventListener('pointerup',   e => this._onPointerUp(e));
    el.addEventListener('wheel',       e => this._onWheel(e), { passive: false });
    el.addEventListener('touchstart',  e => this._onTouchStart(e), { passive: false });
    el.addEventListener('touchmove',   e => this._onTouchMove(e),  { passive: false });
    el.addEventListener('touchend',    e => this._onTouchEnd(e));
  }

  _onPointerDown(e) {
    if (!this.enabled) return;
    if (e.button === 0) { this._state = STATE.ROTATE; this._rotateStart.set(e.clientX, e.clientY); }
    if (e.button === 1) { this._state = STATE.DOLLY;  this._dollyStart.set(e.clientX, e.clientY);  }
    if (e.button === 2) { this._state = STATE.PAN;    this._panStart.set(e.clientX, e.clientY);    }
  }

  _onPointerMove(e) {
    if (!this.enabled) return;
    if (this._state === STATE.ROTATE) {
      this._rotateEnd.set(e.clientX, e.clientY);
      this._rotateDelta.subVectors(this._rotateEnd, this._rotateStart).multiplyScalar(this.rotateSpeed);
      const el = this.domElement;
      this._rotateLeft(TWO_PI * this._rotateDelta.x / el.clientHeight);
      this._rotateUp  (TWO_PI * this._rotateDelta.y / el.clientHeight);
      this._rotateStart.copy(this._rotateEnd);
      this.update();
    }
    if (this._state === STATE.DOLLY) {
      this._dollyEnd.set(e.clientX, e.clientY);
      this._dollyDelta.subVectors(this._dollyEnd, this._dollyStart);
      if (this._dollyDelta.y > 0) this._dollyIn(this._getZoomScale());
      else if (this._dollyDelta.y < 0) this._dollyOut(this._getZoomScale());
      this._dollyStart.copy(this._dollyEnd);
      this.update();
    }
    if (this._state === STATE.PAN) {
      this._panEnd.set(e.clientX, e.clientY);
      this._panDelta.subVectors(this._panEnd, this._panStart).multiplyScalar(this.panSpeed);
      this._pan(this._panDelta.x, this._panDelta.y);
      this._panStart.copy(this._panEnd);
      this.update();
    }
  }

  _onPointerUp() { this._state = STATE.NONE; }

  _onWheel(e) {
    if (!this.enabled || !this.enableZoom) return;
    e.preventDefault();
    if (e.deltaY < 0) this._dollyOut(this._getZoomScale());
    else              this._dollyIn(this._getZoomScale());
    this.update();
  }

  _onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      this._state = STATE.TOUCH_ROTATE;
      this._rotateStart.set(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2) {
      this._state = STATE.TOUCH_DOLLY_PAN;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      this._dollyStart.set(0, Math.sqrt(dx*dx + dy*dy));
    }
  }

  _onTouchMove(e) {
    e.preventDefault();
    if (this._state === STATE.TOUCH_ROTATE && e.touches.length === 1) {
      this._rotateEnd.set(e.touches[0].clientX, e.touches[0].clientY);
      this._rotateDelta.subVectors(this._rotateEnd, this._rotateStart).multiplyScalar(this.rotateSpeed);
      const el = this.domElement;
      this._rotateLeft(TWO_PI * this._rotateDelta.x / el.clientHeight);
      this._rotateUp  (TWO_PI * this._rotateDelta.y / el.clientHeight);
      this._rotateStart.copy(this._rotateEnd);
      this.update();
    } else if (this._state === STATE.TOUCH_DOLLY_PAN && e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      this._dollyEnd.set(0, dist);
      if (this._dollyEnd.y > this._dollyStart.y) this._dollyOut(this._getZoomScale());
      else                                        this._dollyIn(this._getZoomScale());
      this._dollyStart.copy(this._dollyEnd);
      this.update();
    }
  }

  _onTouchEnd() { this._state = STATE.NONE; }
}
