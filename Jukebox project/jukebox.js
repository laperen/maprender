const audioA = new Audio();
const audioB = new Audio();

let activePlayer = null;
let currentAudioEl = audioA;

let scWidget = null;
let scIframe = null;

let isPlaying = false;

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

    let endCallback = null;
    let duration = null;

    function fallbackTimer() {
        if (!duration) return;

        setTimeout(() => {
            console.log("SC fallback next()");
            endCallback?.();
        }, duration);
    }

    return {
        play: () => scWidget.play(),
        pause: () => scWidget.pause(),
        setVolume: v => scWidget.setVolume(clampVolume(v) * 100),

        onEnd: cb => {
            endCallback = cb;

            scWidget.bind(SC.Widget.Events.READY, () => {
                scWidget.play();
                scWidget.setVolume(currentVolume * 100);
                scWidget.getDuration(d => {
                    duration = d;
                    fallbackTimer();
                });

                scWidget.bind(SC.Widget.Events.FINISH, () => {
                    console.log("SC FINISH");
                    cb();
                });

                // 🔥 retry if FINISH fails
                setTimeout(() => {
                    console.log("SC retry bind");
                    scWidget.bind(SC.Widget.Events.FINISH, cb);
                }, 2000);
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

function crossfade(oldP, newP) {
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
    }, 40);
}

/* ================= PLAYBACK ================= */

async function loadTrack(track) {
    const newPlayer = await createPlayer(track);

    newPlayer.onEnd(() => next());

    crossfade(activePlayer, newPlayer);

    activePlayer = newPlayer;
    isPlaying = true;
}

function play() {
    const list = categories[currentCategory];
    if (!list.length) return;

    if (activePlayer && !isPlaying) {
        activePlayer.play();
        isPlaying = true;
    } else if (!activePlayer) {
        loadTrack(list[currentIndex]);
    }
}

function pause() {
    activePlayer?.pause();
    isPlaying = false;
}

function next() {
    const list = categories[currentCategory];
    if (!list.length) return;

    currentIndex = (currentIndex + 1) % list.length;
    loadTrack(list[currentIndex]);
}

/* ================= CONTROLS ================= */
function setVolume(v) {
    currentVolume = clampVolume(v / 100);

    activePlayer?.setVolume(currentVolume);

    saveToStorage(); // persist immediately
}

export { addTrack, play, pause, next, setCategory, setVolume, loadFromStorage, UpdateAudioList};