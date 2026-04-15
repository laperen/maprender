
let playlist = [];
let currentIndex = 0;
let currentPlayer = null;

const audio = document.getElementById("audio-player");
let ytPlayer;
let ytReady = false;

const scIframe = document.getElementById("soundcloud-player");
let scWidget = null;

function detectSource(url) {
    try {
      const u = new URL(url);
  
        if (u.hostname.includes("audius.co")) return "audius";
        if (u.hostname.includes("soundcloud.com")) return "soundcloud";
        if (url.match(/\.(mp3|ogg|wav)$/i)) return "audio";
  
        return "unknown";
    } catch {
        return "unknown";
    }
  }
function normalizeArchiveUrl(url) {
    if (url.includes("archive.org/details/")) {
        return url.replace("details", "download").replace(/\+/g, "%20");
    }
    return url;
}
function UpdateAudioList(){
    audiolist.innerHTML = "";
    for(let i = 0, max = playlist.length; i < max; i++){
        let entry = playlist[i];
        let li = document.createElement("li");
        li.innerText = `${entry.url}, type: ${entry.type}`;
        audiolist.appendChild(li);
    }
}
function addTrack(rawUrl) {
    //const rawUrl = document.getElementById("urlInput").value;
    const url = normalizeArchiveUrl(rawUrl);

    const type = detectSource(url);

    playlist.push({ url, type });
    UpdateAudioList();
}
//Soundcloud
function loadSoundCloud(url) {
    const embedUrl = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}`;

    if (!scWidget) {
        scIframe.src = embedUrl;

        scWidget = SC.Widget(scIframe);

        scWidget.bind(SC.Widget.Events.READY, () => {
        scWidget.play();
        });

        scWidget.bind(SC.Widget.Events.FINISH, () => next());
    } else {
        scWidget.load(url, { auto_play: true });
    }

    currentPlayer = {
        pause: () => scWidget?.pause(),
        play: () => scWidget?.play(),
        setVolume: (v) => scWidget?.setVolume(v)
    };
}
//Audius
async function loadAudius(url) {
    try {
        const res = await fetch(
        `https://discoveryprovider.audius.co/v1/resolve?url=${encodeURIComponent(url)}`
        );
        const data = await res.json();

        const trackId = data.data.id;

        const streamUrl = `https://discoveryprovider.audius.co/v1/tracks/${trackId}/stream`;

        loadAudio(streamUrl);
    } catch (e) {
        console.error("Audius load failed", e);
    }
}
//Direct audio

function loadAudio(url) {
    audio.src = url;
    audio.play();

    audio.onended = next;

    currentPlayer = audio;
    console.log("load regular audio");
}
//Unified player
function loadTrack(track) {
    stopAll();

    switch (track.type) {
        case "soundcloud":
            loadSoundCloud(track.url);
            break;
        case "audio":
            loadAudio(track.url);
            break;
        case "audius":
            loadAudius(track.url);
            break;
        default:
            console.warn("Unsupported source");
    }
}
  
function play() {
    if (!playlist.length) return;

    const track = playlist[currentIndex];
    loadTrack(track);
}
function userPlay() {
    play(); // your existing logic
}
  
function pause() {
    if (!currentPlayer) return;

    if (currentPlayer.pause) currentPlayer.pause();
    if (currentPlayer.pauseVideo) currentPlayer.pauseVideo();
}
  
function resume() {
    if (!currentPlayer) return;

    if (currentPlayer.play) currentPlayer.play();
    if (currentPlayer.playVideo) currentPlayer.playVideo();
}
  
function next() {
    currentIndex = (currentIndex + 1) % playlist.length;
    loadTrack(playlist[currentIndex]);
}
//volume control
function setVolume(v) {
    const volume = v / 100;

    if (ytPlayer && currentPlayer === ytPlayer) {
        ytPlayer.setVolume(v); // 0–100
    }

    if (scWidget && currentPlayer !== ytPlayer && currentPlayer !== audio) {
        scWidget.setVolume(v);
    }

    if (audio && currentPlayer === audio) {
        audio.volume = volume; // 0–1
    }
}
function stopAll() {
    if (ytPlayer) ytPlayer.stopVideo();
    if (scWidget) scWidget.pause();
    if (audio) audio.pause();
}
export{addTrack,userPlay,pause,next}