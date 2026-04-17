// overlay.js — Persistent overlay panel with category navigation
// Categories: Explore Mode (roaming only), Jukebox

export class OverlayPanel {
  constructor({ uiController }) {
    this.ui = uiController;
    this._open = false;
    this._activeCategory = null;
    this._appMode = 'map-creation'; // tracked externally via setAppMode()
  }

  init() {
    this._cacheDOM();
    this._bindEvents();
  }

  // Called by UIController when app mode changes
  setAppMode(mode) {
    this._appMode = mode;
    this._updateCategoryVisibility();

    // If entering explore mode and overlay is open on explore category, keep it
    // If leaving explore mode and explore category is active, switch or close
    if (mode !== 'roaming' && this._activeCategory === 'explore') {
      this._setCategory(null);
      this._close();
    }
  }
  _cacheDOM() {
    this._toggleBtn = document.getElementById('overlay-toggle-btn');
    this._panel = document.getElementById('overlay-panel');
    this._backdrop = document.getElementById('overlay-backdrop');
  }
  // ── Events ────────────────────────────────────────────────────
  _bindEvents() {
    this._toggleBtn.addEventListener('click', () => this._toggle());
    this._backdrop.addEventListener('click', () => this._close());
    document.getElementById('overlay-close-btn').addEventListener('click', () => this._close());

    // Category buttons
    document.querySelectorAll('.overlay-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat;
        if (this._activeCategory === cat) {
          // Clicking active category collapses content
          this._setCategory(null);
        } else {
          this._setCategory(cat);
        }
      });
    });

    // Explore: exit button wired to roam-back-btn logic
    const overlayRoamBack = document.getElementById('overlay-roam-back-btn');
    if (overlayRoamBack) {
      overlayRoamBack.addEventListener('click', () => {
        // Delegate to original roam-back-btn
        const originalBtn = document.getElementById('roam-back-btn');
        if (originalBtn) originalBtn.click();
        this._close();
      });
    }

    // Initial visibility
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
      if (!this._activeCategory) {
        const firstAvail = this._appMode === 'roaming' ? 'explore' : 'jukebox';
        this._setCategory(firstAvail);
      }
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
  }

  _updateCategoryVisibility() {
    const exploreBtn = document.getElementById('cat-explore');
    if (!exploreBtn) return;
    const inRoaming = this._appMode === 'roaming';
    exploreBtn.classList.toggle('disabled-cat', !inRoaming);
  }
}
