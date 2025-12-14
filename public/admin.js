// ===== PIN gate (NOT saved) =====
const PIN_CODE = "130865";
const gate = document.getElementById("pinGate");
const pinInput = document.getElementById("pinInput");
const pinBtn = document.getElementById("pinBtn");
const pinMsg = document.getElementById("pinMsg");

pinBtn.onclick = () => {
  if (pinInput.value.trim() === PIN_CODE) {
    gate.style.display = "none";
  } else {
    pinMsg.style.display = "block";
    setTimeout(() => (pinMsg.style.display = "none"), 1200);
  }
};

// ===== WebSocket + state =====
let ws;
let tracks = {};
let state = {
  playing: false,
  paused: false,
  trackId: null,
  startTime: null,
  playlist: ["tyh"],
  playlistIndex: 0
};

const trackSelect = document.getElementById("trackSelect");
const nowPlayingEl = document.getElementById("nowPlaying");
const clockEl = document.getElementById("clock");
const countdownEl = document.getElementById("countdown");

const pausePlayBtn = document.getElementById("pausePlayBtn");
const stopBtn = document.getElementById("stopBtn");
const nextBtn = document.getElementById("nextBtn");
const backBtn = document.getElementById("backBtn");
const playSelectedBtn = document.getElementById("playSelectedBtn");

const addToPlaylistBtn = document.getElementById("addToPlaylistBtn");
const playlistEl = document.getElementById("playlist");

const clientsEl = document.getElementById("clients");
const carsCountEl = document.getElementById("carsCount");

let serverOffsetMs = 0;
let bestRttMs = Infinity;

function correctedNowMs(){ return Date.now() + serverOffsetMs; }
function timeSyncOnce(){
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:"timeSync", clientSend: Date.now() }));
  }
}
function fmtTime(ms){
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  const ss = String(d.getSeconds()).padStart(2,"0");
  return `${hh}:${mm}:${ss}`;
}

function renderTop(){
  const now = correctedNowMs();
  clockEl.textContent = fmtTime(now);

  if (!state.playing || !state.trackId || !state.startTime) {
    countdownEl.textContent = "Countdown: —";
    nowPlayingEl.textContent = "Now Playing: —";
    pausePlayBtn.textContent = "PAUSE";
    return;
  }

  const tName = tracks[state.trackId]?.name || state.trackId;
  nowPlayingEl.textContent = `Now Playing: ${tName}`;

  if (state.paused) {
    countdownEl.textContent = "Paused";
    pausePlayBtn.textContent = "PLAY";
    return;
  }

  const leftMs = state.startTime - now;
  if (leftMs > 0) countdownEl.textContent = `Countdown: ${(leftMs/1000).toFixed(1)}s`;
  else countdownEl.textContent = "LIVE";

  pausePlayBtn.textContent = "PAUSE";
}
setInterval(renderTop, 100);

function renderTrackDropdown(){
  trackSelect.innerHTML = "";
  Object.values(tracks).forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    trackSelect.appendChild(opt);
  });
}

function renderPlaylist(){
  playlistEl.innerHTML = "";
  const pl = state.playlist || [];
  pl.forEach((id, idx) => {
    const li = document.createElement("li");
    li.className = "pl-item";
    li.dataset.trackId = id;

    const handle = document.createElement("div");
    handle.className = "handle";
    handle.textContent = "≡";

    const name = document.createElement("div");
    name.className = "pl-name";
    name.textContent = tracks[id]?.name || id;

    const actions = document.createElement("div");
    actions.className = "pl-actions";

    const playBtn = document.createElement("button");
    playBtn.textContent = "Play";
    playBtn.className = "gray";
    playBtn.onclick = () => {
      ws.send(JSON.stringify({ type:"playAtIndex", index: idx }));
    };

    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
    delBtn.className = "gray";
    delBtn.onclick = () => {
      const next = pl.slice(0, idx).concat(pl.slice(idx + 1));
      ws.send(JSON.stringify({ type:"setPlaylist", playlist: next }));
    };

    actions.appendChild(playBtn);
    actions.appendChild(delBtn);

    li.appendChild(handle);
    li.appendChild(name);
    li.appendChild(actions);
    playlistEl.appendChild(li);
  });
}

new Sortable(playlistEl, {
  handle: ".handle",
  animation: 150,
  onEnd: () => {
    const ids = [...playlistEl.querySelectorAll(".pl-item")].map(li => li.dataset.trackId);
    ws.send(JSON.stringify({ type:"setPlaylist", playlist: ids }));
  }
});

addToPlaylistBtn.onclick = () => {
  const id = trackSelect.value;
  const pl = (state.playlist || []).slice();
  pl.push(id);
  ws.send(JSON.stringify({ type:"setPlaylist", playlist: pl }));
};

playSelectedBtn.onclick = () => {
  ws.send(JSON.stringify({ type:"playTrack", trackId: trackSelect.value }));
};

pausePlayBtn.onclick = () => ws.send(JSON.stringify({ type:"togglePause" }));
stopBtn.onclick = () => ws.send(JSON.stringify({ type:"stop" }));
nextBtn.onclick = () => ws.send(JSON.stringify({ type:"next" }));
backBtn.onclick = () => ws.send(JSON.stringify({ type:"back" }));

function renderClients(list){
  carsCountEl.textContent = `Cars: ${list.length}`;
  clientsEl.innerHTML = "";
  list.forEach(n => {
    const li = document.createElement("li");
    li.textContent = n;
    clientsEl.appendChild(li);
  });
}

// WebSocket
ws = new WebSocket(location.origin.replace(/^http/, "ws"));

ws.onopen = () => {
  ws.send(JSON.stringify({ type:"hello", role:"admin" }));
  timeSyncOnce();
  setInterval(timeSyncOnce, 2000);
};

ws.onmessage = (e) => {
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
    renderPlaylist();
    return;
  }

  if (msg.type === "state") {
    state = msg.state || state;
    renderPlaylist();
    return;
  }

  if (msg.type === "clients") {
    renderClients(msg.list || []);
    return;
  }
};
