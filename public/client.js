let ws;
let audioCtx;
let audioBuffer = null;
let htmlAudio = null;
let currentSource = null;

let clientName = "";
let hasName = false;
let armed = false;
let playing = false;
let paused = false;

let audioLoaded = false;
let wsReady = false;

let timeOffset = 0;

let currentTrackList = {};
let currentTrackId = "tyh";
let trackDuration = 532000;

let serverStartTime = null;
let lastState = null;

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes("Mac") && "ontouchend" in document);

// UI refs
const nameInput = document.getElementById("nameInput");
const armBtn = document.getElementById("armBtn");
const pausePlayBtn = document.getElementById("pausePlayBtn");
const statusText = document.getElementById("statusText");
const syncText = document.getElementById("syncText");
const nowPlayingText = document.getElementById("nowPlayingText");
const resyncBtn = document.getElementById("resyncBtn");

// UI Helpers
function logStatus(msg) { statusText.textContent = msg; }
function updateUIButtons() { armBtn.disabled = !(audioLoaded && hasName && !armed); }

function updateNowPlaying() {
  if (!lastState || lastState.mode === "idle") {
    nowPlayingText.textContent = "Nothing";
    return;
  }
  const t = currentTrackList[lastState.trackId];
  nowPlayingText.textContent = t ? t.name : "Unknown";
}

nameInput.addEventListener("input", () => {
  clientName = nameInput.value.trim();
  hasName = clientName.length > 0;
  updateUIButtons();
});


// CLOCK SYNC
let pendingPings = [];
let offsets = [];

function runClockSync(samples = 10) {
  offsets = [];
  syncText.textContent = "Syncing…";
  syncText.className = "statusWarn";

  for (let i = 0; i < samples; i++) sendPing();
}

function sendPing() {
  const t = Date.now();
  pendingPings.push(t);
  ws.send(JSON.stringify({ type: "ping", clientSendTime: t }));
}

function handlePong(msg) {
  let idx = pendingPings.indexOf(msg.clientSendTime);
  if (idx === -1) return;

  pendingPings.splice(idx, 1);

  const now = Date.now();
  const rtt = now - msg.clientSendTime;
  const server = msg.serverTime;

  const mid = msg.clientSendTime + rtt / 2;
  const offset = server - mid;

  offsets.push({ rtt, offset });

  if (offsets.length >= 10) {
    const best = offsets.sort((a,b)=>a.rtt-b.rtt).slice(0,5).map(x=>x.offset);
    timeOffset = best.reduce((a,b)=>a+b,0) / best.length;

    syncText.textContent = "Synced";
    syncText.className = "statusGood";

    maybeAutoJoin();
  } else {
    sendPing();
  }
}

function getServerNow() { return Date.now() + timeOffset; }


// RESYNC
resyncBtn.onclick = () => { runClockSync(); };


// AUDIO LOADING
async function loadAudioFile() {
  const file = currentTrackList[currentTrackId].file;
  trackDuration = currentTrackList[currentTrackId].duration;

  try {
    if (isIOS) {
      htmlAudio = new Audio(file);
      htmlAudio.preload = "auto";

      htmlAudio.addEventListener("canplaythrough", () => {
        audioLoaded = true;
        updateUIButtons();
      });

      htmlAudio.load();

    } else {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const res = await fetch(file);
      const buf = await res.arrayBuffer();
      audioBuffer = await audioCtx.decodeAudioData(buf);

      audioLoaded = true;
      updateUIButtons();
    }

  } catch (err) {
    logStatus("Audio load error");
  }
}


// AUTO-JOIN
function maybeAutoJoin() {
  if (!armed || !lastState) return;
  if (lastState.mode !== "playing") return;

  serverStartTime = lastState.serverStartTime;
  resumeFrom();
}


// ARM
armBtn.onclick = () => {

  function finish() {
    armed = true;
    updateUIButtons();

    ws.send(JSON.stringify({ type: "register", name: clientName }));
    ws.send(JSON.stringify({ type: "armed" }));

    pausePlayBtn.style.display = "block";
    maybeAutoJoin();
  }

  if (isIOS) {
    htmlAudio.play()
      .then(()=>{ htmlAudio.pause(); htmlAudio.currentTime=0; finish(); })
      .catch(()=> logStatus("Tap ARM again"));
  } else {
    if (audioCtx.state === "suspended") audioCtx.resume();
    finish();
  }
};


// LOCAL PLAYBACK
pausePlayBtn.onclick = () => {
  paused ? resumeFrom() : pauseLocal();
};

function pauseLocal() {
  paused = true;
  playing = false;

  if (isIOS) {
    htmlAudio.pause();
  } else if (currentSource) {
    try { currentSource.stop(); } catch {}
  }

  pausePlayBtn.textContent = "Play";

  ws.send(JSON.stringify({
    type: "clientState",
    playing: false,
    paused: true
  }));
}

function resumeFrom() {
  if (!armed || !serverStartTime) return;

  const now = getServerNow();
  let offset = now - serverStartTime;
  if (offset < 0) offset = 0;
  if (offset > trackDuration) offset = trackDuration - 50;

  paused = false;
  playing = true;

  if (isIOS) {
    htmlAudio.currentTime = offset/1000;
    htmlAudio.play();
  } else {
    if (audioCtx.state === "suspended") audioCtx.resume();
    if (currentSource) try{currentSource.stop();}catch{}

    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(audioCtx.destination);
    src.start(0, offset/1000);
    currentSource = src;
  }

  pausePlayBtn.textContent = "Pause";

  ws.send(JSON.stringify({
    type: "clientState",
    playing: true,
    paused: false
  }));
}


// SERVER COMMANDS
function handleSeek(msg) {
  if (msg.trackId) {
    currentTrackId = msg.trackId;
    loadAudioFile();
  }
  serverStartTime = msg.serverStartTime;
  resumeFrom();
}

function handleStop() {
  playing = false;
  paused = false;

  if (isIOS) {
    htmlAudio.pause();
    htmlAudio.currentTime = 0;
  } else if (currentSource) {
    try { currentSource.stop(); } catch {}
  }

  nowPlayingText.textContent = "Nothing";
  pausePlayBtn.textContent = "Pause";
}

function handleState(st) {
  lastState = st;
  updateNowPlaying();
  maybeAutoJoin();
}


// WEBSOCKET
function connectWS() {
  ws = new WebSocket(
    location.protocol === "https:" ?
    `wss://${location.host}` :
    `ws://${location.host}`
  );

  ws.onopen = () => {
    ws.send(JSON.stringify({ type:"hello", role:"client" }));
    runClockSync();
  };

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);

    if (msg.type === "pong") return handlePong(msg);
    if (msg.type === "tracks") {
      currentTrackList = {};
      msg.tracks.forEach(t => currentTrackList[t.id] = t);
      loadAudioFile();
      return;
    }
    if (msg.type === "state") return handleState(msg.state);
    if (msg.type === "seek") return handleSeek(msg);
    if (msg.type === "stop") return handleStop();
  };
}

connectWS();
