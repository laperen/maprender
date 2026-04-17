// js/mapFetcher.js — Fetches OSM vector data via Overpass API
// Geocoding via Photon (CORS-friendly, OSM-backed).

export class MapFetcher {
  constructor() {
    this.overpassEndpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://lz4.overpass-api.de/api/interpreter'
    ];
    this.photonUrl   = 'https://photon.komoot.io/api/';
    this.MAX_CHUNKS = 20; // tune this
  }
  async _countChunks() {
    const db = await this._initDB();
  
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const store = tx.objectStore('chunks');
      const req = store.count();
  
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  async _evictOldestChunks(countToRemove) {
    const db = await this._initDB();
  
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      const index = store.index('timestamp');
  
      let deleted = 0;
  
      // 🔁 Cursor starts from OLDEST automatically
      const req = index.openCursor();
  
      req.onsuccess = (event) => {
        const cursor = event.target.result;
  
        if (!cursor || deleted >= countToRemove) {
          resolve();
          return;
        }
  
        store.delete(cursor.primaryKey);
        deleted++;
  
        cursor.continue();
      };
  
      req.onerror = () => reject(req.error);
    });
  }
  async _initDB() {
    if (this._db) return this._db;
  
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('MapCacheDB', 2); // ⚠️ bump version
  
      req.onupgradeneeded = () => {
        const db = req.result;
  
        let store;
  
        if (!db.objectStoreNames.contains('chunks')) {
          store = db.createObjectStore('chunks', { keyPath: 'key' });
        } else {
          store = req.transaction.objectStore('chunks');
        }
  
        // ✅ Create index on timestamp
        if (!store.indexNames.contains('timestamp')) {
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
  
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  
    return this._db;
  }
  _getGridKey(lat, lng) {
    const size = 0.01;//1000m
    const latKey = Math.floor(lat / size);
    const lngKey = Math.floor(lng / size);
    return `${latKey}:${lngKey}`;
  }
  async _getChunk(key) {
    const db = await this._initDB();
  
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite'); // NOTE: readwrite
      const store = tx.objectStore('chunks');
      const req = store.get(key);
  
      req.onsuccess = () => {
        const result = req.result;
  
        if (result) {
          // update last-used time
          result.timestamp = Date.now();
          store.put(result);
        }
  
        resolve(result || null);
      };
  
      req.onerror = () => reject(req.error);
    });
  }
  
  async _setChunk(key, data) {
    const db = await this._initDB();
  
    // 1. Insert/update chunk
    await new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
  
      store.put({
        key,
        data,
        timestamp: Date.now()
      });
  
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  
    // 2. Check size AFTER insert
    const count = await this._countChunks();
  
    if (count > this.MAX_CHUNKS) {
      const overflow = count - this.MAX_CHUNKS;
  
      console.warn(`Evicting ${overflow} old map chunks`);
  
      await this._evictOldestChunks(overflow);
    }
  }
  _isFresh(chunk, maxAgeMs = 86400000) { // 1 day
    if (!chunk) return false;
    return (Date.now() - chunk.timestamp) < maxAgeMs;
  }
  _shuffleEndpoints() {
    return [...this.overpassEndpoints].sort(() => Math.random() - 0.5);
  }
  async _fetchWithTimeout(url, options, timeout = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
  
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      return res;
    } finally {
      clearTimeout(id);
    }
  }
  async _retry(fn, attempts = 3) {
    let delay = 500;
  
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === attempts - 1) throw err;
  
        await new Promise(r => setTimeout(r, delay));
        delay *= 2; // exponential backoff
      }
    }
  }
  // ── Geocoding (Photon) ───────────────────────────────────────
  async geocode(placeName) {
    const url = `${this.photonUrl}?q=${encodeURIComponent(placeName)}&limit=1&lang=en`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Geocoding failed');
    const data = await res.json();
    if (!data.features?.length) throw new Error(`Place not found: "${placeName}"`);
    const [lng, lat] = data.features[0].geometry.coordinates;
    const props      = data.features[0].properties;
    const display    = [props.name, props.city, props.country].filter(Boolean).join(', ');
    return { lat, lng, display };
  }

  // ── Overpass fetch ───────────────────────────────────────────
  /**
   * Fetch buildings, roads, water, parks within `radiusMeters` of (lat, lng).
   * @param {number} lat
   * @param {number} lng
   * @param {number} radiusMeters
   * @param {string} [overpassUrl] — optional mirror URL, falls back to default
   * @returns {Array} parsed way objects
   */
  async fetchArea(lat, lng, radiusMeters = 500) {
    const key = this._getGridKey(lat, lng);
    const cached = await this._getChunk(key);
  
    const endpoints = this._shuffleEndpoints();
    let lastError;
  
    // 🔁 Try ALL endpoints first
    for (const endpoint of endpoints) {
      try {
        const data = await this._retry(() =>
          this._fetchFromOverpass(lat, lng, radiusMeters, endpoint)
        );
  
        // ✅ Success → update cache
        await this._setChunk(key, data);
  
        return { ways: data, source: 'network' };
  
      } catch (err) {
        lastError = err;
        console.warn(`Endpoint failed: ${endpoint}`, err);
      }
    }
  
    // 💾 ONLY after all endpoints fail → fallback to cache
    if (cached && cached.data) {
      console.warn('All endpoints failed, using cached data');
      return { ways: cached.data, source: 'cache' };
    }
  
    // ❌ Nothing worked
    throw lastError || new Error('Map data unavailable');
  }
  async _fetchFromOverpass(lat, lng, radiusMeters, endpoint) {
    const r = radiusMeters;
  
    const query = `
  [out:json][timeout:25];
  (
    way["building"](around:${r},${lat},${lng});
    way["highway"](around:${r},${lat},${lng});
    way["waterway"](around:${r},${lat},${lng});
    way["natural"="water"](around:${r},${lat},${lng});
    way["leisure"="park"](around:${r},${lat},${lng});
    way["landuse"="grass"](around:${r},${lat},${lng});
  );
  out body;
  >;
  out skel qt;
    `.trim();
  
    const res = await this._fetchWithTimeout(endpoint, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
  
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  
    const json = await res.json();
    return this._parse(json, lat, lng);
  }

  // ── Parse OSM JSON → structured data ────────────────────────
  _parse(json, centerLat, centerLng) {
    const nodes = new Map();
    const ways  = [];

    for (const el of json.elements) {
      if (el.type === 'node') {
        nodes.set(el.id, { lat: el.lat, lng: el.lon });
      }
    }

    for (const el of json.elements) {
      if (el.type !== 'way' || !el.nodes || !el.tags) continue;
      const coords = el.nodes
        .map(nid => nodes.get(nid))
        .filter(Boolean)
        .map(n => this._project(n.lat, n.lng, centerLat, centerLng));

      if (!coords.length) continue;

      const kind = this._classify(el.tags);
      if (!kind) continue;

      ways.push({
        id:     el.id,
        kind,
        tags:   el.tags,
        coords,
        height: this._estimateHeight(el.tags),
        closed: el.nodes[0] === el.nodes[el.nodes.length - 1],
      });
    }

    return ways;
  }

  // ── Mercator flat projection (metres from centre) ─────────────
  _project(lat, lng, cLat, cLng) {
    const R    = 6378137;
    const dLat = (lat - cLat) * Math.PI / 180;
    const dLng = (lng - cLng) * Math.PI / 180;
    const x    = dLng * R * Math.cos(cLat * Math.PI / 180);
    const z    = -dLat * R;
    return { x, z };
  }

  // ── Feature classification ────────────────────────────────────
  _classify(tags) {
    if (tags.building)                                return 'building';
    if (tags.highway)                                 return 'road';
    if (tags.waterway || tags['natural'] === 'water') return 'water';
    if (tags.leisure === 'park')                      return 'park';
    if (tags.landuse === 'grass')                     return 'park';
    return null;
  }

  // ── Weather fetch (Open-Meteo, free, no API key) ─────────────
  // Returns { cloudCover: 0-100, weatherCode: WMO int,
  //           windSpeed: world-units/sec, windDirection: 0-359° }
  // Falls back to neutral values if the request fails.
  async fetchWeather(lat, lng) {
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
        `&current=cloud_cover,weather_code,wind_speed_10m,wind_direction_10m` +
        `&wind_speed_unit=ms` +
        `&forecast_days=1`;
      const res  = await fetch(url);
      if (!res.ok) throw new Error('weather fetch failed');
      const json = await res.json();
      const cur  = json.current || {};
      // wind_speed_10m arrives in m/s; scene uses world-units/sec where
      // 1 world-unit ≈ 1 metre, so the values map directly.
      // Cap at 80 to stay within the slider range.
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

  // ── Rough building height estimation ─────────────────────────
  _estimateHeight(tags) {
    if (tags.height)             return parseFloat(tags.height)             || 10;
    if (tags['building:levels']) return parseFloat(tags['building:levels']) * 3 || 10;
    const t = tags.building;
    if (t === 'yes' || !t)                   return 10;
    if (t === 'house')                       return 7;
    if (t === 'apartments')                  return 20;
    if (t === 'office')                      return 40;
    if (t === 'skyscraper')                  return 120;
    if (t === 'tower')                       return 60;
    if (t === 'cathedral' || t === 'church') return 25;
    if (t === 'industrial')                  return 12;
    return 10;
  }
}
