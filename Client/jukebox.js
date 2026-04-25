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
    // _currentCategory drives the displayed list in the UI tab.
    // _playbackCategory drives which list actually plays — changed only via
    // autoPlay() or switchPlaybackCategory(), never by tab clicks.
    this._currentCategory  = 'day';
    this._playbackCategory = '';
    this._currentIndex     = 0;
    this._currentVolume    = 0.5;

    // ── DOM refs (set in init) ───────────────────────────────
    this._root = null;   // scoped root element

    this._defaultCategories = {
      day: [
        { url: 'https://soundcloud.com/eduardo-mendez-860865819/strutters-cruise', type: 'soundcloud' },
        { url: 'https://soundcloud.com/eduardo-mendez-860865819/tricky-sister-girl', type: 'soundcloud' },
        { url: 'https://soundcloud.com/eduardo-mendez-860865819/blind-2-see', type: 'soundcloud' },
      ],
      night: [
        { url: 'https://soundcloud.com/eduardo-mendez-860865819/overkooled', type: 'soundcloud' },
        { url: 'https://soundcloud.com/hideki-naganuma/hideki-naganuma-love-sensation', type: 'soundcloud' },
        { url: 'https://soundcloud.com/eduardo-mendez-860865819/uneasiness-of-funkness', type: 'soundcloud' },
        { url: 'https://soundcloud.com/andrew3480/air-gear-chain-underwater-mix', type: 'soundcloud' },
      ],
      win: [
        { url: 'https://soundcloud.com/eduardo-mendez-860865819/skygrinder', type: 'soundcloud' },
        { url: 'https://soundcloud.com/eduardo-mendez-860865819/mad-babies', type: 'soundcloud' },
        { url: 'https://soundcloud.com/hideki-naganuma/hideki-naganuma-sky-2-high-1', type: 'soundcloud' },
        { url: 'https://soundcloud.com/jalenon-klasa/air-gear-ost-ii-01-rockin-8', type: 'soundcloud' },
      ],
      lose: [
        { url: 'https://soundcloud.com/eduardo-mendez-860865819/snapped', type: 'soundcloud' },
        { url: 'https://soundcloud.com/eduardo-mendez-860865819/edgeways', type: 'soundcloud' },
        { url: 'https://soundcloud.com/eduardo-mendez-860865819/master-buster', type: 'soundcloud' },
        { url: 'https://soundcloud.com/jalenon-klasa/air-gear-ost-ii-03-chain-tekno', type: 'soundcloud' },
      ]
    };
  }
  _applyDefaultsIfEmpty() {
    for (const cat in this._categories) {
      if (!this._categories[cat] || this._categories[cat].length === 0) {
        this._categories[cat] = [...this._defaultCategories[cat]];
      }
    }
  }
  // ── Public API ───────────────────────────────────────────────

  /**
   * Attach the jukebox to a container element.
   * Renders the jukebox HTML inside that container, then wires events.
   * Safe to call multiple times (idempotent — re-uses existing markup).
   */
  init(container) {
    if (!container) return;

    this._root = container.querySelector('.jukebox-root');
    this._cacheDOM();
    this._bindEvents();
    this._loadFromStorage();
    this._applyDefaultsIfEmpty();
    this._updateAudioList();
    this._upgradeLis();

    // Restore volume slider
    if (this._$volSlider) this._$volSlider.value = Math.round(this._currentVolume * 100);
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
    this._$volSlider  = document.getElementById('settings-bgm-vol');// q('.jk-vol-slider');
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
        // Only switch the displayed list — do NOT change _playbackCategory
        // or affect the currently playing track.
        this._currentCategory = btn.dataset.cat;
        this._updateAudioList();
        this._saveToStorage();
      });
    });

    // Add track
    this._$addBtn.addEventListener('click', () => this._handleAdd());
    this._$urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._handleAdd();
    });
    // Playback
    // automatically via autoPlay() when the world is first generated.
    this._$playBtn.addEventListener('click',  () => {
      if (this._isPlaybackBlocked()) return;
      this._play();
      this._setPlaying(true, this._currentUrl());
    });
    // Pause and next remain user-controllable.
    this._$pauseBtn.addEventListener('click', () => {
      this._pause();
      this._setPlaying(false, '');
    });
    this._$nextBtn.addEventListener('click',  () => {
      if (this._isPlaybackBlocked()) return;
      this._next();
      setTimeout(() => this._setPlaying(true, this._currentUrl()), 80);
    });

    // Volume — pause immediately when slider reaches zero
    this._$volSlider.addEventListener('change', () => {
      this._setVolume(this._$volSlider.value);
      if (this._isMuted() && this._isPlaying) {
        this._pause();
        this._setPlaying(false, '');
      }
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
      categories:       this._categories,
      volume:           this._currentVolume,
      category:         this._currentCategory,
      playbackCategory: this._playbackCategory,
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
      //if (parsed.playbackCategory) this._playbackCategory = parsed.playbackCategory;
    } catch (_) {}
  }

  // ── Category ─────────────────────────────────────────────────

  // Switch only the displayed tab list (no playback effect).
  _setDisplayCategory(cat) {
    this._currentCategory = cat;
    this._updateAudioList();
    this._saveToStorage();
  }

  /**
   * Switch the active playback category.
   * If tracks are available and not muted, begins playing from index 0
   * of the new category (with crossfade from the current track).
   * Does NOT change the displayed tab — UI and playback are independent.
   * @param {'day'|'night'|'win'|'lose'} cat
   */
  switchPlaybackCategory(cat) {
    if (!this._categories[cat] || cat == this._playbackCategory) return;
    this._playbackCategory = cat;
    this._currentIndex = 0;
    this._saveToStorage();
    // Start/crossfade into the new category if not muted and list is non-empty
    const list = this._categories[this._playbackCategory];
    if (list.length && !this._isMuted()) {
      this._isTransitioning = false; // allow override of any in-progress transition
      this._loadTrack(list[this._currentIndex]);
    }
  }

  /**
   * Called once by ui.js after the first world generation.
   * Begins playback from the specified category (respects volume/mute).
   * Subsequent calls from the same session are treated as category switches.
   * @param {'day'|'night'|'win'|'lose'} cat
   */
  autoPlay(cat) {
    this.switchPlaybackCategory(cat);
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
  async _initSoundCloud() {
    if (this._scWidget) return;
  
    await this._ensureSCApi();
  
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:0;height:0;opacity:0;position:absolute;';
    iframe.src = 'https://w.soundcloud.com/player/?url=&auto_play=false';
  
    document.body.appendChild(iframe);
    this._scIframe = iframe;
  
    await new Promise(res => iframe.onload = res);
  
    this._scWidget = window.SC.Widget(iframe);
  }
  async _createSoundCloudPlayer(url) {
    await this._initSoundCloud();
  
    const widget = this._scWidget;
  
    let _ready = false;
    let _pendingPlay = false;
    let _pendingVolume = this._currentVolume;
  
    return {
      play: () => {
        if (_ready) widget.play();
        else _pendingPlay = true;
      },
  
      pause: () => widget.pause(),
  
      setVolume: v => {
        _pendingVolume = this._clamp(v);
        if (_ready) widget.setVolume(_pendingVolume * 100);
      },
  
      load: (url) => {
        widget.load(url, {
          auto_play: false,
          show_artwork: false,
        });
      },
  
      onEnd: (cb) => {
        widget.bind(window.SC.Widget.Events.READY, () => {
          _ready = true;
  
          widget.setVolume(_pendingVolume * 100);
          if (_pendingPlay) widget.play();
  
          widget.bind(window.SC.Widget.Events.FINISH, cb);
        });
      }
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
  _fadeOutCurrent(cb) {
    if (!this._activePlayer) {
      cb();
      return;
    }
  
    let v = this._currentVolume;
  
    const interval = setInterval(() => {
      v -= 0.05;
      this._activePlayer.setVolume(this._clamp(v));
  
      if (v <= 0) {
        clearInterval(interval);
        this._activePlayer.pause();
        cb();
      }
    }, 40);
  }
  async _loadTrack(track) {
    if (this._isTransitioning || this._isMuted()) return;
  
    this._isTransitioning = true;
  
    const token = ++this._playbackToken;
  
    if (track.type === 'soundcloud') {
      await this._initSoundCloud();
  
      // Fade out current
      this._fadeOutCurrent(() => {
        this._scWidget.unbind(window.SC.Widget.Events.READY);
        this._scWidget.unbind(window.SC.Widget.Events.FINISH);

        this._scWidget.load(track.url, { auto_play: true });

        this._scWidget.bind(window.SC.Widget.Events.READY, () => {
          this._scWidget.setVolume(this._currentVolume * 100);
        });

        this._scWidget.bind(window.SC.Widget.Events.FINISH, () => {
          if (token !== this._playbackToken) return;
          this._isTransitioning = false;
          this._next();
        });
  
        this._scWidget.bind(window.SC.Widget.Events.FINISH, () => {
          if (token !== this._playbackToken) return;
          this._isTransitioning = false;
          this._next();
        });
  
        this._setPlaying(true, track.url);
      });
  
      this._activePlayer = {
        pause: () => this._scWidget.pause(),
        play: () => this._scWidget.play(),
        setVolume: v => this._scWidget.setVolume(v * 100)
      };
  
      this._isPlaying = true;
      return;
    }
  
    // existing logic for audio/audius
  }

  _pause() {
    this._activePlayer?.pause();
    this._isPlaying = false;
  }

  _next() {
    this._isTransitioning = false;
    const list = this._categories[this._playbackCategory];
    if (!list.length || this._isMuted()) return;
    let nextIndex = (this._currentIndex + 1) % list.length;
    if(this._currentIndex == nextIndex){return;}
    this._currentIndex = nextIndex;
    this._loadTrack(list[this._currentIndex]);
  }

  _setVolume(v) {
    
    this._currentVolume = this._clamp(v / 100);

    this._activePlayer?.setVolume(this._currentVolume);

    if (this._scWidget) {
      this._scWidget.setVolume(this._currentVolume * 100);
    }

    this._saveToStorage();
  }

  // ── Now-playing helpers ──────────────────────────────────────

  _currentUrl() {
    const list = this._categories[this._playbackCategory];
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

  // ── Interaction guards ────────────────────────────────────────

  /** True when BGM volume is set to zero (slider at 0). */
  _isMuted() {
    return this._currentVolume <= 0;
  }

  /** True when the active playback category's playlist is empty. */
  _isListEmpty() {
    return this._categories[this._playbackCategory].length === 0;
  }

  /**
   * True when next/skip should be blocked (muted or playback list empty).
   * The play button is intentionally disabled — use autoPlay() to start.
   */
  _isPlaybackBlocked() {
    return this._isMuted() || this._isListEmpty();
  }

  /** @deprecated use _isPlaybackBlocked */
  _isBlocked() { return this._isPlaybackBlocked(); }

  // ── Utils ────────────────────────────────────────────────────

  _clamp(v) { return Math.max(0, Math.min(1, v)); }
}
