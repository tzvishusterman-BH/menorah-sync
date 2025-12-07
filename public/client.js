// CLIENT (listener) script

let ws;
let audioCtx;
let audioBuffer = null;
let timeOffset = 0; // serverTime - clientTime (ms)
let armed = false;

const statusEl = document.getElementById("status");
const armBtn = document.getElementById("armBtn");

function logStatus(msg) {
  console.log(msg);
  statusEl.textContent = msg;
}

function getWSUrl() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}`;
}

function connectWS() {
  ws = new WebSocket(getWSUrl());

  ws.onopen = () => {
    console.log("WebSocket opened");
    ws.send(JSON.stringify({ type: "hello", role: "client" }));
    logStatus("Connected. Syncing clock…");
    runClockSync().then(() => {
      logStatus("Clock synced. Loading audio…");
      loadAudio();
    });
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "pong") {
      handlePong(msg);
    }
    if (msg.type === "start") {
      handleStart(msg.serverStartTime);
    }
  };

  ws.onclose = () => {
    logStatus("Disconnected from server. Refresh if needed.");
  };

  ws.onerror = (err) => {
    console.error("WebSocket error", err);
  };
}

// CLOCK SYNC

let pendingPings = [];
let clockSyncResolve;

function runClockSync(samples = 10) {
  return new Promise((resolve) => {
    clockSyncResolve = resolve;
    window._offsetSamples = [];
    for (let i = 0; i < samples; i++) {
      sendPing();
    }
  });
}

function sendPing() {
  const clientSendTime = Date.now();
  pendingPings.push(clientSendTime);
  ws.send(JSON.stringify({ type: "ping", clientSendTime }));
}

function handlePong(msg) {
  const { clientSendTime, serverTime } = msg;
  const idx = pendingPings.indexOf(clientSendTime);
  if (idx === -1) return; // not found / already processed

  pendingPings.splice(idx, 1);

  const clientRecvTime = Date.now();
  const rtt = clientRecvTime - clientSendTime;
  const clientMid = clientSendTime + rtt / 2;
  const offsetSample = serverTime - clientMid;

  window._offsetSamples.push({ rtt, offsetSample });

  // When we have enough samples, compute offset
  if (window._offsetSamples.length >= 10 && clockSyncResolve) {
    const sorted = window._offsetSamples.sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.ceil(sorted.length / 2));
    timeOffset =
      best.reduce((sum, s) => sum + s.offsetSample, 0) / best.length;

    console.log("Time offset (server - client):", timeOffset, "ms");
    logStatus("Clock synced (~" + Math.round(timeOffset) + " ms offset).");
    clockSyncResolve();
    clockSyncResolve = null;
  } else if (clockSyncResolve) {
    // Request another ping until we hit the sample count
    sendPing();
  }
}

function getServerNow() {
  // clientTime + offset
  return Date.now() + timeOffset;
}

// AUDIO

async function loadAudio() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const res = await fetch("track.mp3");
    if (!res.ok) {
      throw new Error("Failed to fetch track.mp3");
    }
    const arrayBuffer = await res.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    logStatus("Audio loaded. Tap ARM when ready.");
    armBtn.disabled = false;
  } catch (err) {
    console.error("Error loading audio:", err);
    logStatus("Error loading audio: " + err.message);
  }
}

armBtn.addEventListener("click", () => {
  if (!audioCtx) return;

  // Needed for mobile autoplay restrictions
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }

  armed = true;
  armBtn.disabled = true;
  logStatus("Armed. Waiting for start signal…");
});

function handleStart(serverStartTime) {
  if (!armed) {
    logStatus("Received start, but audio is not armed. Please reload.");
    return;
  }
  if (!audioBuffer) {
    logStatus("Received start, but audio not loaded yet.");
    return;
  }

  const serverNow = getServerNow();
  const msUntilStart = serverStartTime - serverNow;

  if (msUntilStart < 0) {
    logStatus("Start time already passed (" + msUntilStart + " ms).");
    return;
  }

  const secondsUntilStart = msUntilStart / 1000;
  const when = audioCtx.currentTime + secondsUntilStart;

  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioCtx.destination);
  source.start(when);

  logStatus(
    "Music scheduled to start in " + Math.round(msUntilStart) + " ms."
  );

  console.log("Scheduling start at audioCtx.currentTime +", secondsUntilStart);
}

connectWS();
