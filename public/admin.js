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
const stopBtn = document.getElementById("stopBtn");

ws = new WebSocket(location.origin.replace(/^http/, "ws"));

ws.onopen = () => {
  ws.send(JSON.stringify({ type:"hello", role:"admin" }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  if (msg.type === "tracks") {
    tracks = msg.tracks || {};
    renderTrackDropdown();
  }

  if (msg.type === "state") {
    state = msg.state || state;
    renderNowPlaying();
  }

  if (msg.type === "clients") {
    renderClients(msg.list || []);
  }
};

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

startPlaylistBtn.onclick = () => ws.send(JSON.stringify({ type:"startPlaylist" }));
playSelectedBtn.onclick = () => ws.send(JSON.stringify({ type:"playTrack", trackId: trackSelect.value }));
backBtn.onclick = () => ws.send(JSON.stringify({ type:"back" }));
skipBtn.onclick = () => ws.send(JSON.stringify({ type:"skip" }));
stopBtn.onclick = () => ws.send(JSON.stringify({ type:"stop" }));
