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
let pausedAt = null;

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.userAgent.includes("Mac") && "ontouchend" in document);

// UI refs
const nameInput = document.getElementById("nameInput");
const armBtn = document.getElementById("armBtn");
const pausePlayBtn = document.getElementById("pausePlayBtn");
const statusText = document.getElementById("statusText");
const syncText = document.getElementById("syncText");
const armedText = document.getElementById("armedText");
const playbackText = document.getElementById("playbackText");
const resyncBtn = document.getElementById("resyncBtn");

// -------------------- UI HELPERS --------------------

function logStatus(msg) {
  statusText.textContent = msg;
}

function updateStatusIndicators() {
  armedText.textContent = armed ? "Yes" : "No";
  playbackText.textContent =
    playing ? "Playing" : paused ? "Paused" : "Idle";
}

function updateUIButtons() {
  armBtn.disabled = !(audioLoaded && hasName && !armed);
}

// Live name validation → unlock ARM when name is typed
nameInput.addEventListener("input", () => {
  clientName = nameInput.value.trim();
  hasName = clientName.length > 0;
  updateUIButtons();
});

// -------------------- CLOCK SYNC --------------------

let pendingPings = [];
let offsetSamples = [];
let syncInProgress = false;

function runClockSync(samples = 10) {
  syncInProgress = true;
  syncText.textContent = "Syncing…";
  syncText.className = "statusWarn";
  offsetSamples = [];
  for (let i = 0; i < samples; i++) sendPing();
}

function sendPing() {
  const t = Date.now();
  pendingPings.push(t);
  ws.send(JSON.stringify({ type: "ping", clientSendTime: t }));
}

function handlePong(msg) {
  const { clientSendTime, serverTime } = msg;
  const idx = pendingPings.indexOf(clientSendTime);
  if (idx === -1) return;

  pendingPings.splice(idx, 1);

  const recv = Date.now();
  const rtt = recv - clientSendTime;
  const mid = clientSendTime + rtt / 2;
  const offset = serverTime - mid;

  offsetSamples.push({ rtt, offset });

  if (offsetSamples.length >= 10) {
    const best = offsetSamples
      .sort((a, b) => a.rtt - b.rtt)
      .slice(0, 5)
      .map((x) => x.offset);

    timeOffset = best.reduce((a, b) => a + b, 0) / best.length;

    syncText.textContent = "Synced ✓";
    syncText.className = "statusGood";
    syncInProgress = false;
    return;
  }

  sendPing();
}

function getServerNow() {
  return Date.now() + timeOffset;
}

// -------------------- RESYNC BUTTON --------------------

resyncBtn.onclick = () => {
  syncText.textContent = "Syncing…";
  syncText.className = "statusWarn";
  runClockSync();
};

// -------------------- AUDIO LOADING --------------------

async function loadAudioFile() {
  const file = currentTrackList[currentTrackId].file;
  trackDuration = currentTrackList[currentTrackId].duration;

  try {
    if (isIOS) {
      htmlAudio = new Audio(file);
      htmlAudio.preload = "auto";

      htmlAudio.addEventListener("canplaythrough", () => {
        audioLoaded = true;
        logStatus("Audio loaded, enter family name.");
        updateUIButtons();
      });

      htmlAudio.load();
    } else {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const res = await fetch(file);
      const arr = await res.arrayBuffer();
      audioBuffer = await audioCtx.decodeAudioData(arr);

      audioLoaded = true;
      logStatus("Audio loaded, enter family name.");
      updateUIButtons();
    }
  } catch (err) {
    logStatus("Audio load error: " + err);
  }
}

// -------------------- ARM BUTTON --------------------

armBtn.onclick = () => {
  if (!hasName || !audioLoaded) return;

  function finishArm() {
    armed = true;
    updateUIButtons();
    armedText.textContent = "Yes";

    ws.send(JSON.stringify({ type: "register", name: clientName }));
    ws.send(JSON.stringify({ type: "armed" }));

    pausePlayBtn.style.display = "block";
    logStatus("ARMED. Waiting for start…");
  }

  if (isIOS) {
    htmlAudio
      .play()
      .then(() => {
        htmlAudio.pause();
        htmlAudio.currentTime = 0;
        finishArm();
      })
      .catch(() => {
        logStatus("Tap ARM again to allow audio.");
      });
  } else {
    if (audioCtx.state === "suspended") audioCtx.resume();
    finishArm();
  }
};

// -------------------- PAUSE / RESUME --------------------

pausePlayBtn.onclick = () => {
  if (paused) resumeFromServer();
  else pauseLocal();
};

function pauseLocal() {
  if (!armed) return;

  paused = true;
  playing = false;

  if (isIOS) {
    htmlAudio.pause();
    pausedAt = htmlAudio.currentTime * 1000;
  } else if (currentSource) {
    try {
      currentSource.stop();
    } catch {}
    pausedAt = getServerNow() - serverStartTime;
  }

  pausePlayBtn.textContent = "Play";
  ws.send(JSON.stringify({ type: "clientState", playing: false, paused: true }));
  updateStatusIndicators();
}

function resumeFromServer() {
  if (!armed || !serverStartTime) return;

  const now = getServerNow();
  let offset = now - serverStartTime;

  if (offset < 0) offset = 0;
  if (offset > trackDuration) offset = trackDuration - 50;

  paused = false;
  playing = true;

  if (isIOS) {
    htmlAudio.currentTime = offset / 1000;
    htmlAudio.play();
  } else {
    if (audioCtx.state === "suspended") audioCtx.resume();
    if (currentSource) {
      try {
        currentSource.stop();
      } catch {}
    }
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(audioCtx.destination);
    src.start(0, offset / 1000);
    currentSource = src;
  }

  pausePlayBtn.textContent = "Pause";
  ws.send(JSON.stringify({ type: "clientState", playing: true, paused: false }));
  updateStatusIndicators();
}

// -------------------- SERVER COMMAND HANDLERS --------------------

function handleStart(msg) {
  if (!armed) {
    logStatus("Start received — ARM required.");
    return;
  }

  serverStartTime = msg.serverStartTime;
  paused = false;
  playing = false;
  logStatus("Start scheduled…");
}

function handlePause(msg) {
  if (!armed) return;

  pausedAt = msg.pausedAt;
  pauseLocal();
}

function handleResume(msg) {
  if (!armed) return;

  serverStartTime = msg.serverStartTime;
  resumeFromServer();
}

function handleSeek(msg) {
  if (!armed) return;

  serverStartTime = msg.serverStartTime;
  resumeFromServer();
}

function handleStop() {
  if (!armed) return;

  serverStartTime = null;
  pausedAt = null;
  paused = false;
  playing = false;

  if (isIOS) {
    htmlAudio.pause();
    htmlAudio.currentTime = 0;
  } else if (currentSource) {
    try {
      currentSource.stop();
    } catch {}
  }

  pausePlayBtn.textContent = "Pause";
  playbackText.textContent = "Idle";
}

// -------------------- WEBSOCKET SETUP --------------------

function connectWS() {
  ws = new WebSocket(
    location.protocol === "https:"
      ? `wss://${location.host}`
      : `ws://${location.host}`
  );

  ws.onopen = () => {
    wsReady = true;
    ws.send(JSON.stringify({ type: "hello", role: "client" }));
    logStatus("Syncing clock…");
    runClockSync();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "pong") handlePong(msg);
    if (msg.type === "tracks") {
      currentTrackList = {};
      msg.tracks.forEach((t) => (currentTrackList[t.id] = t));
      loadAudioFile();
    }
    if (msg.type === "start") handleStart(msg);
    if (msg.type === "pause") handlePause(msg);
    if (msg.type === "resume") handleResume(msg);
    if (msg.type === "seek") handleSeek(msg);
    if (msg.type === "stop") handleStop();
  };
}

connectWS();
