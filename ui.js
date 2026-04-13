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
    this.timeOfDay   = 12;   // 0–24h float
    this._deviceTimeMode  = false;
    this._deviceTimerID   = null;
  }

  init() {
    this._bindElements();
    this._buildTimePanel();
    this._bindEvents();
    this.$heightVal.textContent = `${this.heightScale.toFixed(1)}×`;
    this.minimap.update(this.lng, this.lat, this.radius);
    this._applyTimeOfDay(this.timeOfDay);
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
  }

  // ── Build the time-of-day panel HTML ──────────────────────────
  _buildTimePanel() {
    if (!this.$timePanelHost) return;

    this.$timePanelHost.innerHTML = `
      <div class="tod-panel">

        <!-- Mode toggle row -->
        <div class="tod-mode-row">
          <button class="tod-mode-btn active" id="tod-manual-btn" title="Set time manually">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Manual
          </button>
          <button class="tod-mode-btn" id="tod-device-btn" title="Follow device clock">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01"/>
            </svg>
            Device Time
          </button>
        </div>

        <!-- Sky arc visualiser -->
        <div class="tod-arc-wrap">
          <canvas id="tod-arc" width="240" height="110"></canvas>
          <div class="tod-time-label" id="tod-time-label">☀ 12:00</div>
        </div>

        <!-- Manual slider (hidden in device mode) -->
        <div class="tod-slider-wrap" id="tod-slider-wrap">
          <div class="tod-tick-row">
            <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
          </div>
          <input type="range" id="tod-slider" min="0" max="24" step="0.25" value="12" />
        </div>

        <!-- Indicator pills -->
        <div class="tod-indicators" id="tod-indicators"></div>
      </div>
    `;

    this.$todArc         = document.getElementById('tod-arc');
    this.$todLabel       = document.getElementById('tod-time-label');
    this.$todSlider      = document.getElementById('tod-slider');
    this.$todSliderWrap  = document.getElementById('tod-slider-wrap');
    this.$todManualBtn   = document.getElementById('tod-manual-btn');
    this.$todDeviceBtn   = document.getElementById('tod-device-btn');
    this.$todIndicators  = document.getElementById('tod-indicators');

    this._drawArc(12);
    this._updateIndicators(12);
  }

  // ── Draw the arc sky preview canvas ──────────────────────────
  _drawArc(hour) {
    if (!this.$todArc) return;
    const canvas = this.$todArc;
    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Sky gradient based on time
    const skyColor = this._skyColor(hour);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, skyColor.top);
    grad.addColorStop(1, skyColor.bot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Horizon line
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, H - 18);
    ctx.lineTo(W, H - 18);
    ctx.stroke();

    // Arc track (faint)
    const cx = W / 2, cy = H - 18, r = 80;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.stroke();

    // Sun / Moon position on arc
    const daySunAngle  = this._sunAngle(hour);   // radians, 0 at left, PI at right
    const nightMoonAng = this._moonAngle(hour);

    // Normalised elevation (0 at horizon, 1 at zenith)
    const elevNorm = (hour - 6) / 12; // 0 at 6am, 1 at noon, 2 at 6pm
    const elevDeg  = Math.max(-20, 75 * Math.sin(elevNorm * Math.PI));
    const isDay    = elevDeg > -3;

    if (isDay) {
      // Sun disc
      const sx = cx + r * Math.cos(Math.PI + daySunAngle);
      const sy = cy - r * Math.sin(daySunAngle);
      const sunVisible = sy < cy;

      if (sunVisible) {
        // Glow
        const sunGlow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 22);
        sunGlow.addColorStop(0,   'rgba(255,220,100,0.55)');
        sunGlow.addColorStop(0.5, 'rgba(255,180,60,0.18)');
        sunGlow.addColorStop(1,   'rgba(255,140,30,0.0)');
        ctx.fillStyle = sunGlow;
        ctx.beginPath();
        ctx.arc(sx, sy, 22, 0, Math.PI * 2);
        ctx.fill();
        // Disc
        ctx.beginPath();
        ctx.arc(sx, sy, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#ffe090';
        ctx.fill();
      }
    }

    if (!isDay || this._nightPhaseForHour(hour) > 0.1) {
      // Moon
      const mx = cx + r * Math.cos(Math.PI + nightMoonAng);
      const my = cy - r * Math.sin(nightMoonAng);
      const moonVisible = my < cy;
      if (moonVisible) {
        const alpha = this._nightPhaseForHour(hour);
        ctx.beginPath();
        ctx.arc(mx, my, 6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200,220,255,${alpha * 0.9})`;
        ctx.fill();
      }
    }

    // Stars (dots) at night
    const np = this._nightPhaseForHour(hour);
    if (np > 0.05) {
      ctx.fillStyle = `rgba(255,255,255,${np * 0.7})`;
      const starPositions = [
        [30, 20], [80, 10], [130, 30], [170, 8], [210, 25],
        [55, 50], [150, 55], [200, 45], [25, 60], [195, 70],
      ];
      for (const [sx, sy] of starPositions) {
        if (sy < H - 22) {
          ctx.beginPath();
          ctx.arc(sx, sy, 0.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Ground strip
    const groundGrad = ctx.createLinearGradient(0, H - 18, 0, H);
    groundGrad.addColorStop(0, skyColor.ground);
    groundGrad.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, H - 18, W, 18);

    // Lamp glow in ground strip at night
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

  _sunAngle(hour) {
    const t = THREE_MathUtils_clamp((hour - 6) / 12, 0, 2);
    return t * Math.PI * 0.5 + (t > 1 ? (t - 1) * Math.PI * 0.5 : 0);
    // Simpler: just map 6h→0, 12h→PI/2, 18h→PI
    // return THREE_MathUtils_clamp((hour - 6) / 12, 0, 2) / 2 * Math.PI;
  }

  _moonAngle(hour) {
    // Moon visible from 18h to 6h — travel opposite arc
    const t = ((hour + 6) % 24) / 12;
    return THREE_MathUtils_clamp(t, 0, 2) / 2 * Math.PI;
  }

  _nightPhaseForHour(hour) {
    const elevNorm = (hour - 6) / 12;
    const elevDeg  = Math.max(-20, 75 * Math.sin(elevNorm * Math.PI));
    const dayPhase = smoothstep(elevDeg / 75, -0.05, 0.18);
    return 1 - dayPhase;
  }

  _skyColor(hour) {
    // Presets: midnight, dawn, morning, noon, afternoon, dusk, night
    const np = this._nightPhaseForHour(hour);
    const elevNorm = (hour - 6) / 12;
    const elevDeg  = Math.max(-20, 75 * Math.sin(elevNorm * Math.PI));
    const isGolden = elevDeg >= 0 && elevDeg <= 18;

    if (np > 0.9) return { top: '#020510', bot: '#060a1c', ground: 'rgba(15,20,40,0.9)' };
    if (np > 0.5) return { top: '#0a1535', bot: '#152040', ground: 'rgba(20,30,55,0.9)' };
    if (isGolden && hour <= 9)  return { top: '#1a2a6c', bot: '#e05f10', ground: 'rgba(60,30,10,0.9)' };
    if (isGolden && hour >= 16) return { top: '#1a2a6c', bot: '#c04010', ground: 'rgba(50,25,10,0.9)' };
    return { top: '#1565c0', bot: '#42a5f5', ground: 'rgba(50,90,60,0.9)' };
  }

  // ── Indicator pills (sun/moon/lamps) ─────────────────────────
  _updateIndicators(hour) {
    if (!this.$todIndicators) return;
    const np = this._nightPhaseForHour(hour);
    const lampOn = np > 0.25;
    const elevNorm = (hour - 6) / 12;
    const elevDeg  = Math.max(-20, 75 * Math.sin(elevNorm * Math.PI));
    const sunActive = elevDeg > 0;

    const pill = (icon, label, active, color) =>
      `<div class="tod-pill ${active ? 'active' : ''}" style="--pill-color:${color}">
        <span>${icon}</span><span>${label}</span>
      </div>`;

    this.$todIndicators.innerHTML =
      pill('☀', 'Sun',   sunActive,      '#ffd060') +
      pill('☽', 'Moon',  np > 0.15,      '#c8d8ff') +
      pill('★', 'Stars', np > 0.3,       '#aac8ff') +
      pill('◎', 'Lamps', lampOn,         '#ffa040');
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
      document.getElementById('radius-val').textContent = `${this.radius}m`;
      this._updateMinimap();
    });

    this.$heightSlider.addEventListener('input', () => {
      this.heightScale = parseInt(this.$heightSlider.value) / 2;
      this.$heightVal.textContent = `${this.heightScale.toFixed(1)}×`;
    });

    // Manual time slider
    if (this.$todSlider) {
      this.$todSlider.addEventListener('input', () => {
        if (this._deviceTimeMode) return;
        this.timeOfDay = parseFloat(this.$todSlider.value);
        this._applyTimeOfDay(this.timeOfDay);
      });
    }

    // Mode buttons
    if (this.$todManualBtn) {
      this.$todManualBtn.addEventListener('click', () => this._setDeviceMode(false));
    }
    if (this.$todDeviceBtn) {
      this.$todDeviceBtn.addEventListener('click', () => this._setDeviceMode(true));
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
    this.$canvas.addEventListener('mousemove', e => this._onMouseMove(e));
    this.$canvas.addEventListener('mouseleave', () => this.$tooltip.classList.add('hidden'));
  }

  // ── Device time mode ──────────────────────────────────────────
  _setDeviceMode(on) {
    this._deviceTimeMode = on;

    if (this.$todManualBtn) this.$todManualBtn.classList.toggle('active', !on);
    if (this.$todDeviceBtn) this.$todDeviceBtn.classList.toggle('active', on);
    if (this.$todSliderWrap) {
      this.$todSliderWrap.style.opacity     = on ? '0.35' : '1';
      this.$todSliderWrap.style.pointerEvents = on ? 'none' : '';
    }

    if (on) {
      this._syncDeviceTime();
      // Refresh every 30 seconds
      this._deviceTimerID = setInterval(() => this._syncDeviceTime(), 30000);
    } else {
      if (this._deviceTimerID) { clearInterval(this._deviceTimerID); this._deviceTimerID = null; }
    }
  }

  _syncDeviceTime() {
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
    this.timeOfDay = hour;
    if (this.$todSlider) this.$todSlider.value = hour;
    this._applyTimeOfDay(hour);
  }

  // ── Apply time: drives scene + updates UI ─────────────────────
  _applyTimeOfDay(hour) {
    this.scene.setTimeOfDay(hour);

    // Arc canvas
    this._drawArc(hour);
    this._updateIndicators(hour);

    // Label
    const h  = Math.floor(hour) % 24;
    const m  = Math.round((hour % 1) * 60);
    const hh = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const np = this._nightPhaseForHour(hour);
    const icon = np > 0.5 ? '☽' : '☀';
    if (this.$todLabel) this.$todLabel.textContent = `${icon} ${hh}:${mm}`;
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

      const result = await this.builder.build(ways, this.heightScale, this.lat, this.lng, this.radius);

      this.scene.setRenderMode(this.renderMode);
      this.scene.flyTo(0, 0, this.radius);
      this._applyTimeOfDay(this.timeOfDay);

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
          attempt === 0 ? 'Fetching map data…' : `Retrying (attempt ${attempt + 1} of ${maxAttempts})…`,
          'active loading'
        );
        return await this.fetcher.fetchArea(lat, lng, radius, mirror);
      } catch (err) {
        lastError = err;
        if (!err.message.includes('504') && !err.message.includes('429') && !err.message.includes('Overpass error')) throw err;
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
      this.$tooltip.innerHTML  = html;
      this.$tooltip.style.left = `${e.clientX + 14}px`;
      this.$tooltip.style.top  = `${e.clientY + 14}px`;
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

// ── Local math helpers (no THREE import needed here) ──────────
function THREE_MathUtils_clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function smoothstep(x, lo, hi) {
  const t = THREE_MathUtils_clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}
