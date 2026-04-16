const audioA = new Audio();
const audioB = new Audio();

let activePlayer = null;
let currentAudioEl = audioA;

let scWidget = null;
let scIframe = null;

let isPlaying = false;
let isTransitioning = false;
let playbackToken = 0;

const categories = {
    day: [],
    night: [],
    win: [],
    lose: []
};

let currentCategory = "day";
let currentIndex = 0;
let currentVolume = 0.5; // 0–1

const audiolist = document.getElementById("audiolist");

const STORAGE_KEY = "jukebox_playlists";

function clampVolume(v) {
    return Math.max(0, Math.min(1, v));
}
/* ================= STORAGE ================= */

function saveToStorage() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        categories,
        volume: currentVolume
    }));
}

function loadFromStorage() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;

    const parsed = JSON.parse(saved);

    if (parsed.categories) {
        Object.assign(categories, parsed.categories);
    }

    if (parsed.volume !== undefined) {
        currentVolume = parsed.volume;
    }
}

/* ================= CATEGORY ================= */

function setCategory(cat) {
    currentCategory = cat;
    currentIndex = 0;
    UpdateAudioList();
}

/* ================= LIST UI ================= */

function UpdateAudioList() {
    const list = categories[currentCategory];
    audiolist.innerHTML = "";

    list.forEach((entry, index) => {
        const li = document.createElement("li");

        li.draggable = true;
        li.innerHTML = `
            <span>${entry.url}</span>
            <button>X</button>
        `;

        li.querySelector("button").onclick = () => {
            list.splice(index, 1);
            saveToStorage();
            UpdateAudioList();
        };

        li.ondragstart = e => e.dataTransfer.setData("i", index);
        li.ondragover = e => e.preventDefault();

        li.ondrop = e => {
            const from = +e.dataTransfer.getData("i");
            const moved = list.splice(from, 1)[0];
            list.splice(index, 0, moved);

            saveToStorage();
            UpdateAudioList();
        };

        audiolist.appendChild(li);
    });
}

/* ================= TRACK ================= */

function detectSource(url) {
    try {
        const u = new URL(url);
        if (u.hostname.includes("soundcloud.com")) return "soundcloud";
        if (u.hostname.includes("audius.co")) return "audius";
        if (url.match(/\.(mp3|wav|ogg)$/i)) return "audio";
        return "unknown";
    } catch {
        return "unknown";
    }
}

function addTrack(rawUrl) {
    const type = detectSource(rawUrl);
    if (rawUrl.includes("archive.org/details/")) {
        rawUrl = rawUrl.replace("details", "download").replace(/\+/g, "%20");
    }
    categories[currentCategory].push({ url: rawUrl, type });
    saveToStorage();
    UpdateAudioList();
}

/* ================= PLAYER FACTORY ================= */

function createAudioPlayer(url) {
    const el = currentAudioEl === audioA ? audioB : audioA;
    currentAudioEl = el;

    el.src = url;
    el.volume = currentVolume; // 🔥 apply saved volume

    return {
        play: () => el.play(),
        pause: () => el.pause(),
        setVolume: v => el.volume = clampVolume(v),

        onEnd: cb => {
            el.onended = null;
            el.addEventListener("ended", cb, { once: true });
        }
    };
}

function createSoundCloudPlayer(url) {
    if (scIframe) scIframe.remove();

    scIframe = document.createElement("iframe");
    scIframe.className = "hidden-player";
    document.body.appendChild(scIframe);

    scIframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}`;

    scWidget = SC.Widget(scIframe);

    return {
        play: () => scWidget.play(),
        pause: () => scWidget.pause(),
        setVolume: v => scWidget.setVolume(clampVolume(v) * 100),

        onEnd: cb => {
            let called = false;
        
            const safeCall = () => {
                if (called) return;
                called = true;
                cb();
            };
        
            scWidget.bind(SC.Widget.Events.READY, () => {
                scWidget.play();
                scWidget.setVolume(currentVolume * 100);
        
                scWidget.getDuration(d => {
                    setTimeout(safeCall, d);
                });
        
                scWidget.bind(SC.Widget.Events.FINISH, safeCall);
            });
        }
    };
}

async function createAudiusPlayer(url) {
    const res = await fetch(
        `https://discoveryprovider.audius.co/v1/resolve?url=${encodeURIComponent(url)}`
    );
    const data = await res.json();

    const stream =
        `https://discoveryprovider.audius.co/v1/tracks/${data.data.id}/stream`;

    return createAudioPlayer(stream);
}

/* ================= LOAD TRACK ================= */

async function createPlayer(track) {
    switch (track.type) {
        case "audio":
            return createAudioPlayer(track.url);

        case "soundcloud":
            return createSoundCloudPlayer(track.url);

        case "audius":
            return await createAudiusPlayer(track.url);
    }
}

/* ================= CROSSFADE ================= */

function crossfade(oldP, newP, url) {
    let v = 0;

    newP.setVolume(0);
    newP.play();

    const interval = setInterval(() => {
        v += 0.05;

        const newVol = clampVolume(v);
        const oldVol = clampVolume(1 - v);

        oldP?.setVolume(oldVol * currentVolume);
        newP.setVolume(newVol * currentVolume);

        if (v >= 1) {
            clearInterval(interval);
            oldP?.pause();
        }
        setPlaying(true, url);
    }, 40);
}

/* ================= PLAYBACK ================= */


async function loadTrack(track) {
    if (isTransitioning) return;
    isTransitioning = true;

    const token = ++playbackToken; // 🔥 unique ID for this track

    const newPlayer = await createPlayer(track);

    newPlayer.onEnd(() => {
        // 🔥 ignore stale players
        if (token !== playbackToken) return;

        isTransitioning = false;
        next();
    });

    crossfade(activePlayer, newPlayer, track.url);

    activePlayer = newPlayer;
    isPlaying = true;

}

function play() {
    const list = categories[currentCategory];
    if (!list.length) return;

    if (activePlayer && !isPlaying) {
        activePlayer.play();
        isPlaying = true;
        setPlaying(true, list[currentIndex]?.url);
    } else if (!activePlayer) {
        loadTrack(list[currentIndex]);
    }
}

function pause() {
    activePlayer?.pause();
    isPlaying = false;
    setPlaying(false);
}

function next() {
    isTransitioning = false; // reset guard
    const list = categories[currentCategory];
    if (!list.length) return;

    currentIndex = (currentIndex + 1) % list.length;
    console.log("NEXT → index:", currentIndex);
    loadTrack(list[currentIndex]);
}

/* ================= CONTROLS ================= */
function setVolume(v) {
    currentVolume = clampVolume(v / 100);

    activePlayer?.setVolume(currentVolume);

    saveToStorage(); // persist immediately
}

/* ── Helpers ─────────────────────────────────────────────── */

function detectBadge(url) {
    if (url.includes('soundcloud.com')) return ['soundcloud', 'SC'];
    if (url.includes('audius.co'))      return ['audius', 'AU'];
    if (/\.(mp3|wav|ogg)/i.test(url))   return ['audio', 'MP3'];
    return ['unknown', '?'];
}

function syncMeta() {
    const items = document.querySelectorAll('#audiolist li');
    const count = items.length;
    document.getElementById('track-count').textContent =
        count === 1 ? '1 track' : `${count} tracks`;
    document.getElementById('empty-state').style.display =
        count === 0 ? 'block' : 'none';
}

/* Upgrade plain <li> elements written by jukebox.js ──────── */
function upgradeLis() {
    document.querySelectorAll('#audiolist li:not([data-up])').forEach(li => {
        li.dataset.up = '1';

        // jukebox.js puts a <span> (url) and <button> (X) inside
        const spanEl = li.querySelector('span');
        const url    = spanEl?.textContent?.trim() || '';

        // Replace the raw span with a classed one
        if (spanEl) spanEl.className = 'track-url';
        if (spanEl) spanEl.title = url;

        // Inject badge before the span
        const [type, label] = detectBadge(url);
        const badge = document.createElement('span');
        badge.className = `track-badge badge-${type}`;
        badge.textContent = label;
        li.insertBefore(badge, spanEl);

        // Drag-over highlight
        li.addEventListener('dragenter', () => li.classList.add('drag-over'));
        li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
        li.addEventListener('drop',      () => li.classList.remove('drag-over'));
    });

    syncMeta();
}
/* ── Now-playing helpers ─────────────────────────────────── */

function getCurrentUrl() {
    const li = document.querySelector('#audiolist li');
    return li?.querySelector('.track-url')?.textContent?.trim()
        || li?.querySelector('span')?.textContent?.trim()
        || '';
}
function formatTrackLabel(url) {
    try {
        const u = new URL(url);
        return decodeURIComponent(u.pathname.split('/').pop());
    } catch {
        return url;
    }
}
function setPlaying(active, url) {
    const dot   = document.getElementById('np-dot');
    const label = document.getElementById('np-label');
    dot.classList.toggle('playing', active);
    label.classList.toggle('active', active);
    label.textContent = active ? (formatTrackLabel(url) || 'Playing…') : 'Paused';
}

export { addTrack, play, pause, next, setCategory, setVolume, loadFromStorage, UpdateAudioList, upgradeLis, getCurrentUrl, setPlaying};