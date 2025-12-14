let ws;
let tracks = {};
let state = { playing:false, trackId:null, startTime:null };

const trackSelect = document.getElementById("trackSelect");
const nowPlayingEl = document.getElementById("nowPlaying");
const clientsEl = document.getElementById("clients");

const startPlaylistBtn = document.getElementById("startPlaylistBtn");
const playSelectedBtn = document.getElementById("playSelectedBtn");
const backBtn = document.getElementById("backBtn");
const skipBtn = document.getElementById("skipBtn");
const resyncBtn = document.getElementById("resyncBtn");
const stopBtn = document.getElementById("stopBtn");

const adminPlayer = document.getElementById("adminPlayer");
const adminAudioBtn = document.getElementById("adminAudioBtn");
const adminAudioStatus = document.getElementById("adminAudioStatus");

let adminAudioEnabled = false;

// ----- clock sync -----
let serverOffsetMs = 0;
let bestRttMs = Infinity;

function correctedNowMs(){ return Date.now() + serverOffsetMs; }
function expectedOffsetSec(serverStartTimeMs){
  return (correctedNowMs() - serverStartTimeMs) / 1000;
}
function timeSyncOnce(){
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type:"timeSync", clientSend: Date.now() }));
}

// ----- UI -----
function renderTrackDropdown() {
  trackSelect.innerHTML = "";
  Object.values(tracks).forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    trackSelect.appendChild(opt);
  });
}

function renderNowPlaying() {
  if (!state.playing || !state.trackId) {
    nowPlayingEl.textContent = "Now Playing: —";
    return;
  }
  const t = tracks[state.trackId];
  nowPlayingEl.textContent = "Now Playing: " + (t ? t.name : state.trackId);
}

function renderClients(list) {
  clientsEl.innerHTML = "";
  list.forEach(n => {
    const li = document.createElement("li");
    li.textContent = n;
    clientsEl.appendChild(li);
  });
}

// ----- Admin audio -----
function stopAdminAudio(){
  try { adminPlayer.pause(); } catch {}
  adminPlayer.removeAttribute("src");
  adminPlayer.load();
}

async function playAdminAudio(trackId, serverStartTimeMs){
  if (!adminAudioEnabled) return;
  if (!tracks[trackId]) return;

  const t = tracks[trackId];
  const off = expectedOffsetSec(serverStartTimeMs);

  // If start is in the future, wait and start at 0 exactly on time
  const startDelayMs = Math.max(0, Math.round(-off * 1000));
  const playFrom = Math.max(0, off);

  // If already playing same src, only adjust if drift big
  const expected = playFrom;
  const actual = adminPlayer.currentTime || 0;
  const drift = Math.abs(actual - expected);

  if (adminPlayer.src.includes(t.file) && !adminPlayer.paused && drift < 0.7 && startDelayMs === 0) {
    return;
  }

  stopAdminAudio();
  adminPlayer.src = t.file;
  adminPlayer.load();

  if (startDelayMs > 0) {
    adminAudioStatus.textContent = "Admin Audio: Starting…";
    setTimeout(async () => {
      if (!adminAudioEnabled) return;
      try {
        adminPlayer.currentTime = 0;
        await adminPlayer.play();
        adminAudioStatus.textContent = "Admin Audio: Playing";
      } catch {
        adminAudioStatus.textContent = "Admin Audio: Blocked (click Enable)";
      }
    }, startDelayMs);
  } else {
    try {
      adminPlayer.currentTime = playFrom;
      await adminPlayer.play();
      adminAudioStatus.textContent = "Admin Audio: Playing";
    } catch {
      adminAudioStatus.textContent = "Admin Audio: Blocked (click Enable)";
    }
  }
}

adminAudioBtn.onclick = async () => {
  // Must be a user gesture
  adminAudioEnabled = true;
  adminAudioBtn.textContent = "ADMIN AUDIO ENABLED";
  adminAudioStatus.textContent = "Admin Audio: Enabled";

  try {
    // unlock with a tiny play/pause
    adminPlayer.src = "chime.mp3";
    adminPlayer.currentTime = 0;
    await adminPlayer.play();
    adminPlayer.pause();
    adminPlayer.removeAttribute("src");
    adminPlayer.load();
  } catch {}

  // If a track is already playing, join immediately
  if (state.playing && state.trackId && state.startTime) {
    await playAdminAudio(state.trackId, state.startTime);
  }
};

// ----- WebSocket -----
ws = new WebSocket(location.origin.replace(/^http/, "ws"));

ws.onopen = () => {
  ws.send(JSON.stringify({ type:"hello", role:"admin" }));
  timeSyncOnce();
  setInterval(timeSyncOnce, 5000);
};

ws.onmessage = async (e) => {
  const msg = JSON.parse(e.data);

  if (msg.type === "timeSync") {
    const recv = Date.now();
    const rtt = recv - msg.clientSend;
    const approxServerAtRecv = msg.serverTime + (rtt / 2);
    const offset = approxServerAtRecv - recv;
    if (rtt < bestRttMs) { bestRttMs = rtt; serverOffsetMs = offset; }
    else serverOffsetMs = serverOffsetMs * 0.9 + offset * 0.1;
    return;
  }

  if (msg.type === "tracks") {
    tracks = msg.tracks || {};
    renderTrackDropdown();
    renderNowPlaying();
    return;
  }

  if (msg.type === "state") {
    state = msg.state || state;
    renderNowPlaying();

    // Catch up admin audio based on state (important for late open)
    if (adminAudioEnabled && state.playing && state.trackId && state.startTime) {
      await playAdminAudio(state.trackId, state.startTime);
    }
    if (adminAudioEnabled && !state.playing) {
      stopAdminAudio();
      adminAudioStatus.textContent = "Admin Audio: Enabled";
    }
    return;
  }

  if (msg.type === "clients") {
    renderClients(msg.list || []);
    return;
  }

  // If server sends play/resync explicitly to admin in future:
  if (msg.type === "play" || msg.type === "resync") {
    state.playing = true;
    state.trackId = msg.trackId;
    state.startTime = msg.startTime;
    renderNowPlaying();
    if (adminAudioEnabled) await playAdminAudio(msg.trackId, msg.startTime);
    return;
  }

  if (msg.type === "stop") {
    state.playing = false;
    state.trackId = null;
    state.startTime = null;
    renderNowPlaying();
    stopAdminAudio();
    if (adminAudioEnabled) adminAudioStatus.textContent = "Admin Audio: Enabled";
    return;
  }
};

// ----- Buttons -----
startPlaylistBtn.onclick = () => ws.send(JSON.stringify({ type:"startPlaylist" }));
playSelectedBtn.onclick = () => ws.send(JSON.stringify({ type:"playTrack", trackId: trackSelect.value }));
backBtn.onclick = () => ws.send(JSON.stringify({ type:"back" }));
skipBtn.onclick = () => ws.send(JSON.stringify({ type:"skip" }));
resyncBtn.onclick = () => ws.send(JSON.stringify({ type:"resync" }));
stopBtn.onclick = () => ws.send(JSON.stringify({ type:"stop" }));
