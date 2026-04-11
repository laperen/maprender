// js/minimap.js — 2D MapLibre GL preview panel
// Uses OpenStreetMap raster tiles via MapLibre GL JS.

const MAPLIBRE_CDN_CSS = './maplibre/maplibre-gl.css';
const MAPLIBRE_CDN_JS  = './maplibre/maplibre-gl.js';

// MapLibre GL style specs backed by OSM raster tiles.
// Each style wraps the OSM tile source in a minimal style document
// so MapLibre can render it natively without a vector tile server.
function makeRasterStyle(tileUrl, attribution) {
  return {
    version: 8,
    sources: {
      'osm-tiles': {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        attribution: attribution || '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: 'osm-tiles-layer',
        type: 'raster',
        source: 'osm-tiles',
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  };
}

const STYLES = {
  // Standard OSM Carto tiles
  streets: makeRasterStyle(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  ),

  // OpenTopoMap for terrain
  terrain: makeRasterStyle(
    'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://opentopomap.org">OpenTopoMap</a>'
  ),

  // CartoDB Dark Matter (no API key required)
  dark: makeRasterStyle(
    'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://carto.com/attributions">CARTO</a>'
  ),

  // Esri World Imagery for satellite (no key required)
  satellite: makeRasterStyle(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics'
  ),
};

export class MiniMap {
  constructor(containerId) {
    this.containerId   = containerId;
    this.map           = null;
    this._loaded       = false;
    this._pending      = null;
    this._currentStyle = 'streets';
    this._load();
  }

  _load() {
    if (!document.querySelector('#maplibre-css')) {
      const link = document.createElement('link');
      link.id    = 'maplibre-css';
      link.rel   = 'stylesheet';
      link.href  = MAPLIBRE_CDN_CSS;
      document.head.appendChild(link);
    }

    if (window.maplibregl) { this._init(); return; }
    const script = document.createElement('script');
    script.src   = MAPLIBRE_CDN_JS;
    script.onload = () => this._init();
    document.head.appendChild(script);
  }

  _init() {
    this.map = new window.maplibregl.Map({
      container:        this.containerId,
      style:            STYLES.streets,
      center:           [139.7671, 35.6812],
      zoom:             13,
      interactive:      false,
      attributionControl: { compact: true },
    });

    this.map.on('load', () => {
      this._loaded = true;
      if (this._pending) {
        const [lng, lat, radius, styleName] = this._pending;
        this._pending = null;
        this.update(lng, lat, radius, styleName);
      }
    });
  }

  update(lng, lat, radiusMeters = 500, styleName = 'streets') {
    if (!this._loaded) {
      this._pending = [lng, lat, radiusMeters, styleName];
      return;
    }

    if (styleName !== this._currentStyle) {
      this._currentStyle = styleName;
      this.map.setStyle(STYLES[styleName] || STYLES.streets);
      // Re-add the circle overlay once the new style settles
      this.map.once('styledata', () => this._drawCircle(lng, lat, radiusMeters));
    } else {
      this._drawCircle(lng, lat, radiusMeters);
    }

    this.map.setCenter([lng, lat]);
    this.map.setZoom(this._zoomForRadius(radiusMeters));
  }

  _drawCircle(lng, lat, radiusMeters) {
    const circle = this._geoCircle(lng, lat, radiusMeters);

    if (this.map.getSource('area-circle')) {
      this.map.getSource('area-circle').setData(circle);
    } else {
      this.map.addSource('area-circle', { type: 'geojson', data: circle });
      this.map.addLayer({
        id: 'area-fill', type: 'fill', source: 'area-circle',
        paint: { 'fill-color': '#4fffb0', 'fill-opacity': 0.15 },
      });
      this.map.addLayer({
        id: 'area-outline', type: 'line', source: 'area-circle',
        paint: { 'line-color': '#4fffb0', 'line-width': 1.5 },
      });
    }
  }

  _zoomForRadius(r) {
    return Math.max(11, 16 - Math.log2(r / 100));
  }

  _geoCircle(lng, lat, radiusM, steps = 64) {
    const R = 6378137;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const dLat  = (radiusM * Math.cos(angle)) / R * (180 / Math.PI);
      const dLng  = (radiusM * Math.sin(angle)) / (R * Math.cos(lat * Math.PI / 180)) * (180 / Math.PI);
      pts.push([lng + dLng, lat + dLat]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] } };
  }
}