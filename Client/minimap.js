// js/minimap.js — 2D Leaflet preview panel
// Uses OpenStreetMap tiles directly. Leaflet loads tiles as <img> tags
// which OSM explicitly supports, avoiding all CORS/Worker issues.

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

export class MiniMap {
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
    // Inject Leaflet CSS
    if (!document.querySelector('#leaflet-css')) {
      const link = document.createElement('link');
      link.id    = 'leaflet-css';
      link.rel   = 'stylesheet';
      link.href  = LEAFLET_CSS;
      document.head.appendChild(link);
    }

    // Inject Leaflet JS then initialise
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

    // Add default tile layer
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

    // Switch tile layer if style changed
    if (styleName !== this._currentStyle && TILE_LAYERS[styleName]) {
      this._currentStyle = styleName;
      const def = TILE_LAYERS[styleName];
      if (this._tileLayer) this.map.removeLayer(this._tileLayer);
      this._tileLayer = L.tileLayer(def.url, {
        attribution: def.attribution,
        maxZoom:     19,
      }).addTo(this.map);
    }

    // Update map centre and zoom
    this.map.setView([lat, lng], this._zoomForRadius(radiusMeters));

    // Draw/update the highlight circle
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
