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

    // Cloud state
    this._cloudAutoMode  = true;   // true = use weather API, false = manual
    this._cloudCover     = 40;     // 0–100 %
    this._cloudCondition = 1;      // WMO-style: 0=clear,1=partly,2=mostly,3=overcast,4=rain,5=storm
    this._windSpeed      = 18;     // world-units/sec
    this._windAngleDeg   = 13;     // degrees (0=east, CCW)
    this._cloudAltitude  = 380;    // metres
  }

  init() {
    this._bindElements();
    this._buildTimePanel();
    this._buildCloudPanel();
    this._bindEvents();
    this.$heightVal.textContent = `${this.heightScale.toFixed(1)}×`;
    this.minimap.update(this.lng, this.lat, this.radius);
    this._applyTimeOfDay(this.timeOfDay);
    this._applyCloudProperties();
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

  // ── Build the cloud panel HTML ────────────────────────────────
  _buildCloudPanel() {
    if (!this.$cloudPanelHost) return;

    this.$cloudPanelHost.innerHTML = `
      <div class="tod-panel">

        <!-- Mode toggle row -->
        <div class="tod-mode-row">
          <button class="tod-mode-btn" id="cloud-manual-btn" title="Set clouds manually">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Manual
          </button>
          <button class="tod-mode-btn active" id="cloud-auto-btn" title="Use live weather data">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M12 2a7 7 0 0 1 7 7c0 3.5-2 6-5 7H8c-3 0-5-2-5-5a5 5 0 0 1 5-5 7 7 0 0 1 7-4z"/>
            </svg>
            Live Weather
          </button>
        </div>

        <!-- Cloud preview canvas -->
        <div class="tod-arc-wrap">
          <canvas id="cloud-arc" width="240" height="80"></canvas>
          <div class="tod-time-label" id="cloud-label">⛅ 40% cover</div>
        </div>

        <!-- Manual controls (disabled in auto mode) -->
        <div class="tod-slider-wrap" id="cloud-manual-wrap" style="opacity:0.35;pointer-events:none;">

          <label style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:2px;display:block;">Condition</label>
          <select id="cloud-condition-select" style="margin-bottom:8px;">
            <option value="0">☀ Clear</option>
            <option value="1" selected>⛅ Partly Cloudy</option>
            <option value="2">🌥 Mostly Cloudy</option>
            <option value="3">☁ Overcast</option>
            <option value="4">🌧 Rain</option>
            <option value="5">⛈ Storm</option>
          </select>

          <label style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:2px;display:block;">
            Cloud Cover <span id="cloud-cover-val">40%</span>
          </label>
          <input type="range" id="cloud-cover-slider" min="0" max="100" step="5" value="40" style="margin-bottom:8px;" />

          <label style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:2px;display:block;">
            Wind Speed <span id="cloud-wind-speed-val">18 u/s</span>
          </label>
          <input type="range" id="cloud-wind-speed-slider" min="0" max="80" step="2" value="18" style="margin-bottom:8px;" />

          <label style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:2px;display:block;">
            Wind Direction <span id="cloud-wind-angle-val">13°</span>
          </label>
          <input type="range" id="cloud-wind-angle-slider" min="0" max="359" step="1" value="13" style="margin-bottom:8px;" />

          <label style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:2px;display:block;">
            Altitude <span id="cloud-altitude-val">380m</span>
          </label>
          <input type="range" id="cloud-altitude-slider" min="100" max="1000" step="20" value="380" />

        </div>

        <!-- Cloud indicator pills -->
        <div class="tod-indicators" id="cloud-indicators"></div>
      </div>
    `;

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

  // ── Draw cloud preview canvas ─────────────────────────────────
  _drawCloudPreview() {
    if (!this.$cloudArc) return;
    const canvas = this.$cloudArc;
    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const cover = this._cloudCover / 100;
    const cond  = this._cloudCondition;

    // Sky gradient
    let skyTop, skyBot;
    if (cond === 5) { skyTop = '#1a1520'; skyBot = '#2a2030'; }
    else if (cond === 4) { skyTop = '#2a3040'; skyBot = '#404858'; }
    else if (cond === 3) { skyTop = '#505860'; skyBot = '#707880'; }
    else { skyTop = '#1565c0'; skyBot = '#42a5f5'; }

    const grad = ctx.createLinearGradient(0, 0, 0, H - 12);
    grad.addColorStop(0, skyTop);
    grad.addColorStop(1, skyBot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H - 12);

    // Cloud puffs — scale count and opacity with cover
    const cloudCount = Math.round(cover * 8);
    const cloudAlpha = 0.25 + cover * 0.65;
    let cloudColor;
    if (cond === 5) cloudColor = `rgba(80,80,90,${cloudAlpha})`;
    else if (cond === 4) cloudColor = `rgba(110,120,130,${cloudAlpha})`;
    else if (cond >= 2) cloudColor = `rgba(180,185,195,${cloudAlpha})`;
    else cloudColor = `rgba(230,235,245,${cloudAlpha})`;

    // Stable cloud positions seeded by index
    const clouds = [
      { x: 0.10, y: 0.25, r: 22 }, { x: 0.28, y: 0.18, r: 28 },
      { x: 0.48, y: 0.28, r: 20 }, { x: 0.65, y: 0.15, r: 32 },
      { x: 0.80, y: 0.30, r: 18 }, { x: 0.92, y: 0.20, r: 24 },
      { x: 0.38, y: 0.48, r: 22 }, { x: 0.72, y: 0.45, r: 26 },
    ];

    for (let i = 0; i < cloudCount; i++) {
      const c  = clouds[i % clouds.length];
      const cx = c.x * W, cy = c.y * (H - 16);
      const r  = c.r;
      const cg = ctx.createRadialGradient(cx, cy - r * 0.2, 0, cx, cy, r * 1.4);
      cg.addColorStop(0,   cloudColor);
      cg.addColorStop(0.6, cloudColor);
      cg.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 1.5, r * 0.8, 0, 0, Math.PI * 2);
      ctx.fillStyle = cg;
      ctx.fill();
    }

    // Wind arrow in top-right
    if (this._windSpeed > 0) {
      const arrowAlpha = Math.min(1, this._windSpeed / 40);
      const angleDeg   = this._windAngleDeg;
      const angleRad   = angleDeg * Math.PI / 180;
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

    // Ground strip
    const groundGrad = ctx.createLinearGradient(0, H - 12, 0, H);
    groundGrad.addColorStop(0, 'rgba(50,80,50,0.9)');
    groundGrad.addColorStop(1, 'rgba(20,40,20,0.9)');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, H - 12, W, 12);

    // Rain streaks
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

    // Lightning for storm
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

  // ── Cloud pills ───────────────────────────────────────────────
  _updateCloudPills() {
    if (!this.$cloudIndicators) return;
    const cover = this._cloudCover;
    const cond  = this._cloudCondition;
    const speed = this._windSpeed;

    const labels = ['Clear', 'Partly', 'Mostly', 'Overcast', 'Rain', 'Storm'];
    const icons  = ['☀', '⛅', '🌥', '☁', '🌧', '⛈'];
    const condColors = ['#ffd060', '#c8d8ff', '#a0a8b8', '#8090a0', '#4888c0', '#a060d0'];

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

  // ── Apply cloud properties to scene ──────────────────────────
  _applyCloudProperties() {
    // Always apply physics properties (wind, altitude) regardless of auto/manual
    this.scene.setCloudProperties({
      windSpeed:    this._windSpeed,
      windAngleDeg: this._windAngleDeg,
      altitude:     this._cloudAltitude,
    });

    // Apply weather (cover + condition) only in manual mode
    // (auto mode sets these from the API in _generate)
    if (!this._cloudAutoMode) {
      // Map our simple condition index to WMO-style code for setWeather
      const wmoCode = [0, 2, 3, 45, 61, 95][this._cloudCondition] ?? 1;
      this.scene.setWeather(this._cloudCover, wmoCode);
    }

    // Redraw preview and update label
    this._drawCloudPreview();
    this._updateCloudPills();

    const condEmoji = ['☀', '⛅', '🌥', '☁', '🌧', '⛈'][this._cloudCondition];
    if (this.$cloudLabel) {
      this.$cloudLabel.textContent = `${condEmoji} ${this._cloudCover}% cover`;
    }
  }

  // ── Cloud auto / manual mode ──────────────────────────────────
  _setCloudAutoMode(auto) {
    this._cloudAutoMode = auto;
    if (this.$cloudAutoBtn)   this.$cloudAutoBtn.classList.toggle('active', auto);
    if (this.$cloudManualBtn) this.$cloudManualBtn.classList.toggle('active', !auto);
    if (this.$cloudManualWrap) {
      this.$cloudManualWrap.style.opacity      = auto ? '0.35' : '1';
      this.$cloudManualWrap.style.pointerEvents = auto ? 'none' : '';
    }
    if (!auto) {
      // Immediately apply current manual values
      this._applyCloudProperties();
    }
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
    const daySunAngle  = this._sunAngle(hour);
    const nightMoonAng = this._moonAngle(hour);

    const elevNorm = (hour - 6) / 12;
    const elevDeg  = Math.max(-20, 75 * Math.sin(elevNorm * Math.PI));
    const isDay    = elevDeg > -3;

    if (isDay) {
      const sx = cx + r * Math.cos(Math.PI + daySunAngle);
      const sy = cy - r * Math.sin(daySunAngle);
      const sunVisible = sy < cy;

      if (sunVisible) {
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
    }

    if (!isDay || this._nightPhaseForHour(hour) > 0.1) {
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
  }

  _moonAngle(hour) {
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

    // Time mode buttons
    if (this.$todManualBtn) {
      this.$todManualBtn.addEventListener('click', () => this._setDeviceMode(false));
    }
    if (this.$todDeviceBtn) {
      this.$todDeviceBtn.addEventListener('click', () => this._setDeviceMode(true));
    }

    // ── Cloud panel events ────────────────────────────────────
    if (this.$cloudManualBtn) {
      this.$cloudManualBtn.addEventListener('click', () => this._setCloudAutoMode(false));
    }
    if (this.$cloudAutoBtn) {
      this.$cloudAutoBtn.addEventListener('click', () => this._setCloudAutoMode(true));
    }

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

    // Render mode buttons
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
    this._drawArc(hour);
    this._updateIndicators(hour);

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
      // In auto mode, fetch weather from API; in manual mode skip weather fetch
      let weatherPromise;
      if (this._cloudAutoMode) {
        weatherPromise = this.fetcher.fetchWeather(this.lat, this.lng);
      } else {
        // Resolve immediately with current manual values
        const wmoCode = [0, 2, 3, 45, 61, 95][this._cloudCondition] ?? 1;
        weatherPromise = Promise.resolve({
          cloudCover:  this._cloudCover,
          weatherCode: wmoCode,
        });
      }

      const [ways, weather] = await Promise.all([
        this._fetchWithRetry(this.lat, this.lng, this.radius),
        weatherPromise,
      ]);

      if (!ways.length) throw new Error('No map features found in this area.');

      // Apply weather (cover + condition)
      this.scene.setWeather(weather.cloudCover, weather.weatherCode);

      // If in auto mode, sync UI sliders to reflect fetched weather
      if (this._cloudAutoMode) {
        this._cloudCover     = weather.cloudCover;
        // Map WMO code back to our condition index for display
        const wmo = weather.weatherCode;
        this._cloudCondition = wmo >= 95 ? 5 : wmo >= 61 ? 4 : wmo >= 45 ? 3 : wmo >= 3 ? 2 : wmo >= 1 ? 1 : 0;
        if (this.$cloudCoverSlider) this.$cloudCoverSlider.value = this._cloudCover;
        if (this.$cloudCoverVal)    this.$cloudCoverVal.textContent = `${this._cloudCover}%`;
        if (this.$cloudCondSelect)  this.$cloudCondSelect.value = String(this._cloudCondition);
      }

      // Always apply physics properties (wind, altitude)
      this._applyCloudProperties();

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

      const cloudDesc = this._cloudCover < 20 ? 'clear skies' :
                        this._cloudCover < 50 ? 'partly cloudy' :
                        this._cloudCover < 80 ? 'mostly cloudy' : 'overcast';
      const modeTag = this._cloudAutoMode ? 'live weather' : 'manual';
      this._setStatus(`World ready — ${cloudDesc} (${this._cloudCover}% · ${modeTag}). Satellite imagery loading…`, '');
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
