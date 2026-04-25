// overlay.js — Persistent overlay panel with category navigation
// Categories: Explore Mode (roaming only), Jukebox, Settings

import { Jukebox } from './jukebox.js';

// Base sensitivity multipliers (matched to original constants in orbitControls / roamingControls)
const BASE_ORBIT_ROTATE_SPEED = 1.0;
const BASE_ROAM_MOUSE_X       = 0.18;
const BASE_ROAM_MOUSE_Y       = 0.14;

const STORAGE_KEY = 'atsim_settings';

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
}

function saveSettings(obj) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); } catch (_) {}
}

export class OverlayPanel {
  constructor({ uiController }) {
    this.ui = uiController;
    this._open = false;
    this._activeCategory = null;
    this._appMode = 'map-creation';
    this._jukebox = null;
    this._jukeboxReady = false;
    this.$mapPreview = document.getElementById('map-preview');

    // Settings state — restore from localStorage or fall back to defaults
    const saved = loadSettings();
    this._bgmVolume = saved?.bgmVolume  ?? 50;   // 0–100
    this._turnSens  = saved?.turnSens   ?? 100;  // 10–200, where 100 = 1.0×

    // Deferred autoPlay: if autoPlay() is called before the jukebox tab has
    // been opened (and _initJukebox() has run), we store the category here
    // and flush it the moment the jukebox is initialised.
    this._pendingAutoPlay = null;
  }

  // ── Persist current settings ──────────────────────────────────
  _saveSettings() {
    saveSettings({
      bgmVolume: this._bgmVolume,
      turnSens:  this._turnSens,
    });
  }

  init() {
    this._cacheDOM();
    this._bindEvents();
    this._applySettings();
    
    this._initJukebox();
  }

  _updateMapPreviewVisibility() {
    if (!this.$mapPreview) return;
    const hide = this._appMode !== 'map-creation';
    this.$mapPreview.classList.toggle('hidden', hide);
  }

  setAppMode(mode) {
    this._appMode = mode;
    this._updateCategoryVisibility();
    this._updateMapPreviewVisibility();
    if (mode !== 'roaming' && this._activeCategory === 'explore') {
      this._setCategory(null);
      this._close();
    }
  }

  _cacheDOM() {
    this._toggleBtn          = document.getElementById('overlay-toggle-btn');
    this._panel              = document.getElementById('overlay-panel');
    this._backdrop           = document.getElementById('overlay-backdrop');
    this._jukeboxContainer   = document.getElementById('jukebox-mount');

    // Settings controls
    this._$bgmSlider         = document.getElementById('settings-bgm-vol');
    this._$bgmVal            = document.getElementById('settings-bgm-vol-val');
    this._$turnSlider        = document.getElementById('settings-turn-sens');
    this._$turnVal           = document.getElementById('settings-turn-sens-val');
  }

  // ── Events ────────────────────────────────────────────────────
  _bindEvents() {
    this._toggleBtn.addEventListener('click', () => this._toggle());
    this._backdrop.addEventListener('click',  () => this._close());
    document.getElementById('overlay-close-btn').addEventListener('click', () => this._close());

    // Category buttons
    document.querySelectorAll('.overlay-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat;
        if (this._activeCategory === cat) {
          this._setCategory(null);
        } else {
          this._setCategory(cat);
        }
      });
    });

    // Explore: exit button -> delegate to roam-back-btn
    const overlayRoamBack = document.getElementById('overlay-roam-back-btn');
    if (overlayRoamBack) {
      overlayRoamBack.addEventListener('click', () => {
        this.ui._exitRoamingMode();
        //document.getElementById('roam-back-btn')?.click();
        this._close();
      });
    }

    // Settings: BGM volume
    if (this._$bgmSlider) {
      this._$bgmSlider.addEventListener('input', () => {
        this._bgmVolume = parseInt(this._$bgmSlider.value);
        if (this._$bgmVal) this._$bgmVal.textContent = `${this._bgmVolume}%`;
        this._applyBGMVolume();
        this._saveSettings();
      });
    }

    // Settings: Turning sensitivity
    if (this._$turnSlider) {
      this._$turnSlider.addEventListener('input', () => {
        this._turnSens = parseInt(this._$turnSlider.value);
        if (this._$turnVal) this._$turnVal.textContent = `${(this._turnSens / 100).toFixed(1)}x`;
        this._applySensitivity();
        this._saveSettings();
      });
    }

    this._updateCategoryVisibility();
  }

  // Apply all settings on init (restores slider positions too)
  _applySettings() {
    // Restore slider DOM values from (possibly persisted) state
    if (this._$bgmSlider)  this._$bgmSlider.value  = this._bgmVolume;
    if (this._$turnSlider) this._$turnSlider.value  = this._turnSens;

    if (this._$bgmVal)  this._$bgmVal.textContent  = `${this._bgmVolume}%`;
    if (this._$turnVal) this._$turnVal.textContent  = `${(this._turnSens / 100).toFixed(1)}x`;

    this._applySensitivity();
    // BGM volume is applied when jukebox is initialised
  }

  // Sensitivity: writes into orbit controls + roaming controls
  _applySensitivity() {
    const mult = this._turnSens / 100;

    const orbitCtrl = this.ui?.scene?.controls;
    if (orbitCtrl) {
      orbitCtrl.rotateSpeed = BASE_ORBIT_ROTATE_SPEED * mult / 10;
    }

    const roamCam = this.ui?.scene?._roamingCam;
    if (roamCam) {
      roamCam._mouseSensX = BASE_ROAM_MOUSE_X * mult;
      roamCam._mouseSensY = BASE_ROAM_MOUSE_Y * mult;
    }
  }

  // BGM volume: delegates to the Jukebox instance
  _applyBGMVolume() {
    if (this._jukebox) {
      this._jukebox._setVolume(this._bgmVolume);
      this._jukebox._currentVolume = this._bgmVolume / 100;
    }
  }

  _toggle() {
    if (this._open) {
      this._close();
    } else {
      // Close the left panel first if it's open
      this._leftPanel?._close();
      this._open = true;
      this._panel.classList.add('open');
      this._toggleBtn.classList.add('active');
      this._backdrop.classList.add('active');
      if (this._appMode === 'roaming') {
        this._setCategory('explore');
      } else {
        this._setCategory(this._activeCategory || 'jukebox');
      }
      this._updateCategoryVisibility();
    }
  }

  _close() {
    this._open = false;
    this._panel.classList.remove('open');
    this._toggleBtn.classList.remove('active');
    this._backdrop.classList.remove('active');
  }

  _setCategory(cat) {
    this._activeCategory = cat;

    document.querySelectorAll('.overlay-cat-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.cat === cat);
    });

    const content = document.getElementById('overlay-content');
    if (cat) {
      content.classList.add('visible');
    } else {
      content.classList.remove('visible');
      return;
    }

    document.querySelectorAll('.overlay-view').forEach(v => v.classList.remove('active'));
    const view = document.getElementById(`view-${cat}`);
    if (view) view.classList.add('active');

    if (cat === 'jukebox' && !this._jukeboxReady) {
      this._initJukebox();
    }
  }

  _initJukebox() {
    const mount = document.getElementById('jukebox-mount');
    if (!mount) return;
    this._jukebox = new Jukebox();
    this._jukebox.init(mount);
    this._jukeboxReady = true;
    this._applyBGMVolume();
    // Flush any autoPlay that was requested before the jukebox was opened
    if (this._pendingAutoPlay) {
      this._jukebox.autoPlay(this._pendingAutoPlay);
      this._pendingAutoPlay = null;
    }
  }

  /**
   * Called by UIController after world generation.
   * If the jukebox tab has already been opened, delegates immediately;
   * otherwise stores the category for deferred execution on first open.
   * @param {'day'|'night'|'win'|'lose'} cat
   */
  requestAutoPlay(cat) {
    if (this._jukeboxReady && this._jukebox) {
      this._jukebox.autoPlay(cat);
    } else {
      this._pendingAutoPlay = cat;
    }
  }

  _updateCategoryVisibility() {
    const exploreBtn = document.getElementById('cat-explore');
    if (!exploreBtn) return;
    const inRoaming = this._appMode === 'roaming';
    exploreBtn.classList.toggle('disabled-cat', !inRoaming);
  }
}

// ═══════════════════════════════════════════════════════════════
// LEFT ROAMING PANEL
// Slides in from the left, visible only in roaming mode.
// Opening it temporarily unlocks the cursor (releases pointer lock)
// but canvas drag (mousedown+move) re-locks while held.
// ═══════════════════════════════════════════════════════════════

export class LeftPanel {
  constructor({ uiController }) {
    this.ui = uiController;
    this._open  = false;
    this._appMode = 'map-creation';
    this._activeCategory = 'proxy';

    // Cursor drag-restore state
    this._dragging = false;
    this._wasPointerLocked = false;

    this._onCanvasMouseDown = this._onCanvasMouseDown.bind(this);
    this._onDocMouseUp      = this._onDocMouseUp.bind(this);
    this._onTouchStart      = this._onTouchStart.bind(this);
    this._onTouchEnd        = this._onTouchEnd.bind(this);
  }

  init() {
    this._panel        = document.getElementById('left-panel');
    this._toggleBtn    = document.getElementById('left-panel-toggle-btn');
    this._closeBtn     = document.getElementById('left-panel-close-btn');
    this._canvas       = document.getElementById('canvas-container');

    this._toggleBtn.addEventListener('click', () => this._toggle());
    this._closeBtn.addEventListener('click',  () => this._close());

    // Category sidebar buttons
    document.querySelectorAll('.left-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setCategory(btn.dataset.lcat));
    });
  }

  setAppMode(mode) {
    this._appMode = mode;
    // Auto-close if leaving roaming
    if (mode !== 'roaming' && this._open) this._close();
  }

  // ── Open / close ──────────────────────────────────────────────

  _toggle() {
    this._open ? this._close() : this._open_panel();
  }

  _open_panel() {
    // Close the overlay panel first if it's open
    this._overlay?._close();
    this._open = true;
    this._panel.classList.add('open');
    this._toggleBtn.classList.add('active');
    document.body.classList.add('left-panel-open');

    // Release pointer lock so the cursor is usable in the panel
    this._wasPointerLocked = !!document.pointerLockElement;
    if (this._wasPointerLocked) document.exitPointerLock();

    // Canvas drag listeners — re-grab while dragging
    this._canvas.addEventListener('mousedown',  this._onCanvasMouseDown);
    this._canvas.addEventListener('touchstart', this._onTouchStart, { passive: true });
    document.addEventListener('mouseup',  this._onDocMouseUp);
    document.addEventListener('touchend', this._onTouchEnd);
  }

  _close() {
    this._open = false;
    this._panel.classList.remove('open');
    this._toggleBtn.classList.remove('active');
    document.body.classList.remove('left-panel-open');
    document.body.classList.remove('canvas-dragging');

    // Restore pointer lock if roaming camera is active
    const roamCam = this.ui?.scene?._roamingCam;
    /*
    if (roamCam?.isActive && this._appMode === 'roaming') {
      try { this._canvas.requestPointerLock(); } catch (_) {}
    }
    */

    this._canvas.removeEventListener('mousedown',  this._onCanvasMouseDown);
    this._canvas.removeEventListener('touchstart', this._onTouchStart);
    document.removeEventListener('mouseup',  this._onDocMouseUp);
    document.removeEventListener('touchend', this._onTouchEnd);
    this._dragging = false;
  }

  // ── Canvas drag: unlock cursor temporarily re-grabbed ─────────

  _onCanvasMouseDown(e) {
    if (e.button !== 0) return;
    this._dragging = true;
    document.body.classList.add('canvas-dragging');
    // Re-request pointer lock while drag is held, so look-around works
    const roamCam = this.ui?.scene?._roamingCam;
    if (roamCam?.isActive) {
      try { this._canvas.requestPointerLock(); } catch (_) {}
    }
  }

  _onDocMouseUp() {
    if (!this._dragging) return;
    this._dragging = false;
    document.body.classList.remove('canvas-dragging');
    // Release lock again so cursor is free in panel
    if (document.pointerLockElement) document.exitPointerLock();
  }

  _onTouchStart() {
    this._dragging = true;
    document.body.classList.add('canvas-dragging');
  }

  _onTouchEnd() {
    this._dragging = false;
    document.body.classList.remove('canvas-dragging');
  }

  // ── Category switching ────────────────────────────────────────

  _setCategory(cat) {
    this._activeCategory = cat;

    document.querySelectorAll('.left-cat-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lcat === cat);
    });

    document.querySelectorAll('.left-view').forEach(v => v.classList.remove('active'));
    const view = document.getElementById(`left-view-${cat}`);
    if (view) view.classList.add('active');
  }
}
