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
    this._injectHTML();
    this._injectCSS();
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

  // ── HTML injection ────────────────────────────────────────────
  _injectHTML() {
    // Toggle button (top-right, always visible)
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'overlay-toggle-btn';
    toggleBtn.innerHTML = `
      <svg id="overlay-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <rect x="3" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg>
    `;
    document.body.appendChild(toggleBtn);

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'overlay-backdrop';
    document.body.appendChild(backdrop);

    // Main overlay panel
    const panel = document.createElement('div');
    panel.id = 'overlay-panel';
    panel.innerHTML = `
      <div id="overlay-sidebar">
        <div id="overlay-sidebar-top">
          <div class="overlay-cat-btn" data-cat="explore" id="cat-explore" title="Explore Mode">
            <span class="overlay-cat-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <polygon points="3 11 22 2 13 21 11 13 3 11"/>
              </svg>
            </span>
            <span class="overlay-cat-label">Explore</span>
          </div>
          <div class="overlay-cat-btn" data-cat="jukebox" id="cat-jukebox" title="Jukebox">
            <span class="overlay-cat-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
              </svg>
            </span>
            <span class="overlay-cat-label">Jukebox</span>
          </div>
        </div>
        <div id="overlay-sidebar-bottom">
          <button id="overlay-close-btn" title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      <div id="overlay-content">
        <!-- Explore Mode -->
        <div class="overlay-view" id="view-explore">
          <div class="overlay-view-header">
            <span class="overlay-view-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
              Explore Mode
            </span>
            <div class="overlay-view-badge">Active</div>
          </div>

          <div class="overlay-view-body">
            <!-- Movement hint -->
            <div class="explore-hint-card">
              <div class="explore-hint-icon">🕹</div>
              <div class="explore-hint-text">
                <div class="explore-hint-title">Movement Controls</div>
                <div class="explore-hint-sub">Coming soon — first-person navigation is in development.</div>
              </div>
            </div>

            <div class="explore-divider"></div>

            <!-- Exit -->
            <div class="explore-section-label">Session</div>
            <button id="overlay-roam-back-btn" class="explore-exit-btn">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
              Change Spawn Point
            </button>
          </div>
        </div>

        <!-- Jukebox -->
        <div class="overlay-view" id="view-jukebox">
          <div class="overlay-view-header">
            <span class="overlay-view-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
              Jukebox
            </span>
          </div>
          <div class="overlay-view-body">
            <div class="jukebox-placeholder">
              <div class="jukebox-placeholder-icon">♫</div>
              <div class="jukebox-placeholder-text">Music player coming soon</div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    this._panel    = panel;
    this._backdrop = backdrop;
    this._toggleBtn = toggleBtn;
  }

  // ── CSS injection ─────────────────────────────────────────────
  _injectCSS() {
    const style = document.createElement('style');
    style.textContent = `
      /* ── Toggle button ──────────────────────────────────────── */
      #overlay-toggle-btn {
        position: fixed;
        top: 14px;
        right: 14px;
        z-index: 50;
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        color: var(--muted);
        cursor: pointer;
        font-family: 'Space Mono', monospace;
        transition: all 0.18s ease;
        box-shadow: 0 2px 12px rgba(0,0,0,0.4);
      }
      #overlay-toggle-btn:hover {
        border-color: var(--accent);
        color: var(--accent);
        box-shadow: 0 0 12px rgba(71,215,255,0.2);
      }
      #overlay-toggle-btn.active {
        background: rgba(71,215,255,0.08);
        border-color: var(--accent);
        color: var(--accent);
      }

      /* ── Backdrop ───────────────────────────────────────────── */
      #overlay-backdrop {
        position: fixed;
        inset: 0;
        z-index: 39;
        background: rgba(0,0,0,0);
        pointer-events: none;
        transition: background 0.25s ease;
      }
      #overlay-backdrop.active {
        background: rgba(0,0,0,0.35);
        pointer-events: auto;
      }

      /* ── Panel ──────────────────────────────────────────────── */
      #overlay-panel {
        position: fixed;
        top: 0;
        right: 0;
        height: 100%;
        z-index: 40;
        display: flex;
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: -8px 0 40px rgba(0,0,0,0.6);
      }
      #overlay-panel.open {
        transform: translateX(0);
      }

      /* ── Sidebar ────────────────────────────────────────────── */
      #overlay-sidebar {
        width: 64px;
        height: 100%;
        background: var(--bg);
        border-left: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 8px 0;
        gap: 0;
        flex-shrink: 0;
      }
      #overlay-sidebar-top {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        flex: 1;
        padding-top: 54px; /* clear the toggle button */
      }
      #overlay-sidebar-bottom {
        padding-bottom: 12px;
      }

      .overlay-cat-btn {
        width: 48px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 9px 6px;
        border-radius: var(--radius);
        cursor: pointer;
        color: var(--muted);
        transition: all 0.15s ease;
        user-select: none;
      }
      .overlay-cat-btn:hover {
        color: var(--text);
        background: rgba(255,255,255,0.04);
      }
      .overlay-cat-btn.active {
        color: var(--accent);
        background: rgba(71,215,255,0.08);
      }
      .overlay-cat-btn.disabled-cat {
        opacity: 0.25;
        pointer-events: none;
      }
      .overlay-cat-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }
      .overlay-cat-label {
        font-family: 'Space Mono', monospace;
        font-size: 7.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        text-align: center;
        line-height: 1;
      }

      #overlay-close-btn {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: 1px solid var(--border);
        border-radius: var(--radius);
        color: var(--muted);
        cursor: pointer;
        transition: all 0.15s;
        font-family: 'Space Mono', monospace;
      }
      #overlay-close-btn:hover {
        border-color: var(--danger);
        color: var(--danger);
      }

      /* ── Content area ───────────────────────────────────────── */
      #overlay-content {
        width: 400px;
        height: 100%;
        background: var(--panel);
        border-left: 1px solid var(--border);
        overflow: hidden;
        display: none;
        flex-direction: column;
      }
      #overlay-content.visible {
        display: flex;
      }

      .overlay-view {
        display: none;
        flex-direction: column;
        height: 100%;
      }
      .overlay-view.active {
        display: flex;
      }

      .overlay-view-header {
        padding: 58px 16px 14px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }
      .overlay-view-title {
        display: flex;
        align-items: center;
        gap: 7px;
        font-family: 'Space Mono', monospace;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--text);
      }
      .overlay-view-badge {
        font-size: 8px;
        font-family: 'Space Mono', monospace;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 2px 7px;
        border-radius: 20px;
        background: rgba(71,215,255,0.12);
        color: var(--accent);
        border: 1px solid rgba(71,215,255,0.3);
        animation: badge-pulse 2.5s ease-in-out infinite;
      }
      @keyframes badge-pulse {
        0%,100% { opacity: 1; }
        50% { opacity: 0.55; }
      }

      .overlay-view-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .overlay-view-body::-webkit-scrollbar { width: 3px; }
      .overlay-view-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

      /* ── Explore view ───────────────────────────────────────── */
      .explore-hint-card {
        display: flex;
        gap: 12px;
        align-items: flex-start;
        padding: 14px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
      }
      .explore-hint-icon {
        font-size: 20px;
        line-height: 1;
        flex-shrink: 0;
        margin-top: 1px;
        opacity: 0.7;
      }
      .explore-hint-text {
        flex: 1;
        min-width: 0;
      }
      .explore-hint-title {
        font-size: 11px;
        font-weight: 700;
        color: var(--text);
        font-family: 'Space Mono', monospace;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 5px;
      }
      .explore-hint-sub {
        font-size: 10px;
        color: var(--muted);
        line-height: 1.6;
        font-family: 'Space Mono', monospace;
      }
      .explore-divider {
        height: 1px;
        background: var(--border);
        margin: 2px 0;
      }
      .explore-section-label {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
        font-family: 'Space Mono', monospace;
      }
      .explore-exit-btn {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 10px 12px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        color: var(--text);
        font-family: 'Space Mono', monospace;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        cursor: pointer;
        width: 100%;
        transition: all 0.15s;
        text-align: left;
      }
      .explore-exit-btn:hover {
        border-color: var(--accent);
        color: var(--accent);
        background: rgba(71,215,255,0.05);
      }

      /* ── Jukebox placeholder ────────────────────────────────── */
      .jukebox-placeholder {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 40px 20px;
        color: var(--muted);
      }
      .jukebox-placeholder-icon {
        font-size: 36px;
        opacity: 0.2;
        line-height: 1;
      }
      .jukebox-placeholder-text {
        font-size: 10px;
        font-family: 'Space Mono', monospace;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        text-align: center;
        opacity: 0.4;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Events ────────────────────────────────────────────────────
  _bindEvents() {
    this._toggleBtn.addEventListener('click', () => this._toggle());
    document.getElementById('overlay-backdrop').addEventListener('click', () => this._close());
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
