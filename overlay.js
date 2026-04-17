// overlay.js — Persistent overlay panel with category navigation
// Categories: Explore Mode (roaming only), Jukebox

import { Jukebox } from './jukebox.js';

export class OverlayPanel {
  constructor({ uiController }) {
    this.ui = uiController;
    this._open = false;
    this._activeCategory = null;
    this._appMode = 'map-creation'; // tracked externally via setAppMode()
    this._jukebox = null;           // lazy-initialised on first open
    this._jukeboxReady = false;
    this.$mapPreview = document.getElementById('map-preview');
  }

  init() {
    this._cacheDOM();
    this._bindEvents();
  }
  _updateMapPreviewVisibility() {
    if (!this.$mapPreview) return;
  
    const hide = this._appMode !== 'map-creation';
    this.$mapPreview.classList.toggle('hidden', hide);
  }
  // Called by UIController when app mode changes
  setAppMode(mode) {
    this._appMode = mode;
    this._updateCategoryVisibility();
    this._updateMapPreviewVisibility();
    // If leaving roaming while explore category is active, collapse it
    if (mode !== 'roaming' && this._activeCategory === 'explore') {
      this._setCategory(null);
      this._close();
    }
  }

  _cacheDOM() {
    this._toggleBtn = document.getElementById('overlay-toggle-btn');
    this._panel     = document.getElementById('overlay-panel');
    this._backdrop  = document.getElementById('overlay-backdrop');
    // Jukebox content container inside the overlay view
    this._jukeboxContainer = document.getElementById('jukebox-mount');
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

    // Explore: exit button → delegate to roam-back-btn
    const overlayRoamBack = document.getElementById('overlay-roam-back-btn');
    if (overlayRoamBack) {
      overlayRoamBack.addEventListener('click', () => {
        document.getElementById('roam-back-btn')?.click();
        this._close();
      });
    }

    this._updateCategoryVisibility();
  }

  _toggle() {
    if (this._open) {
      this._close();
    } else {
      this._open = true;
      this._panel.classList.add('open');
      this._toggleBtn.classList.add('active');
      this._backdrop.classList.add('active');
      // Default: open to first available category
      /*
      if (!this._activeCategory) {
        const firstAvail = this._appMode === 'roaming' ? 'explore' : 'jukebox';
        this._setCategory(firstAvail);
      }
      */
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

    // Sidebar active state
    document.querySelectorAll('.overlay-cat-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.cat === cat);
    });

    // Show/hide content area
    const content = document.getElementById('overlay-content');
    if (cat) {
      content.classList.add('visible');
    } else {
      content.classList.remove('visible');
      return;
    }

    // Show correct view
    document.querySelectorAll('.overlay-view').forEach(v => v.classList.remove('active'));
    const view = document.getElementById(`view-${cat}`);
    if (view) view.classList.add('active');

    // Lazily init the Jukebox the first time the jukebox view is opened
    if (cat === 'jukebox' && !this._jukeboxReady) {
      this._initJukebox();
    }
  }

  // ── Jukebox lazy init ─────────────────────────────────────────
  _initJukebox() {
    const mount = document.getElementById('jukebox-mount');
    if (!mount) return;
    this._jukebox      = new Jukebox();
    this._jukebox.init(mount);
    this._jukeboxReady = true;
  }

  _updateCategoryVisibility() {
    const exploreBtn = document.getElementById('cat-explore');
    if (!exploreBtn) return;
    const inRoaming = this._appMode === 'roaming';
    exploreBtn.classList.toggle('disabled-cat', !inRoaming);
  }
}
