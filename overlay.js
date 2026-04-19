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
        document.getElementById('roam-back-btn')?.click();
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
  }

  _updateCategoryVisibility() {
    const exploreBtn = document.getElementById('cat-explore');
    if (!exploreBtn) return;
    const inRoaming = this._appMode === 'roaming';
    exploreBtn.classList.toggle('disabled-cat', !inRoaming);
  }
}
