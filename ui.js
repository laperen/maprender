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

    // Sun state
    this._sunMode      = 'time';   // 'time' | 'manual'
    this._sunHour      = 10;       // 0–24
    this._sunElevation = 45;       // degrees, manual mode
    this._sunAzimuth   = 135;      // degrees, manual mode
    this._liveClockInterval = null;
  }

  init() {
    this._bindElements();
    this._bindEvents();
    this.$heightVal.textContent = `${this.heightScale.toFixed(1)}×`;
    this.minimap.update(this.lng, this.lat, this.radius);

    // Apply default sun (time mode, hour = 10)
    this._applySun();
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

    // Sun controls
    this.$sunModeDeviceBtn  = document.getElementById('sun-mode-device');
    this.$sunModeTimeBtn    = document.getElementById('sun-mode-time');
    this.$sunModeManualBtn  = document.getElementById('sun-mode-manual');
    this.$sunTimeRow        = document.getElementById('sun-time-row');
    this.$sunManualRow      = document.getElementById('sun-manual-row');
    this.$sunTimeSlider     = document.getElementById('sun-time-slider');
    this.$sunTimeVal        = document.getElementById('sun-time-val');
    this.$sunElevSlider     = document.getElementById('sun-elev-slider');
    this.$sunElevVal        = document.getElementById('sun-elev-val');
    this.$sunAziSlider      = document.getElementById('sun-azi-slider');
    this.$sunAziVal         = document.getElementById('sun-azi-val');
    this.$sunDial           = document.getElementById('sun-dial');
    this.$sunDialHand       = document.getElementById('sun-dial-hand');
    this.$sunDialLabel      = document.getElementById('sun-dial-label');
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

    // ── Sun mode buttons ──────────────────────────────────────
    this.$sunModeDeviceBtn.addEventListener('click', () => {
      this._setSunMode('device');
    });
    this.$sunModeTimeBtn.addEventListener('click', () => {
      this._setSunMode('time');
    });
    this.$sunModeManualBtn.addEventListener('click', () => {
      this._setSunMode('manual');
    });

    // Time slider
    this.$sunTimeSlider.addEventListener('input', () => {
      this._sunHour = parseFloat(this.$sunTimeSlider.value);
      this._updateSunTimeLabel();
      this._applySun();
    });

    // Manual sliders
    this.$sunElevSlider.addEventListener('input', () => {
      this._sunElevation = parseInt(this.$sunElevSlider.value);
      this.$sunElevVal.textContent = `${this._sunElevation}°`;
      this._applySun();
    });

    this.$sunAziSlider.addEventListener('input', () => {
      this._sunAzimuth = parseInt(this.$sunAziSlider.value);
      this.$sunAziVal.textContent = `${this._sunAzimuth}°`;
      this._applySun();
    });
  }

  _setSunMode(mode) {
    this._sunMode = mode;

    // Update button states
    [this.$sunModeDeviceBtn, this.$sunModeTimeBtn, this.$sunModeManualBtn]
      .forEach(b => b.classList.remove('active'));

    if (mode === 'device') {
      this.$sunModeDeviceBtn.classList.add('active');
      this.$sunTimeRow.classList.add('hidden');
      this.$sunManualRow.classList.add('hidden');
      this._startLiveClock();
    } else if (mode === 'time') {
      this.$sunModeTimeBtn.classList.add('active');
      this.$sunTimeRow.classList.remove('hidden');
      this.$sunManualRow.classList.add('hidden');
      this._stopLiveClock();
    } else {
      this.$sunModeManualBtn.classList.add('active');
      this.$sunTimeRow.classList.add('hidden');
      this.$sunManualRow.classList.remove('hidden');
      this._stopLiveClock();
    }
    this._applySun();
  }

  _startLiveClock() {
    this._stopLiveClock();
    const tick = () => {
      const now = new Date();
      this._sunHour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
      this._applySun();
    };
    tick();
    this._liveClockInterval = setInterval(tick, 10000); // update every 10s
  }

  _stopLiveClock() {
    if (this._liveClockInterval) {
      clearInterval(this._liveClockInterval);
      this._liveClockInterval = null;
    }
  }

  _applySun() {
    let elev, azi;

    if (this._sunMode === 'manual') {
      elev = this._sunElevation;
      azi  = this._sunAzimuth;
      this.scene.setSunAngles(elev, azi);
    } else {
      // time or device — both use _sunHour
      const result = this.scene.setSunFromTime(this._sunHour);
      elev = result.elevationDeg;
      azi  = result.azimuthDeg;
    }

    this._updateSunDial(elev, azi);
  }

  _updateSunTimeLabel() {
    const h   = Math.floor(this._sunHour);
    const m   = Math.round((this._sunHour - h) * 60);
    const pad = n => String(n).padStart(2, '0');
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12  = h % 12 === 0 ? 12 : h % 12;
    this.$sunTimeVal.textContent = `${h12}:${pad(m)} ${ampm}`;
  }

  _updateSunDial(elevDeg, aziDeg) {
    // Draw sun position on the circular dial
    // Dial is a top-down compass. Azimuth 0=N at top, 90=E at right, etc.
    const aziRad = (aziDeg - 90) * Math.PI / 180; // offset so 0° = top
    const r      = 28; // radius in px
    const cx = 0, cy = 0;
    const x  = Math.cos(aziRad) * r;
    const y  = Math.sin(aziRad) * r;

    if (this.$sunDialHand) {
      this.$sunDialHand.setAttribute('x2', 32 + x);
      this.$sunDialHand.setAttribute('y2', 32 + y);
    }

    // Sun dot position
    const dot = document.getElementById('sun-dial-dot');
    if (dot) {
      dot.setAttribute('cx', 32 + x);
      dot.setAttribute('cy', 32 + y);
    }

    // Label: time or elevation
    if (this.$sunDialLabel) {
      if (this._sunMode === 'device' || this._sunMode === 'time') {
        const h   = Math.floor(this._sunHour);
        const m   = Math.round((this._sunHour - h) * 60);
        const pad = n => String(n).padStart(2, '0');
        const ampm = h < 12 ? 'AM' : 'PM';
        const h12  = h % 12 === 0 ? 12 : h % 12;
        this.$sunDialLabel.textContent = `${h12}:${pad(m)}${ampm}`;
      } else {
        this.$sunDialLabel.textContent =
          elevDeg <= 0 ? 'Night' : `${Math.round(elevDeg)}° elev`;
      }
    }

    // Colour the dial dot: warm yellow/orange above horizon, dark blue below
    if (dot) {
      dot.setAttribute('fill', elevDeg > 0 ? '#ffd060' : '#1a2260');
      dot.setAttribute('r', elevDeg > 30 ? 7 : 5);
    }
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

      // Re-apply sun after world rebuild
      this._applySun();

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
