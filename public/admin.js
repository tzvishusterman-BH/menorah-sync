let ws;
let tracks = {};
let state = { playing:false, trackId:null, startTime:null };

const trackSelect = document.getElementById("trackSelect");
const nowPlayingEl = document.getElementById("nowPlaying");
const clockEl = document.getElementById("clock");
const countdownEl = document.getElementById("countdown");
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

function renderNowPlaying(){
  if (!state.playing || !state.trackId) {
    nowPlayingEl.textContent = "Now Playing: —";
    countdownEl.textContent = "Countdown: —";
    return;
  }
  nowPlayingEl.textContent = "Now Playing: " + (tracks[state.trackId]?.name || state.trackId);
}

function renderCountdown(){
  if (!state.playing || !state.trackId || !state.startTime) {
    countdownEl.textContent = "Countdown: —";
    return;
  }
  const leftMs = state.startTime - correctedNowMs();
  if (leftMs > 0) countdownEl.textContent = `Countdown: ${(leftMs/1000).toFixed(1)}s`;
  else countdownEl.textContent = "Countdown: LIVE";
}

setInterval(() => {
  clockEl.textContent = fmtTime(correctedNowMs());
  renderCountdown();
}, 100);

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
    trackSelect.innerHTML = "";
    Object.values(tracks).forEach(t => {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.name;
      trackSelect.appendChild(o);
    });
    renderNowPlaying();
    return;
  }

  if (msg.type === "state") {
    state = msg.state || state;
    renderNowPlaying();
    return;
  }

  if (msg.type === "play" || msg.type === "resync") {
    state.playing = true;
    state.trackId = msg.trackId;
    state.startTime = msg.startTime;
    renderNowPlaying();
    return;
  }

  if (msg.type === "stop") {
    state.playing = false;
    state.trackId = null;
    state.startTime = null;
    renderNowPlaying();
    return;
  }

  if (msg.type === "clients") {
    const list = msg.list || [];
    carsCountEl.textContent = `Cars: ${list.length}`;
    clientsEl.innerHTML = "";
    list.forEach(n => {
      const li = document.createElement("li");
      li.textContent = n;
      clientsEl.appendChild(li);
    });
    return;
  }
};

document.getElementById("playBtn").onclick = () => {
  ws.send(JSON.stringify({ type:"play", trackId: trackSelect.value }));
};

document.getElementById("resyncBtn").onclick = () => {
  ws.send(JSON.stringify({ type:"resync" }));
};

document.getElementById("stopBtn").onclick = () => {
  ws.send(JSON.stringify({ type:"stop" }));
};
