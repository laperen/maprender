import * as THREE from 'three';
import { Jukebox } from './jukebox.js';

// js/ui.js — DOM event wiring, status messages, tooltip,
//            MiniMap (formerly minimap.js),
//            OverlayPanel + LeftPanel (formerly overlay.js)

// ═══════════════════════════════════════════════════════════════
// MINIMAP  (formerly minimap.js)
// ═══════════════════════════════════════════════════════════════

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

const TILE_LAYERS = {
  streets: {
    url:         'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  satellite: {
    url:         'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri',
  },
  terrain: {
    url:         'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a>',
  },
  dark: {
    url:         'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    attribution: '© <a href="https://carto.com/attributions">CARTO</a>',
  },
};

class MiniMap {
  constructor(containerId) {
    this.containerId   = containerId;
    this.map           = null;
    this._circle       = null;
    this._tileLayer    = null;
    this._currentStyle = 'streets';
    this._loaded       = false;
    this._pending      = null;
    this._load();
  }

  _load() {
    if (!document.querySelector('#leaflet-css')) {
      const link = document.createElement('link');
      link.id    = 'leaflet-css';
      link.rel   = 'stylesheet';
      link.href  = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    if (window.L) { this._init(); return; }
    const script  = document.createElement('script');
    script.src    = LEAFLET_JS;
    script.onload = () => this._init();
    document.head.appendChild(script);
  }

  _init() {
    const L = window.L;
    this.map = L.map(this.containerId, {
      center:             [35.6812, 139.7671],
      zoom:               13,
      zoomControl:        false,
      attributionControl: true,
      dragging:           false,
      scrollWheelZoom:    false,
      doubleClickZoom:    false,
      touchZoom:          false,
    });
    const def = TILE_LAYERS.streets;
    this._tileLayer = L.tileLayer(def.url, {
      attribution: def.attribution,
      maxZoom:     19,
    }).addTo(this.map);
    this._loaded = true;
    if (this._pending) {
      const [lng, lat, radius, styleName] = this._pending;
      this._pending = null;
      this.update(lng, lat, radius, styleName);
    }
  }

  update(lng, lat, radiusMeters = 500, styleName = 'streets') {
    if (!this._loaded) {
      this._pending = [lng, lat, radiusMeters, styleName];
      return;
    }
    const L = window.L;
    if (styleName !== this._currentStyle && TILE_LAYERS[styleName]) {
      this._currentStyle = styleName;
      const def = TILE_LAYERS[styleName];
      if (this._tileLayer) this.map.removeLayer(this._tileLayer);
      this._tileLayer = L.tileLayer(def.url, {
        attribution: def.attribution,
        maxZoom:     19,
      }).addTo(this.map);
    }
    this.map.setView([lat, lng], this._zoomForRadius(radiusMeters));
    if (this._circle) {
      this._circle.setLatLng([lat, lng]);
      this._circle.setRadius(radiusMeters);
    } else {
      this._circle = L.circle([lat, lng], {
        radius:      radiusMeters,
        color:       '#4fffb0',
        weight:      1.5,
        fillColor:   '#4fffb0',
        fillOpacity: 0.15,
      }).addTo(this.map);
    }
  }

  _zoomForRadius(r) {
    return Math.max(11, 16 - Math.log2(r / 100));
  }
}

// ═══════════════════════════════════════════════════════════════
// OVERLAY PANEL  (formerly overlay.js → OverlayPanel)
// ═══════════════════════════════════════════════════════════════

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

class OverlayPanel {
  constructor({ uiController }) {
    this.ui = uiController;
    this._open = false;
    this._activeCategory = null;
    this._appMode = 'map-creation';
    this._jukebox = null;
    this._jukeboxReady = false;
    this.$mapPreview = document.getElementById('map-preview');

    const saved = loadSettings();
    this._bgmVolume = saved?.bgmVolume ?? 50;
    this._turnSens  = saved?.turnSens  ?? 100;

    this._pendingAutoPlay = null;
  }

  _saveSettings() {
    saveSettings({ bgmVolume: this._bgmVolume, turnSens: this._turnSens });
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
    this._toggleBtn        = document.getElementById('overlay-toggle-btn');
    this._panel            = document.getElementById('overlay-panel');
    this._backdrop         = document.getElementById('overlay-backdrop');
    this._$bgmSlider       = document.getElementById('settings-bgm-vol');
    this._$bgmVal          = document.getElementById('settings-bgm-vol-val');
    this._$turnSlider      = document.getElementById('settings-turn-sens');
    this._$turnVal         = document.getElementById('settings-turn-sens-val');
  }

  _bindEvents() {
    this._toggleBtn.addEventListener('click', () => this._toggle());
    this._backdrop.addEventListener('click',  () => this._close());
    document.getElementById('overlay-close-btn').addEventListener('click', () => this._close());

    document.querySelectorAll('.overlay-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat;
        this._setCategory(this._activeCategory === cat ? null : cat);
      });
    });

    const overlayRoamBack = document.getElementById('overlay-roam-back-btn');
    if (overlayRoamBack) {
      overlayRoamBack.addEventListener('click', () => {
        this.ui._exitRoamingMode();
        this._close();
      });
    }

    if (this._$bgmSlider) {
      this._$bgmSlider.addEventListener('input', () => {
        this._bgmVolume = parseInt(this._$bgmSlider.value);
        if (this._$bgmVal) this._$bgmVal.textContent = `${this._bgmVolume}%`;
        this._applyBGMVolume();
        this._saveSettings();
      });
    }

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

  _applySettings() {
    if (this._$bgmSlider)  this._$bgmSlider.value  = this._bgmVolume;
    if (this._$turnSlider) this._$turnSlider.value  = this._turnSens;
    if (this._$bgmVal)  this._$bgmVal.textContent  = `${this._bgmVolume}%`;
    if (this._$turnVal) this._$turnVal.textContent  = `${(this._turnSens / 100).toFixed(1)}x`;
    this._applySensitivity();
  }

  _applySensitivity() {
    const mult = this._turnSens / 100;
    const orbitCtrl = this.ui?.scene?.controls;
    if (orbitCtrl) orbitCtrl.rotateSpeed = BASE_ORBIT_ROTATE_SPEED * mult / 10;
    const roamCam = this.ui?.scene?._roamingCam;
    if (roamCam) {
      roamCam._mouseSensX = BASE_ROAM_MOUSE_X * mult;
      roamCam._mouseSensY = BASE_ROAM_MOUSE_Y * mult;
    }
  }

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
      this._leftPanel?._close();
      this._open = true;
      this._panel.classList.add('open');
      this._toggleBtn.classList.add('active');
      this._backdrop.classList.add('active');
      this._setCategory(this._appMode === 'roaming' ? 'explore' : (this._activeCategory || 'jukebox'));
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
    if (cat === 'jukebox' && !this._jukeboxReady) this._initJukebox();
  }

  _initJukebox() {
    const mount = document.getElementById('jukebox-mount');
    if (!mount) return;
    this._jukebox = new Jukebox();
    this._jukebox.init(mount);
    this._jukeboxReady = true;
    this._applyBGMVolume();
    if (this._pendingAutoPlay) {
      this._jukebox.autoPlay(this._pendingAutoPlay);
      this._pendingAutoPlay = null;
    }
  }

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
    exploreBtn.classList.toggle('disabled-cat', this._appMode !== 'roaming');
  }
}

// ═══════════════════════════════════════════════════════════════
// LEFT PANEL  (formerly overlay.js → LeftPanel)
// ═══════════════════════════════════════════════════════════════

class LeftPanel {
  constructor({ uiController }) {
    this.ui = uiController;
    this._open  = false;
    this._appMode = 'map-creation';
    this._activeCategory = 'proxy';

    this._dragging = false;
    this._wasPointerLocked = false;

    this._onCanvasMouseDown = this._onCanvasMouseDown.bind(this);
    this._onDocMouseUp      = this._onDocMouseUp.bind(this);
    this._onTouchStart      = this._onTouchStart.bind(this);
    this._onTouchEnd        = this._onTouchEnd.bind(this);
  }

  init() {
    this._panel     = document.getElementById('left-panel');
    this._toggleBtn = document.getElementById('left-panel-toggle-btn');
    this._closeBtn  = document.getElementById('left-panel-close-btn');
    this._canvas    = document.getElementById('canvas-container');

    this._toggleBtn.addEventListener('click', () => this._toggle());
    this._closeBtn.addEventListener('click',  () => this._close());

    document.querySelectorAll('.left-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => this._setCategory(btn.dataset.lcat));
    });
  }

  setAppMode(mode) {
    this._appMode = mode;
    if (mode !== 'roaming' && this._open) this._close();
  }

  _toggle() { this._open ? this._close() : this._open_panel(); }

  _open_panel() {
    this._overlay?._close();
    this._open = true;
    this._panel.classList.add('open');
    this._toggleBtn.classList.add('active');
    document.body.classList.add('left-panel-open');

    this._wasPointerLocked = !!document.pointerLockElement;
    if (this._wasPointerLocked) document.exitPointerLock();

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

    this._canvas.removeEventListener('mousedown',  this._onCanvasMouseDown);
    this._canvas.removeEventListener('touchstart', this._onTouchStart);
    document.removeEventListener('mouseup',  this._onDocMouseUp);
    document.removeEventListener('touchend', this._onTouchEnd);
    this._dragging = false;
  }

  _onCanvasMouseDown(e) {
    if (e.button !== 0) return;
    this._dragging = true;
    document.body.classList.add('canvas-dragging');
    const roamCam = this.ui?.scene?._roamingCam;
    if (roamCam?.isActive) {
      try { this._canvas.requestPointerLock(); } catch (_) {}
    }
  }

  _onDocMouseUp() {
    if (!this._dragging) return;
    this._dragging = false;
    document.body.classList.remove('canvas-dragging');
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

// ═══════════════════════════════════════════════════════════════
// UI CONTROLLER
// ═══════════════════════════════════════════════════════════════

export class UIController {
  constructor({ scene, fetcher, builder }) {
    this.scene   = scene;
    this.fetcher = fetcher;
    this.builder = builder;

    // Instantiate minimap, overlay, and left panel internally
    this.minimap     = new MiniMap('map-preview-inner');
    this._overlay    = new OverlayPanel({ uiController: this });
    this._leftPanel  = new LeftPanel({ uiController: this });

    // Cross-close wiring
    this._overlay._leftPanel = this._leftPanel;
    this._leftPanel._overlay = this._overlay;

    this.lat         = 35.6812;
    this.lng         = 139.7671;
    this.radius      = 500;
    this.heightScale = 1;
    this.renderMode  = 'solid';
    this.timeOfDay   = 12;
    this._deviceTimeMode  = false;
    this._deviceTimerID   = null;
    this._localTimezone   = null;

    this._cloudAutoMode  = true;
    this._cloudCover     = 40;
    this._cloudCondition = 1;
    this._windSpeed      = 18;
    this._windAngleDeg   = 13;
    this._cloudAltitude  = 380;

    this._appMode = 'map-creation';

    this._gameMode       = 'explore';
    this._exploreJukeboxCat = null;
    this._raceState      = 'idle';
    this._raceDuration   = 120;
    this._raceTimeLeft   = 0;
    this._raceCheckpoints    = [];
    this._raceNextCheckpoint = 0;
    this._raceRAFId      = null;
    this._racePrevMs     = null;

    this._beaconX = null;
    this._beaconY = null;
    this._beaconZ = null;
    this._worldGenerated = false;

    this._lastMapKey = null;
    this._lastWays   = null;

    this._TIME_RATE_MANUAL = 24 / 7200;
    this._timePrevMs    = null;
    this._timeRAFId     = null;
    this._sliderDragging = false;
  }

  init() {
    this._bindElements();
    this._buildTimePanel();
    this._buildCloudPanel();
    this._bindEvents();
    this.minimap.update(this.lng, this.lat, this.radius);
    this._applyTimeOfDay(this.timeOfDay);
    this._applyCloudProperties();

    // Init overlay and left panel
    this._overlay.init();
    this._leftPanel.init();

    this.scene.onBeaconPlaced((x, y, z) => {
      this._beaconX = x;
      this._beaconY = y;
      this._beaconZ = z;
      if (this.$enterWorldBtn) {
        this.$enterWorldBtn.disabled = false;
        this.$enterWorldBtn.classList.add('beacon-ready');
      }
      if (this.$selectionHint) {
        this.$selectionHint.textContent = '📍 Spawn point set — click Enter World or reposition';
      }
    });
  }

  _bindElements() {
    this.$locationInput = document.getElementById('location-input');
    this.$searchBtn     = document.getElementById('search-btn');
    this.$latInput      = document.getElementById('lat-input');
    this.$lngInput      = document.getElementById('lng-input');
    this.$styleSelect   = document.getElementById('style-select');
    this.$radiusSlider  = document.getElementById('radius-slider');
    this.$radiusVal     = document.getElementById('radius-val');
    this.$heightSlider  = document.getElementById('height-slider');
    this.$heightVal     = document.getElementById('height-val');
    this.$generateBtn   = document.getElementById('generate-btn');
    this.$status        = document.getElementById('status');
    this.$stats         = document.getElementById('stats');
    this.$statBuildings = document.getElementById('stat-buildings');
    this.$statRoads     = document.getElementById('stat-roads');
    this.$statTris      = document.getElementById('stat-tris');
    this.$modeBtns      = document.querySelectorAll('.mode-btn');
    this.$tooltip       = document.getElementById('tooltip');
    this.$canvas        = document.getElementById('canvas-container');
    this.$timePanelHost = document.getElementById('time-panel-host');
    this.$cloudPanelHost = document.getElementById('cloud-panel-host');
    this.$todTzLabel    = document.getElementById('tod-tz-label');

    this.$todToggle   = document.getElementById('tod-toggle');
    this.$todBody     = document.getElementById('tod-body');
    this.$todMeta     = document.getElementById('tod-meta');
    this.$cloudToggle = document.getElementById('cloud-toggle');
    this.$cloudBody   = document.getElementById('cloud-body');
    this.$cloudMeta   = document.getElementById('cloud-meta');

    this.$uiPanel        = document.getElementById('ui');
    this.$selectionPanel = document.getElementById('selection-panel');
    this.$enterSelBtn    = document.getElementById('enter-selection-btn');
    this.$enterWorldBtn  = document.getElementById('enter-world-btn');
    this.$selBackBtn     = document.getElementById('sel-back-btn');
    this.$roamBackBtn    = document.getElementById('roam-back-btn');
    this.$selectionHint  = document.getElementById('selection-hint');
  }

  _buildTimePanel() {
    if (!this.$timePanelHost) return;
    this.$todArc        = document.getElementById('tod-arc');
    this.$todLabel      = document.getElementById('tod-time-label');
    this.$todSlider     = document.getElementById('tod-slider');
    this.$todSliderWrap = document.getElementById('tod-slider-wrap');
    this.$todManualBtn  = document.getElementById('tod-manual-btn');
    this.$todDeviceBtn  = document.getElementById('tod-device-btn');
    this.$todIndicators = document.getElementById('tod-indicators');
    this._drawArc(12);
    this._updateIndicators(12);
  }

  _buildCloudPanel() {
    if (!this.$cloudPanelHost) return;
    this.$cloudArc          = document.getElementById('cloud-arc');
    this.$cloudLabel        = document.getElementById('cloud-label');
    this.$cloudManualWrap   = document.getElementById('cloud-manual-wrap');
    this.$cloudManualBtn    = document.getElementById('cloud-manual-btn');
    this.$cloudAutoBtn      = document.getElementById('cloud-auto-btn');
    this.$cloudCondSelect   = document.getElementById('cloud-condition-select');
    this.$cloudCoverSlider  = document.getElementById('cloud-cover-slider');
    this.$cloudCoverVal     = document.getElementById('cloud-cover-val');
    this.$cloudWindSpeedSl  = document.getElementById('cloud-wind-speed-slider');
    this.$cloudWindSpeedVal = document.getElementById('cloud-wind-speed-val');
    this.$cloudWindAngleSl  = document.getElementById('cloud-wind-angle-slider');
    this.$cloudWindAngleVal = document.getElementById('cloud-wind-angle-val');
    this.$cloudAltitudeSl   = document.getElementById('cloud-altitude-slider');
    this.$cloudAltitudeVal  = document.getElementById('cloud-altitude-val');
    this.$cloudIndicators   = document.getElementById('cloud-indicators');
    this._drawCloudPreview();
    this._updateCloudPills();
  }

  _drawCloudPreview() {
    if (!this.$cloudArc) return;
    const canvas = this.$cloudArc;
    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const cover = this._cloudCover / 100;
    const cond  = this._cloudCondition;

    let skyTop, skyBot;
    if (cond === 5)      { skyTop = '#1a1520'; skyBot = '#2a2030'; }
    else if (cond === 4) { skyTop = '#2a3040'; skyBot = '#404858'; }
    else if (cond === 3) { skyTop = '#505860'; skyBot = '#707880'; }
    else                 { skyTop = '#1565c0'; skyBot = '#42a5f5'; }

    const grad = ctx.createLinearGradient(0, 0, 0, H - 12);
    grad.addColorStop(0, skyTop);
    grad.addColorStop(1, skyBot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H - 12);

    const cloudCount = Math.round(cover * 8);
    const cloudAlpha = 0.25 + cover * 0.65;
    let cloudColor;
    if (cond === 5)      cloudColor = `rgba(80,80,90,${cloudAlpha})`;
    else if (cond === 4) cloudColor = `rgba(110,120,130,${cloudAlpha})`;
    else if (cond >= 2)  cloudColor = `rgba(180,185,195,${cloudAlpha})`;
    else                 cloudColor = `rgba(230,235,245,${cloudAlpha})`;

    const clouds = [
      { x: 0.10, y: 0.25, r: 22 }, { x: 0.28, y: 0.18, r: 28 },
      { x: 0.48, y: 0.28, r: 20 }, { x: 0.65, y: 0.15, r: 32 },
      { x: 0.80, y: 0.30, r: 18 }, { x: 0.92, y: 0.20, r: 24 },
      { x: 0.38, y: 0.48, r: 22 }, { x: 0.72, y: 0.45, r: 26 },
    ];

    for (let i = 0; i < cloudCount; i++) {
      const c  = clouds[i % clouds.length];
      const cx = c.x * W, cy = c.y * (H - 16), r = c.r;
      const cg = ctx.createRadialGradient(cx, cy - r * 0.2, 0, cx, cy, r * 1.4);
      cg.addColorStop(0,   cloudColor);
      cg.addColorStop(0.6, cloudColor);
      cg.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 1.5, r * 0.8, 0, 0, Math.PI * 2);
      ctx.fillStyle = cg;
      ctx.fill();
    }

    if (this._windSpeed > 0) {
      const arrowAlpha = Math.min(1, this._windSpeed / 40);
      const angleRad   = this._windAngleDeg * Math.PI / 180;
      const arrowLen   = 12 + (this._windSpeed / 80) * 10;
      const ax = W - 22, ay = 14;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(angleRad);
      ctx.strokeStyle = `rgba(200,220,255,${arrowAlpha})`;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(-arrowLen / 2, 0);
      ctx.lineTo(arrowLen / 2, 0);
      ctx.moveTo(arrowLen / 2 - 4, -3);
      ctx.lineTo(arrowLen / 2, 0);
      ctx.lineTo(arrowLen / 2 - 4, 3);
      ctx.stroke();
      ctx.restore();
    }

    const groundGrad = ctx.createLinearGradient(0, H - 12, 0, H);
    groundGrad.addColorStop(0, 'rgba(50,80,50,0.9)');
    groundGrad.addColorStop(1, 'rgba(20,40,20,0.9)');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, H - 12, W, 12);

    if (cond >= 4) {
      ctx.strokeStyle = `rgba(150,180,220,${cover * 0.55})`;
      ctx.lineWidth   = 0.8;
      for (let i = 0; i < 18; i++) {
        const rx = (i / 18) * W + (i % 3) * 5;
        const ry = 30 + (i % 5) * 8;
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx - 2, ry + 9);
        ctx.stroke();
      }
    }

    if (cond === 5 && cover > 0.3) {
      ctx.strokeStyle = 'rgba(255,240,100,0.7)';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(W * 0.55, 20);
      ctx.lineTo(W * 0.50, 38);
      ctx.lineTo(W * 0.56, 38);
      ctx.lineTo(W * 0.50, 56);
      ctx.stroke();
    }
  }

  _updateCloudPills() {
    if (!this.$cloudIndicators) return;
    const cover = this._cloudCover;
    const cond  = this._cloudCondition;
    const speed = this._windSpeed;

    const labels    = ['Clear', 'Partly', 'Mostly', 'Overcast', 'Rain', 'Storm'];
    const icons     = ['☀', '⛅', '🌥', '☁', '🌧', '⛈'];
    const condColors= ['#ffd060', '#c8d8ff', '#a0a8b8', '#8090a0', '#4888c0', '#a060d0'];

    const windLabel = speed < 5 ? 'Calm' : speed < 20 ? 'Breeze' : speed < 45 ? 'Windy' : 'Gale';
    const windColor = speed < 5 ? '#4fffb0' : speed < 20 ? '#47d7ff' : speed < 45 ? '#ffd060' : '#ff4f6b';

    const pill = (icon, label, active, color) =>
      `<div class="tod-pill ${active ? 'active' : ''}" style="--pill-color:${color}">
        <span>${icon}</span><span>${label}</span>
      </div>`;

    this.$cloudIndicators.innerHTML =
      pill(icons[cond], labels[cond], cover > 0, condColors[cond]) +
      pill('↗', windLabel, speed > 0, windColor) +
      pill('▲', `${this._cloudAltitude}m`, true, '#c8b8ff');
  }

  _applyCloudProperties() {
    this.scene.setCloudProperties({
      windSpeed:    this._windSpeed,
      windAngleDeg: this._windAngleDeg,
      altitude:     this._cloudAltitude,
    });
    if (!this._cloudAutoMode) {
      const wmoCode = [0, 2, 3, 45, 61, 95][this._cloudCondition] ?? 1;
      this.scene.setWeather(this._cloudCover, wmoCode);
    }
    this._drawCloudPreview();
    this._updateCloudPills();

    const condEmoji = ['☀', '⛅', '🌥', '☁', '🌧', '⛈'][this._cloudCondition];
    if (this.$cloudLabel) this.$cloudLabel.textContent = `${condEmoji} ${this._cloudCover}% cover`;
    if (this.$cloudMeta)  this.$cloudMeta.textContent  = `${condEmoji} ${this._cloudCover}%`;
  }

  _setCloudAutoMode(auto) {
    this._cloudAutoMode = auto;
    if (this.$cloudAutoBtn)   this.$cloudAutoBtn.classList.toggle('active', auto);
    if (this.$cloudManualBtn) this.$cloudManualBtn.classList.toggle('active', !auto);
    if (this.$cloudManualWrap) {
      this.$cloudManualWrap.style.opacity       = auto ? '0.35' : '1';
      this.$cloudManualWrap.style.pointerEvents = auto ? 'none' : '';
    }
    if (auto) {
      if (this.$cloudLabel) this.$cloudLabel.textContent = '⏳ Fetching weather…';
      this.fetcher.fetchWeather(this.lat, this.lng).then(weather => {
        this._syncWeatherToUI(weather);
        this.scene.setWeather(weather.cloudCover, weather.weatherCode);
        this._applyCloudProperties();
      }).catch(() => { this._applyCloudProperties(); });
    } else {
      this._applyCloudProperties();
    }
  }

  _syncWeatherToUI(weather) {
    this._cloudCover = weather.cloudCover;
    if (this.$cloudCoverSlider) this.$cloudCoverSlider.value = this._cloudCover;
    if (this.$cloudCoverVal)    this.$cloudCoverVal.textContent = `${this._cloudCover}%`;

    const wmo = weather.weatherCode;
    this._cloudCondition = wmo >= 95 ? 5 : wmo >= 61 ? 4 : wmo >= 45 ? 3 : wmo >= 3 ? 2 : wmo >= 1 ? 1 : 0;
    if (this.$cloudCondSelect) this.$cloudCondSelect.value = String(this._cloudCondition);

    if (weather.windSpeed !== undefined) {
      this._windSpeed = weather.windSpeed;
      if (this.$cloudWindSpeedSl)  this.$cloudWindSpeedSl.value = this._windSpeed;
      if (this.$cloudWindSpeedVal) this.$cloudWindSpeedVal.textContent = `${this._windSpeed} u/s`;
    }
    if (weather.windDirection !== undefined) {
      this._windAngleDeg = weather.windDirection;
      if (this.$cloudWindAngleSl)  this.$cloudWindAngleSl.value = this._windAngleDeg;
      if (this.$cloudWindAngleVal) this.$cloudWindAngleVal.textContent = `${this._windAngleDeg}°`;
    }
  }

  _drawArc(hour) {
    if (!this.$todArc) return;
    const canvas = this.$todArc;
    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const skyColor = this._skyColor(hour);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, skyColor.top);
    grad.addColorStop(1, skyColor.bot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, H - 18);
    ctx.lineTo(W, H - 18);
    ctx.stroke();

    const cx = W / 2, cy = H - 18, r = 80;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.stroke();

    const elevDeg  = this._solarElevDeg(hour);
    const np       = this._nightPhaseForHour(hour);
    const isDay    = elevDeg > -6;
    const elevRad  = _clamp(elevDeg / 90, -0.25, 1) * r;
    const arcAngle = this._sunArcAngle(hour);

    const sx = cx + r * Math.cos(Math.PI - arcAngle);
    const sy = cy - Math.max(0, elevRad);

    if (isDay && elevDeg > -3) {
      const sunGlow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 22);
      sunGlow.addColorStop(0,   'rgba(255,220,100,0.55)');
      sunGlow.addColorStop(0.5, 'rgba(255,180,60,0.18)');
      sunGlow.addColorStop(1,   'rgba(255,140,30,0.0)');
      ctx.fillStyle = sunGlow;
      ctx.beginPath();
      ctx.arc(sx, sy, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe090';
      ctx.fill();
    }

    if (np > 0.05) {
      const moonArcAngle = (arcAngle + Math.PI) % (Math.PI * 2);
      const moonElevRad  = _clamp(-elevDeg / 90, -0.25, 1) * r;
      const mx = cx + r * Math.cos(Math.PI - moonArcAngle);
      const my = cy - Math.max(0, moonElevRad);
      if (my < cy) {
        ctx.beginPath();
        ctx.arc(mx, my, 6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200,220,255,${np * 0.9})`;
        ctx.fill();
      }
    }

    if (np > 0.05) {
      ctx.fillStyle = `rgba(255,255,255,${np * 0.7})`;
      const starPositions = [
        [30,20],[80,10],[130,30],[170,8],[210,25],
        [55,50],[150,55],[200,45],[25,60],[195,70],
      ];
      for (const [stx, sty] of starPositions) {
        if (sty < H - 22) {
          ctx.beginPath();
          ctx.arc(stx, sty, 0.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const groundGrad = ctx.createLinearGradient(0, H - 18, 0, H);
    groundGrad.addColorStop(0, skyColor.ground);
    groundGrad.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, H - 18, W, 18);

    if (np > 0.2) {
      const lampAlpha = Math.min(1, (np - 0.2) / 0.4);
      for (let lx = 30; lx < W - 20; lx += 48) {
        const lg = ctx.createRadialGradient(lx, H - 18, 0, lx, H - 18, 18);
        lg.addColorStop(0, `rgba(255,200,60,${lampAlpha * 0.6})`);
        lg.addColorStop(1, 'rgba(255,160,30,0)');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.arc(lx, H - 18, 18, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  _solarElevDeg(hour) { return this.scene.getSolarElevation(hour); }

  _nightPhaseForHour(hour) {
    return 1 - _smoothstep(this._solarElevDeg(hour), -6, 10);
  }

  _sunArcAngle(hour) {
    return Math.PI * (1 - ((hour % 24 + 24) % 24) / 24);
  }

  _skyColor(hour) {
    const np      = this._nightPhaseForHour(hour);
    const elevDeg = this._solarElevDeg(hour);
    const isGolden = elevDeg >= -6 && elevDeg <= 18;
    if (np > 0.9) return { top: '#020510', bot: '#060a1c', ground: 'rgba(15,20,40,0.9)' };
    if (np > 0.5) return { top: '#0a1535', bot: '#152040', ground: 'rgba(20,30,55,0.9)' };
    if (isGolden && elevDeg < 10 && hour <= 12) return { top: '#1a2a6c', bot: '#e05f10', ground: 'rgba(60,30,10,0.9)' };
    if (isGolden && elevDeg < 10 && hour >  12) return { top: '#1a2a6c', bot: '#c04010', ground: 'rgba(50,25,10,0.9)' };
    return { top: '#1565c0', bot: '#42a5f5', ground: 'rgba(50,90,60,0.9)' };
  }

  _updateIndicators(hour) {
    if (!this.$todIndicators) return;
    const elevDeg = this._solarElevDeg(hour);
    const np      = this._nightPhaseForHour(hour);
    const lampOn  = np > 0.25;
    const pill = (icon, label, active, color) =>
      `<div class="tod-pill ${active ? 'active' : ''}" style="--pill-color:${color}">
        <span>${icon}</span><span>${label}</span>
      </div>`;
    this.$todIndicators.innerHTML =
      pill('☀', 'Sun',   elevDeg > 0,  '#ffd060') +
      pill('☽', 'Moon',  np > 0.15,    '#c8d8ff') +
      pill('★', 'Stars', np > 0.3,     '#aac8ff') +
      pill('◎', 'Lamps', lampOn,       '#ffa040');
  }

  _bindEvents() {
    this.$searchBtn.addEventListener('click', () => this._geocode());
    this.$locationInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._geocode();
    });

    if (this.$todToggle)   this.$todToggle.addEventListener('click',   () => this._toggleCollapsible(this.$todToggle, this.$todBody));
    if (this.$cloudToggle) this.$cloudToggle.addEventListener('click', () => this._toggleCollapsible(this.$cloudToggle, this.$cloudBody));

    this.$latInput.addEventListener('change', () => {
      this.lat = parseFloat(this.$latInput.value) || this.lat;
      this._updateMinimap();
      this.scene.setLocation(this.lat, this.lng);
    });
    this.$lngInput.addEventListener('change', () => {
      this.lng = parseFloat(this.$lngInput.value) || this.lng;
      this._updateMinimap();
      this.scene.setLocation(this.lat, this.lng);
    });

    this.$radiusSlider.addEventListener('input', () => {
      this.radius = parseInt(this.$radiusSlider.value);
      document.getElementById('radius-val').textContent = `${this.radius}m`;
      this._updateMinimap();
    });

    if (this.$todSlider) {
      this.$todSlider.addEventListener('input', () => {
        if (this._deviceTimeMode) return;
        this.timeOfDay = parseFloat(this.$todSlider.value);
        this._applyTimeOfDay(this.timeOfDay);
      });
      this.$todSlider.addEventListener('mousedown',  () => { this._sliderDragging = true; });
      this.$todSlider.addEventListener('touchstart', () => { this._sliderDragging = true; }, { passive: true });
      this.$todSlider.addEventListener('mouseup',    () => { this._sliderDragging = false; });
      this.$todSlider.addEventListener('touchend',   () => { this._sliderDragging = false; });
    }

    if (this.$todManualBtn) this.$todManualBtn.addEventListener('click', () => this._setDeviceMode(false));
    if (this.$todDeviceBtn) this.$todDeviceBtn.addEventListener('click', () => this._setDeviceMode(true));

    if (this.$cloudManualBtn) this.$cloudManualBtn.addEventListener('click', () => this._setCloudAutoMode(false));
    if (this.$cloudAutoBtn)   this.$cloudAutoBtn.addEventListener('click',   () => this._setCloudAutoMode(true));

    if (this.$cloudCondSelect) {
      this.$cloudCondSelect.addEventListener('change', () => {
        this._cloudCondition = parseInt(this.$cloudCondSelect.value);
        this._applyCloudProperties();
      });
    }
    if (this.$cloudCoverSlider) {
      this.$cloudCoverSlider.addEventListener('input', () => {
        this._cloudCover = parseInt(this.$cloudCoverSlider.value);
        if (this.$cloudCoverVal) this.$cloudCoverVal.textContent = `${this._cloudCover}%`;
        this._applyCloudProperties();
      });
    }
    if (this.$cloudWindSpeedSl) {
      this.$cloudWindSpeedSl.addEventListener('input', () => {
        this._windSpeed = parseInt(this.$cloudWindSpeedSl.value);
        if (this.$cloudWindSpeedVal) this.$cloudWindSpeedVal.textContent = `${this._windSpeed} u/s`;
        this._applyCloudProperties();
      });
    }
    if (this.$cloudWindAngleSl) {
      this.$cloudWindAngleSl.addEventListener('input', () => {
        this._windAngleDeg = parseInt(this.$cloudWindAngleSl.value);
        if (this.$cloudWindAngleVal) this.$cloudWindAngleVal.textContent = `${this._windAngleDeg}°`;
        this._applyCloudProperties();
      });
    }
    if (this.$cloudAltitudeSl) {
      this.$cloudAltitudeSl.addEventListener('input', () => {
        this._cloudAltitude = parseInt(this.$cloudAltitudeSl.value);
        if (this.$cloudAltitudeVal) this.$cloudAltitudeVal.textContent = `${this._cloudAltitude}m`;
        this._applyCloudProperties();
      });
    }

    this.$modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.$modeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderMode = btn.dataset.mode;
        this.scene.setRenderMode(this.renderMode);
      });
    });

    this.$generateBtn.addEventListener('click', () => this._generate());
    this.$canvas.addEventListener('mousemove',  e => this._onMouseMove(e));
    this.$canvas.addEventListener('mouseleave', ()  => this.$tooltip.classList.add('hidden'));

    if (this.$enterSelBtn)  this.$enterSelBtn.addEventListener('click',  () => this._enterSelectionMode());
    if (this.$selBackBtn)   this.$selBackBtn.addEventListener('click',   () => this._exitSelectionMode());
    if (this.$enterWorldBtn) this.$enterWorldBtn.addEventListener('click', () => this._enterRoamingMode());
    if (this.$roamBackBtn)  this.$roamBackBtn.addEventListener('click',  () => this._exitRoamingMode());
  }

  // ── App Mode State Machine ────────────────────────────────────

  _enterSelectionMode() {
    if (!this._worldGenerated) return;
    this._appMode = 'location-selection';
    this._overlay.setAppMode(this._appMode);
    this._leftPanel.setAppMode(this._appMode);
    this.$uiPanel.classList.add('ui-hidden');
    this.$selectionPanel.classList.remove('panel-hidden');
    if (this.$enterWorldBtn) this.$enterWorldBtn.disabled = true;
    if (this.$enterWorldBtn) this.$enterWorldBtn.classList.remove('beacon-ready');
    if (this.$selectionHint) this.$selectionHint.textContent = '🎯 Click anywhere on the map to set your spawn point';
    this.scene.removeBeacon();
    this.scene.removeCharacter();
    this._beaconX = null;
    this._beaconY = null;
    this._beaconZ = null;
    this.scene.enterSelectionMode();
    document.body.classList.add('selection-active');
    this.$tooltip.classList.add('hidden');
  }

  _exitSelectionMode() {
    this._appMode = 'map-creation';
    this._overlay.setAppMode(this._appMode);
    this._leftPanel.setAppMode(this._appMode);
    this.$uiPanel.classList.remove('ui-hidden');
    this.$selectionPanel.classList.add('panel-hidden');
    document.body.classList.remove('selection-active');
    this.scene.exitSelectionMode();
    this.scene.removeBeacon();
  }

  _enterRoamingMode() {
    if (this._beaconX === null) return;
    this._appMode = 'roaming';
    this._overlay.setAppMode(this._appMode);
    this._leftPanel.setAppMode(this._appMode);
    this.$selectionPanel.classList.add('panel-hidden');
    this.scene.exitSelectionMode();
    this.scene.removeBeacon();
    document.body.classList.remove('selection-active');
    this.scene.spawnCharacter(this._beaconX, this._beaconY, this._beaconZ);
    const crosshair = document.getElementById('roam-crosshair');
    if (crosshair) crosshair.classList.remove('hidden');
    document.body.classList.add('roaming-active');
    const spawnVec = new THREE.Vector3(this._beaconX, this._beaconY, this._beaconZ);
    this.scene.transitionToRoaming(() => {
      this.scene.startRoamingCamera(spawnVec, () => { this._exitRoamingMode(); });
      this._startGameModeSession(spawnVec);
    });
  }

  // ── Game Mode ─────────────────────────────────────────────────

  setGameMode(mode) {
    if (mode !== 'explore' && mode !== 'race') return;
    this._gameMode = mode;
  }

  getGameMode() { return this._gameMode; }

  _startGameModeSession(spawnPos) {
    if (this._gameMode === 'race') {
      this._exploreJukeboxCat = null;
      this._setupRace(spawnPos);
      this._startRaceTimer();
      this._switchJukeboxCategory('day');
    } else {
      this._exploreJukeboxCat = null;
      this._syncJukeboxToTimeOfDay();
    }
  }

  _endGameModeSession() {
    this._stopRaceTimer();
    this._raceState = 'idle';
    this._exploreJukeboxCat = null;
  }

  _syncJukeboxToTimeOfDay() {
    const cat = (this.timeOfDay >= 6 && this.timeOfDay < 20) ? 'day' : 'night';
    this._switchJukeboxCategory(cat);
  }

  _setupRace(spawnPos) {
    const r = this.radius * 0.5;
    const offsets = [
      { x:  r, z:  0 }, { x:  0, z: -r },
      { x: -r, z:  0 }, { x:  0, z:  r },
    ];
    this._raceCheckpoints = offsets.map(o => ({
      x: spawnPos.x + o.x, y: spawnPos.y, z: spawnPos.z + o.z, radius: 12,
    }));
    this._raceNextCheckpoint = 0;
    this._raceTimeLeft       = this._raceDuration;
    this._raceState          = 'running';
  }

  _startRaceTimer() {
    this._stopRaceTimer();
    this._racePrevMs = performance.now();
    const tick = (nowMs) => {
      if (this._raceState !== 'running') return;
      this._raceRAFId = requestAnimationFrame(tick);
      const dtSec = (nowMs - (this._racePrevMs ?? nowMs)) / 1000;
      this._racePrevMs = nowMs;
      this._raceTimeLeft = Math.max(0, this._raceTimeLeft - dtSec);
      this._tickRaceCheckpoints();
      if (this._raceTimeLeft <= 0 && this._raceState === 'running') this._onRaceLose();
    };
    this._raceRAFId = requestAnimationFrame(tick);
  }

  _stopRaceTimer() {
    if (this._raceRAFId !== null) { cancelAnimationFrame(this._raceRAFId); this._raceRAFId = null; }
    this._racePrevMs = null;
  }

  _tickRaceCheckpoints() {
    if (this._raceNextCheckpoint >= this._raceCheckpoints.length) return;
    const charPos = this.scene.getCharacterPosition();
    if (!charPos) return;
    const cp = this._raceCheckpoints[this._raceNextCheckpoint];
    const dx = charPos.x - cp.x, dz = charPos.z - cp.z;
    if (dx * dx + dz * dz <= cp.radius * cp.radius) {
      this._raceNextCheckpoint++;
      if (this._raceNextCheckpoint >= this._raceCheckpoints.length) this._onRaceWin();
    }
  }

  _onRaceWin()  { this._raceState = 'win';  this._stopRaceTimer(); this._switchJukeboxCategory('win'); }
  _onRaceLose() { this._raceState = 'lose'; this._stopRaceTimer(); this._switchJukeboxCategory('lose'); }

  _switchJukeboxCategory(cat) {
    if (this._overlay) this._overlay.requestAutoPlay(cat);
  }

  _exitRoamingMode() {
    this._endGameModeSession();
    this._appMode = 'location-selection';
    this._overlay.setAppMode(this._appMode);
    this._leftPanel.setAppMode(this._appMode);
    this.$selectionPanel.classList.remove('panel-hidden');
    this.$uiPanel.classList.add('ui-hidden');
    const crosshair = document.getElementById('roam-crosshair');
    if (crosshair) crosshair.classList.add('hidden');
    document.body.classList.remove('roaming-active');
    this.scene.stopRoamingCamera();
    if (this.$enterWorldBtn) this.$enterWorldBtn.disabled = true;
    if (this.$enterWorldBtn) this.$enterWorldBtn.classList.remove('beacon-ready');
    if (this.$selectionHint) this.$selectionHint.textContent = '🎯 Click anywhere on the map to set your spawn point';
    this.scene.removeCharacter();
    this.scene.transitionToOrbit(0, 0, this.radius);
    this._beaconX = null;
    this._beaconY = null;
    this._beaconZ = null;
    document.body.classList.add('selection-active');
    this.scene.enterSelectionMode();
  }

  // ── Local time mode ───────────────────────────────────────────

  _setDeviceMode(on) {
    this._deviceTimeMode = on;
    if (this.$todManualBtn) this.$todManualBtn.classList.toggle('active', !on);
    if (this.$todDeviceBtn) this.$todDeviceBtn.classList.toggle('active', on);
    if (this.$todSliderWrap) {
      this.$todSliderWrap.style.opacity       = on ? '0.35' : '1';
      this.$todSliderWrap.style.pointerEvents = on ? 'none' : '';
    }
    if (this._deviceTimerID) { clearInterval(this._deviceTimerID); this._deviceTimerID = null; }
    if (on) this._syncDeviceTime();
    if (this._worldGenerated) { this._stopTimeLoop(); this._startTimeLoop(); }
  }

  _startTimeLoop() {
    this._stopTimeLoop();
    this._timePrevMs = performance.now();
    const tick = (nowMs) => {
      this._timeRAFId = requestAnimationFrame(tick);
      this._tickTimeLoop(nowMs);
    };
    this._timeRAFId = requestAnimationFrame(tick);
  }

  _stopTimeLoop() {
    if (this._timeRAFId !== null) { cancelAnimationFrame(this._timeRAFId); this._timeRAFId = null; }
    this._timePrevMs = null;
  }

  _tickExploreDayNight() {
    const cat = this._solarElevDeg(this.timeOfDay) > 0 ? 'day' : 'night';
    if (cat !== this._exploreJukeboxCat) {
      this._exploreJukeboxCat = cat;
      this._switchJukeboxCategory(cat);
    }
  }

  _tickTimeLoop(nowMs) {
    if (this._timePrevMs === null) { this._timePrevMs = nowMs; return; }
    const dtSec = (nowMs - this._timePrevMs) / 1000;
    this._timePrevMs = nowMs;
    if (this._deviceTimeMode) {
      const areaHour = this._getAreaHour();
      if (Math.abs(areaHour - this.timeOfDay) > 0.0005) {
        this.timeOfDay = areaHour;
        if (this.$todSlider) this.$todSlider.value = areaHour;
        this._applyTimeOfDay(areaHour);
      }
    } else {
      if (this._sliderDragging) return;
      this.timeOfDay = (this.timeOfDay + this._TIME_RATE_MANUAL * dtSec) % 24;
      if (this.$todSlider) this.$todSlider.value = this.timeOfDay;
      this._applyTimeOfDay(this.timeOfDay);
    }
    if (this._gameMode === 'explore') this._tickExploreDayNight();
  }

  _getAreaHour() {
    try {
      const now = new Date();
      if (this._localTimezone) {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: this._localTimezone,
          hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
        }).formatToParts(now);
        const get = type => parseInt(parts.find(p => p.type === type)?.value ?? '0');
        let h = get('hour');
        if (h === 24) h = 0;
        return h + get('minute') / 60 + get('second') / 3600;
      }
    } catch (_) {}
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  }

  _syncDeviceTime() {
    const hour = this._getAreaHour();
    this.timeOfDay = hour;
    if (this.$todSlider) this.$todSlider.value = hour;
    this._applyTimeOfDay(hour);
  }

  _applyTimeOfDay(hour) {
    this.scene.setTimeOfDay(hour);
    const nowMs = performance.now();
    if (!this._lastArcDrawMs || nowMs - this._lastArcDrawMs >= 100) {
      this._lastArcDrawMs = nowMs;
      this._drawArc(hour);
      this._updateIndicators(hour);
    }
    const h  = Math.floor(hour) % 24;
    const m  = Math.round((hour % 1) * 60);
    const np = this._nightPhaseForHour(hour);
    const label = `${np > 0.5 ? '☽' : '☀'} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    if (this.$todLabel) this.$todLabel.textContent = label;
    if (this.$todMeta)  this.$todMeta.textContent  = label;
    if (this.$todTzLabel) {
      if (this._deviceTimeMode && this._localTimezone) {
        const city = this._localTimezone.split('/').pop().replace(/_/g, ' ');
        this.$todTzLabel.textContent = `🌐 ${city}`;
      } else {
        this.$todTzLabel.textContent = '';
      }
    }
  }

  _toggleCollapsible(btn, body) {
    const isOpen = body.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(isOpen));
  }

  async _geocode() {
    const q = this.$locationInput.value.trim();
    if (!q) return;
    this._setStatus('Geocoding…', 'active');
    try {
      const result = await this.fetcher.geocode(q);
      this.lat = result.lat;
      this.lng = result.lng;
      this.$latInput.value = result.lat.toFixed(6);
      this.$lngInput.value = result.lng.toFixed(6);
      this._setStatus(`📍 ${result.display.split(',').slice(0,2).join(',')}`, '');
      this._updateMinimap();
      this.scene.setLocation(this.lat, this.lng);
      if (this._deviceTimeMode) {
        this.fetcher.fetchWeather(this.lat, this.lng).then(w => {
          if (w.timezone) { this._localTimezone = w.timezone; this._syncDeviceTime(); }
        }).catch(() => {});
      }
    } catch (err) {
      this._setStatus(`Geocoding failed: ${err.message}`, 'error');
    }
  }

  _getMapKey() {
    return `${this.lat.toFixed(5)}|${this.lng.toFixed(5)}|${this.radius}`;
  }

  async _generate() {
    this.$generateBtn.disabled = true;
    if (this.$enterSelBtn) {
      this.$enterSelBtn.disabled = true;
      this.$enterSelBtn.classList.remove('world-ready');
    }
    this.$stats.classList.add('hidden');
    this.scene.clearWorld();
    this._stopTimeLoop();
    this._worldGenerated = false;
    this._setStatus('Fetching map data…', 'active loading');
    try {
      let weatherPromise;
      if (this._cloudAutoMode) {
        weatherPromise = this.fetcher.fetchWeather(this.lat, this.lng);
      } else {
        const wmoCode = [0, 2, 3, 45, 61, 95][this._cloudCondition] ?? 1;
        weatherPromise = Promise.resolve({ cloudCover: this._cloudCover, weatherCode: wmoCode });
      }

      const mapKey = this._getMapKey();
      const waysPromise = (this._lastMapKey === mapKey && this._lastWays)
        ? Promise.resolve(this._lastWays)
        : this._fetchWithRetry(this.lat, this.lng, this.radius);

      const [ways, weather] = await Promise.all([waysPromise, weatherPromise]);
      if (!ways.length) throw new Error('No map features found in this area.');
      this._lastWays   = ways;
      this._lastMapKey = mapKey;

      if (weather.timezone) this._localTimezone = weather.timezone;
      this.scene.setLocation(this.lat, this.lng);
      this.scene.setWeather(weather.cloudCover, weather.weatherCode);
      if (this._cloudAutoMode) this._syncWeatherToUI(weather);
      this._applyCloudProperties();

      this._setStatus('Fetching elevation data and building world…', 'active loading');
      await this._nextFrame();
      this.scene._collidables = [];
      const result = await this.builder.build(ways, this.heightScale, this.lat, this.lng, this.radius);
      this.scene.setRenderMode(this.renderMode);
      this.scene.flyTo(0, 0, this.radius);

      if (this._deviceTimeMode) {
        this._syncDeviceTime();
      } else {
        this._applyTimeOfDay(this.timeOfDay);
      }

      this.$statBuildings.textContent = `${result.buildings} buildings`;
      this.$statRoads.textContent     = `${result.roads} road segments`;
      this.$statTris.textContent      = `${Math.round(result.triangleCount).toLocaleString()} triangles`;
      this.$stats.classList.remove('hidden');

      this._worldGenerated = true;
      this._startTimeLoop();

      if (this._overlay) {
        const initialCat = this._solarElevDeg(this.timeOfDay) > 0 ? 'day' : 'night';
        this._overlay.requestAutoPlay(initialCat);
      }
      if (this.$enterSelBtn) {
        this.$enterSelBtn.disabled = false;
        this.$enterSelBtn.classList.add('world-ready');
      }

      const cloudDesc = this._cloudCover < 20 ? 'clear skies' :
                        this._cloudCover < 50 ? 'partly cloudy' :
                        this._cloudCover < 80 ? 'mostly cloudy' : 'overcast';
      this._setStatus(`World ready — ${cloudDesc} (${this._cloudCover}% · ${this._cloudAutoMode ? 'live weather' : 'manual'}). Satellite imagery loading…`, '');
      setTimeout(() => {
        if (this.$status.textContent.includes('Satellite')) {
          this._setStatus('Drag to orbit · Scroll to zoom · Hover to inspect', '');
        }
      }, 6000);
    } catch (err) {
      this._setStatus(`Error: ${err.message}`, 'error');
      if (this.$enterSelBtn) {
        this.$enterSelBtn.disabled = true;
        this.$enterSelBtn.classList.remove('world-ready');
      }
      console.error(err);
    } finally {
      this.$generateBtn.disabled = false;
    }
  }

  async _fetchWithRetry(lat, lng, radius) {
    try {
      this._setStatus('Fetching map data…', 'active loading');
      const result = await this.fetcher.fetchArea(lat, lng, radius);
      if (!result || !result.ways || result.ways.length === 0) throw new Error('Empty map data');
      const hasCoreData = result.ways.some(w => w.kind === 'building' || w.kind === 'road');
      if (!hasCoreData) throw new Error('Incomplete map data');
      this._setStatus(result.source === 'cache' ? 'Loaded cached map data' : 'Map data loaded', '');
      return result.ways;
    } catch (err) {
      console.error('Map load failed:', err);
      this._setStatus('Failed to load map data', 'error');
      throw err;
    }
  }

  _onMouseMove(e) {
    if (this._appMode !== 'map-creation') {
      this.$tooltip.classList.add('hidden');
    }
  }

  _setStatus(msg, cls) {
    this.$status.textContent = msg;
    this.$status.className   = cls || '';
  }

  _updateMinimap() {
    this.minimap.update(this.lng, this.lat, this.radius, 'streets');
  }

  _nextFrame() { return new Promise(r => requestAnimationFrame(r)); }
  _sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }
}

// ── Module-level math helpers ──────────────────────────────────
function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function _smoothstep(x, lo, hi) {
  const t = _clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}
