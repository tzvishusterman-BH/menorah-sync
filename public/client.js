// --- STATE ---
let ws;
let audioCtx;
let audioBuffer = null;
let htmlAudio = null;
let timeOffset = 0;
let armed = false;
let serverStartTime = null;
let currentSource = null;

// name state
let clientName = "";
let hasName = false;
let audioLoaded = false;
let wsReady = false;

const statusEl = document.getElementById("status");
const armBtn = document.getElementById("armBtn");
const nameInput = document.getElementById("nameInput");
const saveNameBtn = document.getElementById("saveNameBtn");

// iOS detection
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes("Mac") && "ontouchend" in document);

function logStatus(m) {
  console.log(m);
  statusEl.textContent = m;
}

function getWSUrl() {
  return location.protocol === "https:"
    ? `wss://${location.host}`
    : `ws://${location.host}`;
}

// --- ENABLE/DISABLE ARM ---
function updateArmButtonState() {
  const enable = audioLoaded && hasName && !armed;
  armBtn.disabled = !enable;
}

// --- CLOCK SYNC ---
let pendingPings = [];
let clockSyncResolve;

function runClockSync(samples = 10) {
  return new Promise((resolve) => {
    clockSyncResolve = resolve;
    window._offsetSamples = [];
    for (let i = 0; i < samples; i++) sendPing();
  });
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

  window._offsetSamples.push({ rtt, offset });

  if (window._offsetSamples.length >= 10 && clockSyncResolve) {
    const best = window._offsetSamples
      .sort((a, b) => a.rtt - b.rtt)
      .slice(0, 5)
      .map((x) => x.offset);

    timeOffset = best.reduce((a, b) => a + b, 0) / best.length;

    console.log("OFFSET=", timeOffset);
    logStatus("Clock synced. Loading audio…");

    const resolve = clockSyncResolve;
    clockSyncResolve = null;
    resolve();
  } else if (clockSyncResolve) {
    sendPing();
  }
}

function getServerNow() {
  return Date.now() + timeOffset;
}

// --- AUDIO LOADING ---
async function loadAudio() {
  try {
    if (isIOS) {
      htmlAudio = new Audio("track.mp3");
      htmlAudio.preload = "auto";

      htmlAudio.addEventListener("canplaythrough", () => {
        audioLoaded = true;
        logStatus("Audio loaded. Enter family name & ARM.");
        updateArmButtonState();
      });

      htmlAudio.load();
    } else {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const res = await fetch("track.mp3");
      const arr = await res.arrayBuffer();
      audioBuffer = await audioCtx.decodeAudioData(arr);

      audioLoaded = true;
      logStatus("Audio loaded. Enter family name & ARM.");
      updateArmButtonState();
    }
  } catch (err) {
    logStatus("Audio load error: " + err.message);
  }
}

// --- SAVE FAMILY NAME ---
saveNameBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) return logStatus("Please enter family name.");

  clientName = name;
  hasName = true;
  logStatus(`Registered: ${clientName}. You may ARM once audio loads.`);

  updateArmButtonState();
  if (wsReady) sendNameRegistration();
});

function sendNameRegistration() {
  if (!wsReady) return;
  ws.send(JSON.stringify({ type: "register", name: clientName }));
}

// --- ARM BUTTON ---
armBtn.addEventListener("click", () => {
  if (!hasName) return;

  if (isIOS) {
    htmlAudio.play().then(() => {
      htmlAudio.pause();
      htmlAudio.currentTime = 0;
      finishArm();
    }).catch(() => logStatus("Tap ARM again to allow audio."));
  } else {
    if (audioCtx.state === "suspended") audioCtx.resume();
    finishArm();
  }
});

function finishArm() {
  armed = true;
  updateArmButtonState();
  if (serverStartTime) scheduleOrJoin();
  else logStatus("ARMED. Waiting for start…");
}

// --- START HANDLING ---
function handleStart(t) {
  serverStartTime = t;
  const now = getServerNow();
  const until = t - now;

  if (armed) scheduleOrJoin();
  else logStatus(
    until > 0
      ? "Start received. ARM now to join."
      : "Track already playing. ARM to join late."
  );
}

function handleLateJoin(t) {
  serverStartTime = t;
  if (armed) scheduleOrJoin();
  else logStatus("Music already playing. ARM to join.");
}

function scheduleOrJoin() {
  const now = getServerNow();
  const until = serverStartTime - now;

  if (isIOS) {
    if (until > 0) {
      setTimeout(() => htmlAudio.play(), until);
    } else {
      htmlAudio.currentTime = -until / 1000;
      htmlAudio.play();
    }
  } else {
    if (currentSource) {
      try { currentSource.stop(); } catch {}
    }

    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(audioCtx.destination);

    if (until > 0) {
      src.start(audioCtx.currentTime + until / 1000);
    } else {
      src.start(audioCtx.currentTime + 0.05, -until / 1000);
    }

    currentSource = src;
  }

  logStatus("Playing (synced).");
}

// --- STOP HANDLING ---
function handleStop() {
  if (isIOS) {
    if (htmlAudio) {
      htmlAudio.pause();
      htmlAudio.currentTime = 0;
    }
  } else {
    if (currentSource) {
      try { currentSource.stop(); } catch {}
      currentSource = null;
    }
  }

  armed = false;
  serverStartTime = null;
  updateArmButtonState();

  logStatus("Broadcast ended. ARM again for next track.");
}

// --- WEBSOCKET CONNECT ---
function connectWS() {
  ws = new WebSocket(getWSUrl());

  ws.onopen = () => {
    wsReady = true;
    ws.send(JSON.stringify({ type: "hello", role: "client" }));
    if (hasName) sendNameRegistration();

    logStatus("Syncing clock…");
    runClockSync().then(loadAudio);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "pong") handlePong(msg);
    if (msg.type === "start") handleStart(msg.serverStartTime);
    if (msg.type === "late-join") handleLateJoin(msg.serverStartTime);
    if (msg.type === "stop") handleStop();
  };
}

connectWS();
