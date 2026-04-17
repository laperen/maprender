// jukebox.js — Self-contained Jukebox class.
// Works both as a standalone page (jukebox.html) and embedded inside the
// overlay panel of index.html.  All DOM queries are scoped to the root
// element passed to init(), so multiple instances never clash.

export class Jukebox {
  constructor() {
    // ── Audio engine state ───────────────────────────────────
    this._audioA       = new Audio();
    this._audioB       = new Audio();
    this._currentAudio = this._audioA;
    this._activePlayer = null;

    this._scWidget = null;
    this._scIframe = null;

    this._isPlaying      = false;
    this._isTransitioning = false;
    this._playbackToken  = 0;

    this._categories = { day: [], night: [], win: [], lose: [] };
    this._currentCategory = 'day';
    this._currentIndex    = 0;
    this._currentVolume   = 0.5;

    // ── DOM refs (set in init) ───────────────────────────────
    this._root = null;   // scoped root element
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Attach the jukebox to a container element.
   * Renders the jukebox HTML inside that container, then wires events.
   * Safe to call multiple times (idempotent — re-uses existing markup).
   */
  init(container) {
    if (!container) return;

    // Render markup if not already present
    if (!container.querySelector('.jukebox-root')) {
      container.innerHTML = this._template();
    }

    this._root = container.querySelector('.jukebox-root');
    this._cacheDOM();
    this._bindEvents();
    this._loadFromStorage();
    this._updateAudioList();
    this._upgradeLis();

    // Restore volume slider
    if (this._$volSlider) this._$volSlider.value = Math.round(this._currentVolume * 100);
  }

  // ── HTML template ────────────────────────────────────────────

  _template() {
    return /* html */`
<div class="jukebox-root">
  <!-- hidden SoundCloud iframe injected dynamically -->

  <!-- Category tabs -->
  <div class="jk-tabs">
    <button class="jk-cat active" data-cat="day">Day</button>
    <button class="jk-cat" data-cat="night">Night</button>
    <button class="jk-cat" data-cat="win">Win</button>
    <button class="jk-cat" data-cat="lose">Lose</button>
  </div>

  <!-- Add track -->
  <div class="jk-add-row">
    <input class="jk-url-input" type="text" placeholder="SoundCloud, Audius, or .mp3 link" />
    <button class="jk-add-btn">Add</button>
  </div>

  <!-- Playback controls -->
  <div class="jk-playback">
    <button class="jk-play-btn jk-btn-play"  title="Play">▶</button>
    <button class="jk-play-btn jk-btn-pause" title="Pause">⏸</button>
    <button class="jk-play-btn jk-btn-next"  title="Next">⏭</button>
    <div class="jk-vol-row">
      <label>Vol</label>
      <input class="jk-vol-slider" type="range" min="0" max="100" value="50" />
    </div>
  </div>

  <!-- List header -->
  <div class="jk-list-header">
    <label>Playlist</label>
    <span class="jk-track-count">0 tracks</span>
  </div>

  <!-- Track list -->
  <div class="jk-list-scroll">
    <ul class="jk-audiolist"></ul>
    <div class="jk-empty-state">
      <span class="empty-icon">♪</span>
      No tracks yet.<br>Paste a link above and hit Add.
    </div>
  </div>

  <!-- Now playing footer -->
  <div class="jk-now-playing">
    <div class="jk-np-dot"></div>
    <span class="jk-np-label">Nothing playing</span>
  </div>
</div>`;
  }

  // ── DOM cache ────────────────────────────────────────────────

  _cacheDOM() {
    const q  = sel => this._root.querySelector(sel);
    const qa = sel => this._root.querySelectorAll(sel);

    this._$catBtns    = qa('.jk-cat');
    this._$urlInput   = q('.jk-url-input');
    this._$addBtn     = q('.jk-add-btn');
    this._$playBtn    = q('.jk-btn-play');
    this._$pauseBtn   = q('.jk-btn-pause');
    this._$nextBtn    = q('.jk-btn-next');
    this._$volSlider  = q('.jk-vol-slider');
    this._$audiolist  = q('.jk-audiolist');
    this._$trackCount = q('.jk-track-count');
    this._$emptyState = q('.jk-empty-state');
    this._$npDot      = q('.jk-np-dot');
    this._$npLabel    = q('.jk-np-label');
  }

  // ── Events ───────────────────────────────────────────────────

  _bindEvents() {
    // Category tabs
    this._$catBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this._$catBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._setCategory(btn.dataset.cat);
      });
    });

    // Add track
    this._$addBtn.addEventListener('click', () => this._handleAdd());
    this._$urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._handleAdd();
    });

    // Playback
    this._$playBtn.addEventListener('click',  () => {
      this._play();
      this._setPlaying(true, this._currentUrl());
    });
    this._$pauseBtn.addEventListener('click', () => {
      this._pause();
      this._setPlaying(false, '');
    });
    this._$nextBtn.addEventListener('click',  () => {
      this._next();
      setTimeout(() => this._setPlaying(true, this._currentUrl()), 80);
    });

    // Volume
    this._$volSlider.addEventListener('change', () => {
      this._setVolume(this._$volSlider.value);
    });

    // Track list mutations — re-upgrade new <li>s
    const observer = new MutationObserver(() => this._upgradeLis());
    observer.observe(this._$audiolist, { childList: true });
  }

  _handleAdd() {
    const val = this._$urlInput.value.trim();
    if (!val) return;
    this._addTrack(val);
    this._$urlInput.value = '';
  }

  // ── Storage ──────────────────────────────────────────────────

  _saveToStorage() {
    localStorage.setItem('jukebox_playlists', JSON.stringify({
      categories:    this._categories,
      volume:        this._currentVolume,
      category:      this._currentCategory,
    }));
  }

  _loadFromStorage() {
    try {
      const saved = localStorage.getItem('jukebox_playlists');
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (parsed.categories) Object.assign(this._categories, parsed.categories);
      if (parsed.volume !== undefined) this._currentVolume = parsed.volume;
      if (parsed.category) this._currentCategory = parsed.category;
    } catch (_) {}
  }

  // ── Category ─────────────────────────────────────────────────

  _setCategory(cat) {
    this._currentCategory = cat;
    this._currentIndex    = 0;
    this._updateAudioList();
    this._saveToStorage();
  }

  // ── Track list UI ────────────────────────────────────────────

  _updateAudioList() {
    const list = this._categories[this._currentCategory];
    this._$audiolist.innerHTML = '';

    list.forEach((entry, index) => {
      const li = document.createElement('li');
      li.draggable = true;
      li.innerHTML = `<span>${entry.url}</span><button>X</button>`;

      li.querySelector('button').addEventListener('click', () => {
        list.splice(index, 1);
        this._saveToStorage();
        this._updateAudioList();
      });

      li.addEventListener('dragstart', e => e.dataTransfer.setData('i', index));
      li.addEventListener('dragover',  e => e.preventDefault());
      li.addEventListener('drop',      e => {
        const from  = +e.dataTransfer.getData('i');
        const moved = list.splice(from, 1)[0];
        list.splice(index, 0, moved);
        this._saveToStorage();
        this._updateAudioList();
      });

      this._$audiolist.appendChild(li);
    });
  }

  // ── Track source detection ───────────────────────────────────

  _detectSource(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('soundcloud.com')) return 'soundcloud';
      if (u.hostname.includes('audius.co'))      return 'audius';
      if (url.match(/\.(mp3|wav|ogg)$/i))        return 'audio';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  _addTrack(rawUrl) {
    if (rawUrl.includes('archive.org/details/')) {
      rawUrl = rawUrl.replace('details', 'download').replace(/\+/g, '%20');
    }
    const type = this._detectSource(rawUrl);
    this._categories[this._currentCategory].push({ url: rawUrl, type });
    this._saveToStorage();
    this._updateAudioList();
  }

  // ── Player factory ───────────────────────────────────────────

  _createAudioPlayer(url) {
    const el = this._currentAudio === this._audioA ? this._audioB : this._audioA;
    this._currentAudio = el;
    el.src    = url;
    el.volume = this._currentVolume;
    return {
      play:      () => el.play(),
      pause:     () => el.pause(),
      setVolume: v  => { el.volume = this._clamp(v); },
      onEnd:     cb => {
        el.onended = null;
        el.addEventListener('ended', cb, { once: true });
      },
    };
  }

  _createSoundCloudPlayer(url) {
    // Remove old iframe if any
    if (this._scIframe) this._scIframe.remove();

    this._scIframe = document.createElement('iframe');
    this._scIframe.style.cssText = 'width:0;height:0;opacity:0;position:absolute;';
    this._scIframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}`;
    document.body.appendChild(this._scIframe);

    // SC.Widget is loaded via the script tag injected by _ensureSCApi
    const widget = window.SC.Widget(this._scIframe);
    this._scWidget = widget;

    return {
      play:      () => widget.play(),
      pause:     () => widget.pause(),
      setVolume: v  => widget.setVolume(this._clamp(v) * 100),
      onEnd: cb => {
        let called = false;
        const safe = () => { if (called) return; called = true; cb(); };
        widget.bind(window.SC.Widget.Events.READY, () => {
          widget.play();
          widget.setVolume(this._currentVolume * 100);
          widget.getDuration(d => setTimeout(safe, d));
          widget.bind(window.SC.Widget.Events.FINISH, safe);
        });
      },
    };
  }

  async _createAudiusPlayer(url) {
    const res  = await fetch(`https://discoveryprovider.audius.co/v1/resolve?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    const stream = `https://discoveryprovider.audius.co/v1/tracks/${data.data.id}/stream`;
    return this._createAudioPlayer(stream);
  }

  async _createPlayer(track) {
    switch (track.type) {
      case 'audio':      return this._createAudioPlayer(track.url);
      case 'soundcloud': return this._createSoundCloudPlayer(track.url);
      case 'audius':     return await this._createAudiusPlayer(track.url);
      default:           return this._createAudioPlayer(track.url);
    }
  }

  // ── Ensure SoundCloud API script is loaded ───────────────────

  _ensureSCApi() {
    return new Promise(resolve => {
      if (window.SC) { resolve(); return; }
      const s  = document.createElement('script');
      s.src    = 'https://w.soundcloud.com/player/api.js';
      s.onload = resolve;
      document.head.appendChild(s);
    });
  }

  // ── Crossfade ────────────────────────────────────────────────

  _crossfade(oldP, newP, url) {
    let v = 0;
    newP.setVolume(0);
    newP.play();
    const interval = setInterval(() => {
      v += 0.05;
      oldP?.setVolume(this._clamp(1 - v) * this._currentVolume);
      newP.setVolume(this._clamp(v) * this._currentVolume);
      if (v >= 1) {
        clearInterval(interval);
        oldP?.pause();
      }
      this._setPlaying(true, url);
    }, 40);
  }

  // ── Playback ─────────────────────────────────────────────────

  async _loadTrack(track) {
    if (this._isTransitioning) return;
    this._isTransitioning = true;

    // Ensure SC API is available before trying to create a SC player
    if (track.type === 'soundcloud') await this._ensureSCApi();

    const token     = ++this._playbackToken;
    const newPlayer = await this._createPlayer(track);

    newPlayer.onEnd(() => {
      if (token !== this._playbackToken) return;
      this._isTransitioning = false;
      this._next();
    });

    this._crossfade(this._activePlayer, newPlayer, track.url);
    this._activePlayer = newPlayer;
    this._isPlaying    = true;
  }

  _play() {
    const list = this._categories[this._currentCategory];
    if (!list.length) return;
    if (this._activePlayer && !this._isPlaying) {
      this._activePlayer.play();
      this._isPlaying = true;
    } else if (!this._activePlayer) {
      this._loadTrack(list[this._currentIndex]);
    }
  }

  _pause() {
    this._activePlayer?.pause();
    this._isPlaying = false;
  }

  _next() {
    this._isTransitioning = false;
    const list = this._categories[this._currentCategory];
    if (!list.length) return;
    this._currentIndex = (this._currentIndex + 1) % list.length;
    this._loadTrack(list[this._currentIndex]);
  }

  _setVolume(v) {
    this._currentVolume = this._clamp(v / 100);
    this._activePlayer?.setVolume(this._currentVolume);
    this._saveToStorage();
  }

  // ── Now-playing helpers ──────────────────────────────────────

  _currentUrl() {
    const list = this._categories[this._currentCategory];
    return list[this._currentIndex]?.url || '';
  }

  _formatLabel(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop());
    } catch {
      return url;
    }
  }

  _setPlaying(active, url) {
    this._$npDot.classList.toggle('playing', active);
    this._$npLabel.classList.toggle('active', active);
    this._$npLabel.textContent = active
      ? (this._formatLabel(url) || 'Playing…')
      : 'Paused';
  }

  // ── Upgrade <li> elements with badge + drag highlight ────────

  _upgradeLis() {
    this._$audiolist.querySelectorAll('li:not([data-up])').forEach(li => {
      li.dataset.up = '1';

      const spanEl = li.querySelector('span');
      const url    = spanEl?.textContent?.trim() || '';
      if (spanEl) { spanEl.className = 'track-url'; spanEl.title = url; }

      // Badge
      const [type, label] = this._detectBadge(url);
      const badge = document.createElement('span');
      badge.className   = `track-badge badge-${type}`;
      badge.textContent = label;
      li.insertBefore(badge, spanEl);

      // Drag highlight
      li.addEventListener('dragenter', () => li.classList.add('drag-over'));
      li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
      li.addEventListener('drop',      () => li.classList.remove('drag-over'));
    });

    // Track count + empty state
    const count = this._$audiolist.querySelectorAll('li').length;
    this._$trackCount.textContent = count === 1 ? '1 track' : `${count} tracks`;
    this._$emptyState.style.display = count === 0 ? 'block' : 'none';
  }

  _detectBadge(url) {
    if (url.includes('soundcloud.com')) return ['soundcloud', 'SC'];
    if (url.includes('audius.co'))      return ['audius',     'AU'];
    if (/\.(mp3|wav|ogg)/i.test(url))  return ['audio',      'MP3'];
    return ['unknown', '?'];
  }

  // ── Utils ────────────────────────────────────────────────────

  _clamp(v) { return Math.max(0, Math.min(1, v)); }
}
