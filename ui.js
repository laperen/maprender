// js/ui.js — DOM event wiring, status messages, tooltip
export class UIController {
  constructor({ scene, fetcher, builder, minimap }) {
    this.scene   = scene;
    this.fetcher = fetcher;
    this.builder = builder;
    this.minimap = minimap;

    this.lat         = 35.6812;
    this.lng         = 139.7671;
    this.radius      = 500;
    this.heightScale = 1;
    this.renderMode  = 'solid';
  }

  init() {
    this._bindElements();
    this._bindEvents();
    this.$heightVal.textContent = `${this.heightScale.toFixed(1)}×`;
    this.minimap.update(this.lng, this.lat, this.radius);
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
  }

  _bindEvents() {
    this.$searchBtn.addEventListener('click', () => this._geocode());
    this.$locationInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._geocode();
    });

    this.$latInput.addEventListener('change', () => {
      this.lat = parseFloat(this.$latInput.value) || this.lat;
      this._updateMinimap();
    });
    this.$lngInput.addEventListener('change', () => {
      this.lng = parseFloat(this.$lngInput.value) || this.lng;
      this._updateMinimap();
    });

    this.$radiusSlider.addEventListener('input', () => {
      this.radius = parseInt(this.$radiusSlider.value);
      this.$radiusVal.textContent = `${this.radius}m`;
      this._updateMinimap();
    });

    this.$heightSlider.addEventListener('input', () => {
      this.heightScale = parseInt(this.$heightSlider.value) / 2;
      this.$heightVal.textContent = `${this.heightScale.toFixed(1)}×`;
    });

    this.$modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.$modeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderMode = btn.dataset.mode;
        this.scene.setRenderMode(this.renderMode);
      });
    });

    this.$generateBtn.addEventListener('click', () => this._generate());

    this.$canvas.addEventListener('mousemove', e => this._onMouseMove(e));
    this.$canvas.addEventListener('mouseleave', () => {
      this.$tooltip.classList.add('hidden');
    });
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
      this._setStatus(`📍 ${result.display.split(',').slice(0, 2).join(',')}`, '');
      this._updateMinimap();
    } catch (err) {
      this._setStatus(`Geocoding failed: ${err.message}`, 'error');
    }
  }

  async _generate() {
    this.$generateBtn.disabled = true;
    this.$stats.classList.add('hidden');

    this.scene.clearWorld();
    this._setStatus('Fetching map data…', 'active loading');

    try {
      const ways = await this._fetchWithRetry(this.lat, this.lng, this.radius);
      if (!ways.length) throw new Error('No map features found in this area.');

      this._setStatus('Fetching elevation data and building world…', 'active loading');
      await this._nextFrame();

      const result = await this.builder.build(
        ways,
        this.heightScale,
        this.lat,
        this.lng,
        this.radius,
      );

      this.scene.setRenderMode(this.renderMode);
      this.scene.flyTo(0, 0, this.radius);

      this.$statBuildings.textContent = `${result.buildings} buildings`;
      this.$statRoads.textContent     = `${result.roads} road segments`;
      this.$statTris.textContent      = `${Math.round(result.triangleCount).toLocaleString()} triangles`;
      this.$stats.classList.remove('hidden');

      this._setStatus('World ready. Satellite imagery loading…', '');
      setTimeout(() => {
        if (this.$status.textContent.includes('Satellite')) {
          this._setStatus('Drag to orbit · Scroll to zoom · Hover to inspect', '');
        }
      }, 6000);

    } catch (err) {
      this._setStatus(`Error: ${err.message}`, 'error');
      console.error(err);
    } finally {
      this.$generateBtn.disabled = false;
    }
  }

  async _fetchWithRetry(lat, lng, radius, maxAttempts = 3) {
    const MIRRORS = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ];
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const mirror = MIRRORS[attempt % MIRRORS.length];
      try {
        this._setStatus(
          attempt === 0
            ? 'Fetching map data…'
            : `Retrying (attempt ${attempt + 1} of ${maxAttempts})…`,
          'active loading'
        );
        return await this.fetcher.fetchArea(lat, lng, radius, mirror);
      } catch (err) {
        lastError = err;
        if (!err.message.includes('504') &&
            !err.message.includes('429') &&
            !err.message.includes('Overpass error')) throw err;
        await this._sleep(1500 * (attempt + 1));
      }
    }
    throw lastError;
  }

  _onMouseMove(e) {
    const hit = this.scene.pick(e.clientX, e.clientY);
    if (hit && hit.object.userData.kind) {
      const d = hit.object.userData;
      let html = `<strong>${d.kind.toUpperCase()}</strong>`;
      if (d.tags) {
        if (d.tags.name)     html += `<br>${d.tags.name}`;
        if (d.tags.building) html += `<br>Type: ${d.tags.building}`;
        if (d.height)        html += `<br>Height: ${d.height.toFixed(0)}m`;
        if (d.tags.highway)  html += `<br>Road: ${d.tags.highway}`;
      }
      this.$tooltip.innerHTML     = html;
      this.$tooltip.style.left    = `${e.clientX + 14}px`;
      this.$tooltip.style.top     = `${e.clientY + 14}px`;
      this.$tooltip.classList.remove('hidden');
    } else {
      this.$tooltip.classList.add('hidden');
    }
  }

  _setStatus(msg, cls) {
    this.$status.textContent = msg;
    this.$status.className   = cls || '';
  }

  _updateMinimap() {
    this.minimap.update(this.lng, this.lat, this.radius, this.$styleSelect.value);
  }

  _nextFrame() { return new Promise(r => requestAnimationFrame(r)); }
  _sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }
}
