let ws;
let tracks = {};
let state = { playing:false, trackId:null, startTime:null };

const trackSelect = document.getElementById("trackSelect");
const nowPlaying = document.getElementById("nowPlaying");
const clockEl = document.getElementById("clock");
const countdownEl = document.getElementById("countdown");

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

function render(){
  clockEl.textContent = fmtTime(correctedNowMs());

  if (!state.playing || !state.trackId || !state.startTime) {
    countdownEl.textContent = "Countdown: —";
    return;
  }

  const leftMs = state.startTime - correctedNowMs();
  if (leftMs > 0) {
    countdownEl.textContent = `Countdown: ${(leftMs/1000).toFixed(1)}s`;
  } else {
    countdownEl.textContent = "Countdown: LIVE";
  }
}

setInterval(render, 100);

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
    return;
  }

  if (msg.type === "state") {
    state = msg.state || state;
    if (!state.playing) nowPlaying.textContent = "Now Playing: —";
    else nowPlaying.textContent = "Now Playing: " + (tracks[state.trackId]?.name || state.trackId);
    return;
  }

  if (msg.type === "play") {
    state.playing = true;
    state.trackId = msg.trackId;
    state.startTime = msg.startTime;
    nowPlaying.textContent = "Now Playing: " + (tracks[msg.trackId]?.name || msg.trackId);
    return;
  }

  if (msg.type === "stop") {
    state.playing = false;
    state.trackId = null;
    state.startTime = null;
    nowPlaying.textContent = "Now Playing: —";
  }
};

document.getElementById("playBtn").onclick = () => {
  ws.send(JSON.stringify({ type:"play", trackId: trackSelect.value }));
};

document.getElementById("stopBtn").onclick = () => {
  ws.send(JSON.stringify({ type:"stop" }));
};
