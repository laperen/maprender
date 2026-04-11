// js/mapFetcher.js — Fetches OSM vector data via Overpass API
// Geocoding via Photon (CORS-friendly, OSM-backed).

export class MapFetcher {
  constructor() {
    this.overpassUrl = 'https://overpass-api.de/api/interpreter';
    this.photonUrl   = 'https://photon.komoot.io/api/';
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
  async fetchArea(lat, lng, radiusMeters = 500, overpassUrl) {
    const endpoint = overpassUrl || this.overpassUrl;
    const r        = radiusMeters;
    const query    = `
[out:json][timeout:30];
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

    const res = await fetch(endpoint, {
      method:  'POST',
      body:    `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!res.ok) throw new Error(`Overpass error: ${res.status}`);
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
