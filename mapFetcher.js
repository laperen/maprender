// js/mapFetcher.js — Fetches OSM vector data via Protomaps / OpenFreeMap vector tiles
// Geocoding via Photon (CORS-friendly, OSM-backed).
//
// Vector tile sources (MVT / Mapbox-Vector-Tile format, z/x/y):
//   Primary  : https://tile.openfreemap.org/planet/{z}/{x}/{y}  (free, no key)
//   Fallback : https://tiles.stadiamaps.com/data/openmaptiles/{z}/{x}/{y}.pbf (free tier)
//
// Decoding uses the lightweight `pbf` + `@mapbox/vector-tile` libraries
// loaded from CDN via dynamic import (cached after first load).
//
// Public interface is identical to the old Overpass-based class:
//   fetchArea(lat, lng, radiusMeters) → { ways: [...], source: 'network'|'cache' }
//   fetchWeather(lat, lng)            → { cloudCover, weatherCode, windSpeed, windDirection }
//   geocode(placeName)                → { lat, lng, display }

export class MapFetcher {
  constructor() {
    this.photonUrl = 'https://photon.komoot.io/api/';
    this.MAX_CHUNKS = 40;

    // Tile endpoints — tried in order
    this._tileEndpoints = [
      'https://tile.openfreemap.org/planet',
      'https://tiles.stadiamaps.com/data/openmaptiles',
    ];

    // Cached decode library reference
    this._vtLib = null;
    this._db = null;
  }

  // ═══════════════════════════════════════════════════════════════
  // GEOCODING (unchanged)
  // ═══════════════════════════════════════════════════════════════

  async geocode(placeName) {
    const url = `${this.photonUrl}?q=${encodeURIComponent(placeName)}&limit=1&lang=en`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Geocoding failed');
    const data = await res.json();
    if (!data.features?.length) throw new Error(`Place not found: "${placeName}"`);
    const [lng, lat] = data.features[0].geometry.coordinates;
    const props = data.features[0].properties;
    const display = [props.name, props.city, props.country].filter(Boolean).join(', ');
    return { lat, lng, display };
  }

  // ═══════════════════════════════════════════════════════════════
  // WEATHER (unchanged)
  // ═══════════════════════════════════════════════════════════════

  async fetchWeather(lat, lng) {
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
        `&current=cloud_cover,weather_code,wind_speed_10m,wind_direction_10m` +
        `&wind_speed_unit=ms&forecast_days=1`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('weather fetch failed');
      const json = await res.json();
      const cur = json.current || {};
      const windSpeed = Math.min(80, Math.round((cur.wind_speed_10m ?? 5) * 2));
      return {
        cloudCover:    cur.cloud_cover       ?? 40,
        weatherCode:   cur.weather_code      ?? 1,
        windSpeed,
        windDirection: Math.round(cur.wind_direction_10m ?? 13),
      };
    } catch (_) {
      return { cloudCover: 40, weatherCode: 1, windSpeed: 18, windDirection: 13 };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN FETCH (replaces Overpass)
  // ═══════════════════════════════════════════════════════════════

  async fetchArea(lat, lng, radiusMeters = 500) {
    const key = this._getGridKey(lat, lng);
    const cached = await this._getChunk(key);

    // Try fetching fresh data from vector tiles
    try {
      const ways = await this._fetchFromVectorTiles(lat, lng, radiusMeters);
      if (ways && ways.length > 0) {
        await this._setChunk(key, ways);
        return { ways, source: 'network' };
      }
      throw new Error('No features decoded from tiles');
    } catch (err) {
      console.warn('Vector tile fetch failed, trying cache:', err);
      if (cached?.data?.length > 0) {
        return { ways: cached.data, source: 'cache' };
      }
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // VECTOR TILE FETCH + DECODE
  // ═══════════════════════════════════════════════════════════════

  async _fetchFromVectorTiles(lat, lng, radiusMeters) {
    // Choose zoom: high enough for building detail, low enough to cover the radius
    const zoom = this._zoomForRadius(radiusMeters);

    // Find the tile(s) we need — fetch a 3×3 grid centred on the target tile
    // so features near tile edges aren't clipped.
    const { tx: cx, ty: cy } = this._latLngToTile(lat, lng, zoom);

    // Decide grid size based on radius
    const span = radiusMeters > 600 ? 2 : 1; // ±1 or ±0 tiles around centre
    const tilesToFetch = [];
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        tilesToFetch.push({ tx: cx + dx, ty: cy + dy, zoom });
      }
    }

    // Load PBF decode library once
    await this._ensureVtLib();

    // Fetch all tiles in parallel, try endpoints in order
    const results = await Promise.all(
      tilesToFetch.map(t => this._fetchOneTile(t.tx, t.ty, t.zoom))
    );

    // Decode and merge
    const ways = [];
    const seenIds = new Set();

    for (let i = 0; i < tilesToFetch.length; i++) {
      const buf = results[i];
      if (!buf) continue;
      const { tx, ty, zoom: z } = tilesToFetch[i];
      try {
        const decoded = this._decodeTile(buf, tx, ty, z, lat, lng, seenIds);
        ways.push(...decoded);
      } catch (e) {
        console.warn('Tile decode error:', e);
      }
    }

    return ways;
  }

  async _fetchOneTile(tx, ty, zoom) {
    for (const base of this._tileEndpoints) {
      try {
        const url = `${base}/${zoom}/${tx}/${ty}`;
        const res = await this._fetchWithTimeout(url, {
          headers: { 'Accept': 'application/x-protobuf, application/vnd.mapbox-vector-tile, */*' }
        }, 10000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.arrayBuffer();
      } catch (e) {
        console.warn(`Tile endpoint failed (${base}):`, e.message);
      }
    }
    return null;
  }

  // ── Decode a single MVT tile → way objects ────────────────────
  _decodeTile(arrayBuffer, tx, ty, zoom, centerLat, centerLng, seenIds) {
    const { VectorTile, Pbf } = this._vtLib;
    const tile = new VectorTile(new Pbf(arrayBuffer));

    const ways = [];

    // Layer names to process (OpenMapTiles / OpenFreeMap schema)
    const BUILDING_LAYERS = ['building', 'building_part'];
    const ROAD_LAYERS     = ['transportation', 'road'];
    const WATER_LAYERS    = ['water', 'waterway'];
    const PARK_LAYERS     = ['park', 'landuse', 'landcover'];

    // ── Buildings ─────────────────────────────────────────────
    for (const layerName of BUILDING_LAYERS) {
      const layer = tile.layers[layerName];
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const feat = layer.feature(i);
        if (feat.type !== 3) continue; // polygons only
        const uid = `b_${tx}_${ty}_${i}`;
        if (seenIds.has(uid)) continue;
        seenIds.add(uid);

        const geoms = feat.loadGeometry(); // array of rings, each [{x,y}]
        for (const ring of geoms) {
          const coords = ring.map(pt => this._tilePointToWorld(pt, tx, ty, zoom, centerLat, centerLng));
          if (coords.length < 3) continue;

          const tags = feat.properties || {};
          ways.push({
            id:     uid,
            kind:   'building',
            tags:   this._normaliseBuildingTags(tags),
            coords,
            height: this._estimateHeight(tags),
            closed: true,
          });
          break; // only outer ring
        }
      }
    }

    // ── Roads ────────────────────────────────────────────────
    for (const layerName of ROAD_LAYERS) {
      const layer = tile.layers[layerName];
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const feat = layer.feature(i);
        if (feat.type !== 2) continue; // lines only
        const uid = `r_${tx}_${ty}_${i}`;
        if (seenIds.has(uid)) continue;
        seenIds.add(uid);

        const tags = feat.properties || {};
        const highway = this._resolveHighway(tags);
        if (!highway) continue;

        const geoms = feat.loadGeometry();
        for (const line of geoms) {
          const coords = line.map(pt => this._tilePointToWorld(pt, tx, ty, zoom, centerLat, centerLng));
          if (coords.length < 2) continue;
          ways.push({
            id:     uid,
            kind:   'road',
            tags:   { highway },
            coords,
            height: 0,
            closed: false,
          });
        }
      }
    }

    // ── Water ────────────────────────────────────────────────
    for (const layerName of WATER_LAYERS) {
      const layer = tile.layers[layerName];
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const feat = layer.feature(i);
        if (feat.type !== 3) continue;
        const uid = `w_${tx}_${ty}_${i}`;
        if (seenIds.has(uid)) continue;
        seenIds.add(uid);

        const geoms = feat.loadGeometry();
        for (const ring of geoms) {
          const coords = ring.map(pt => this._tilePointToWorld(pt, tx, ty, zoom, centerLat, centerLng));
          if (coords.length < 3) continue;
          ways.push({
            id: uid, kind: 'water',
            tags: { natural: 'water' }, coords, height: 0, closed: true,
          });
          break;
        }
      }
    }

    // ── Parks / landuse ──────────────────────────────────────
    for (const layerName of PARK_LAYERS) {
      const layer = tile.layers[layerName];
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const feat = layer.feature(i);
        if (feat.type !== 3) continue;
        const tags = feat.properties || {};
        const cls = tags.class || tags.subclass || '';
        if (!cls.match(/park|grass|meadow|garden|forest|wood|scrub/i)) continue;

        const uid = `p_${tx}_${ty}_${i}`;
        if (seenIds.has(uid)) continue;
        seenIds.add(uid);

        const geoms = feat.loadGeometry();
        for (const ring of geoms) {
          const coords = ring.map(pt => this._tilePointToWorld(pt, tx, ty, zoom, centerLat, centerLng));
          if (coords.length < 3) continue;
          ways.push({
            id: uid, kind: 'park',
            tags: { leisure: 'park' }, coords, height: 0, closed: true,
          });
          break;
        }
      }
    }

    return ways;
  }

  // ── Convert tile-local pixel coords to world-space (metres from centre) ─
  _tilePointToWorld(pt, tx, ty, zoom, centerLat, centerLng) {
    // MVT tile extent is 4096 units per tile by default
    const extent = 4096;
    const n = Math.pow(2, zoom);

    // Fractional tile coordinates
    const fracX = tx + pt.x / extent;
    const fracY = ty + pt.y / extent;

    // Convert to lat/lng
    const lng = (fracX / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * fracY) / n)));
    const lat = latRad * 180 / Math.PI;

    // Project to metres from centre
    return this._project(lat, lng, centerLat, centerLng);
  }

  // ── Mercator flat projection (identical to old Overpass version) ─
  _project(lat, lng, cLat, cLng) {
    const R = 6378137;
    const dLat = (lat - cLat) * Math.PI / 180;
    const dLng = (lng - cLng) * Math.PI / 180;
    const x = dLng * R * Math.cos(cLat * Math.PI / 180);
    const z = -dLat * R;
    return { x, z };
  }

  // ── Normalise MVT building tags to OSM-style ──────────────────
  _normaliseBuildingTags(tags) {
    const out = {};

    // building type
    const cls = tags.class || tags.subclass || tags.building || 'yes';
    out.building = cls;

    // height — OpenMapTiles stores render_height or height as number
    if (tags.render_height != null) out.height = String(tags.render_height);
    else if (tags.height != null)   out.height = String(tags.height);

    // levels
    if (tags.building_levels != null) out['building:levels'] = String(tags.building_levels);
    else if (tags.levels != null)     out['building:levels'] = String(tags.levels);

    // colour — OpenMapTiles/OpenFreeMap may carry colour fields
    if (tags.building_colour || tags['building:colour']) {
      out['building:colour'] = tags.building_colour || tags['building:colour'];
    }
    if (tags.roof_colour || tags['roof:colour']) {
      out['roof:colour'] = tags.roof_colour || tags['roof:colour'];
    }
    if (tags.building_material || tags['building:material']) {
      out['building:material'] = tags.building_material || tags['building:material'];
    }

    return out;
  }

  // ── Map MVT road class to OSM highway tag ────────────────────
  _resolveHighway(tags) {
    const cls = tags.class || tags.subclass || tags.highway || '';
    const MAP = {
      motorway: 'motorway', trunk: 'trunk', primary: 'primary',
      secondary: 'secondary', tertiary: 'tertiary',
      minor: 'residential', residential: 'residential',
      service: 'service', path: 'path', track: 'service',
      pedestrian: 'footway', footway: 'footway', cycleway: 'cycleway',
      living_street: 'living_street',
    };
    return MAP[cls] || (cls ? 'residential' : null);
  }

  // ── Building height estimation (same logic as old version) ────
  _estimateHeight(tags) {
    const rh = parseFloat(tags.render_height);
    if (!isNaN(rh) && rh > 0) return rh;
    const h = parseFloat(tags.height);
    if (!isNaN(h) && h > 0) return h;
    const levels = parseFloat(tags.building_levels || tags.levels);
    if (!isNaN(levels) && levels > 0) return levels * 3;
    const t = tags.class || tags.building || 'yes';
    if (t === 'yes')         return 10;
    if (t === 'house')       return 7;
    if (t === 'apartments')  return 20;
    if (t === 'office')      return 40;
    if (t === 'skyscraper')  return 120;
    if (t === 'tower')       return 60;
    if (t === 'cathedral' || t === 'church') return 25;
    if (t === 'industrial')  return 12;
    return 10;
  }

  // ═══════════════════════════════════════════════════════════════
  // TILE MATH
  // ═══════════════════════════════════════════════════════════════

  _zoomForRadius(r) {
    // z14 covers ~2.4 km², fine enough for building outlines
    if (r <= 300)  return 15;
    if (r <= 600)  return 14;
    if (r <= 1000) return 14;
    return 13;
  }

  _latLngToTile(lat, lng, zoom) {
    const n  = Math.pow(2, zoom);
    const tx = Math.floor((lng + 180) / 360 * n);
    const ty = Math.floor(
      (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n
    );
    return { tx, ty };
  }

  _getGridKey(lat, lng) {
    const size = 0.01;
    return `${Math.floor(lat / size)}:${Math.floor(lng / size)}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // LIBRARY LOADER — pbf + @mapbox/vector-tile via CDN
  // ═══════════════════════════════════════════════════════════════

  async _ensureVtLib() {
    if (this._vtLib) return;

    // Load both scripts sequentially via classic <script> tags so they
    // attach to the global scope (these UMD bundles expect window.Pbf etc.)
    await this._loadScript('https://unpkg.com/pbf@3.3.0/dist/pbf.js');
    await this._loadScript('https://unpkg.com/@mapbox/vector-tile@1.3.1/dist/vector-tile.js');

    // The UMD bundles expose globals: window.Pbf and window.VectorTile
    if (!window.Pbf || !window.VectorTile) {
      throw new Error('Vector tile decode libraries failed to load');
    }
    this._vtLib = { Pbf: window.Pbf, VectorTile: window.VectorTile };
  }

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Script load failed: ${src}`));
      document.head.appendChild(s);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // INDEXEDDB CACHE (same schema as before)
  // ═══════════════════════════════════════════════════════════════

  async _initDB() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('MapCacheDB', 3); // bump version for new schema
      req.onupgradeneeded = () => {
        const db = req.result;
        let store;
        if (!db.objectStoreNames.contains('chunks')) {
          store = db.createObjectStore('chunks', { keyPath: 'key' });
        } else {
          store = req.transaction.objectStore('chunks');
        }
        if (!store.indexNames.contains('timestamp')) {
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return this._db;
  }

  async _countChunks() {
    const db = await this._initDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async _evictOldestChunks(countToRemove) {
    const db = await this._initDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      const index = store.index('timestamp');
      let deleted = 0;
      const req = index.openCursor();
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || deleted >= countToRemove) { resolve(); return; }
        store.delete(cursor.primaryKey);
        deleted++;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async _getChunk(key) {
    const db = await this._initDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      const req   = store.get(key);
      req.onsuccess = () => {
        const result = req.result;
        if (result) { result.timestamp = Date.now(); store.put(result); }
        resolve(result || null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async _setChunk(key, data) {
    const db = await this._initDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put({ key, data, timestamp: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    const count = await this._countChunks();
    if (count > this.MAX_CHUNKS) {
      await this._evictOldestChunks(count - this.MAX_CHUNKS);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════

  _fetchWithTimeout(url, options = {}, timeout = 10000) {
    const ctrl = new AbortController();
    const id   = setTimeout(() => ctrl.abort(), timeout);
    return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(id));
  }
}
