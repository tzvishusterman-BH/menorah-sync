let ws;
let armed = false;
let locallyPaused = false;

let tracks = {};
let state = { playing:false, trackId:null, startTime:null };

// Detect iOS (Safari/Chrome on iPhone)
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

// UI
const armBtn = document.getElementById("armBtn");
const pauseBtn = document.getElementById("pauseBtn");
const familyInput = document.getElementById("familyName");
const statusPill = document.getElementById("statusPill");
const nowPlayingPill = document.getElementById("nowPlayingPill");

// iOS player
const iosPlayer = document.getElementById("iosPlayer");

// WebAudio (non-iOS)
let audioCtx = null;
let source = null;
let bufferCache = {};
let currentlyPlayingTrackId = null;
let currentlyPlayingStartTime = null; // server startTime ms
let startedAtAudioCtxTime = null;
let startedAtTrackOffsetSec = 0;

// ==========================
// CLOCK SYNC (IMPORTANT)
// ==========================
// serverOffsetMs = (serverTime - localTime) estimate
let serverOffsetMs = 0;
let bestRttMs = Infinity;
let timeSyncInterval = null;

function correctedNowMs() {
  // Our best estimate of server time on this device
  return Date.now() + serverOffsetMs;
}

function startTimeSyncLoop() {
  // Sync fast at first, then settle
  if (timeSyncInterval) clearInterval(timeSyncInterval);

  // Do a quick burst
  timeSyncOnce();
  setTimeout(timeSyncOnce, 400);
  setTimeout(timeSyncOnce, 900);

  // Then keep updating every 5 seconds while page is open
  timeSyncInterval = setInterval(timeSyncOnce, 5000);
}

function timeSyncOnce() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "timeSync", clientSend: Date.now() }));
}

// ==========================
// UI helpers
// ==========================
function setStatus(text, good){
  statusPill.textContent = `Status: ${text}`;
  statusPill.classList.remove("good","bad");
  statusPill.classList.add(good ? "good" : "bad");
}
function setNowPlaying(text){
  nowPlayingPill.textContent = `Now Playing: ${text}`;
}
function updateArmEnabled(){
  armBtn.disabled = familyInput.value.trim().length === 0;
}
familyInput.addEventListener("input", updateArmEnabled);
updateArmEnabled();

// ==========================
// Shared time math
// ==========================
function expectedOffsetSec(serverStartTimeMs){
  // Use server-synced clock, NOT Date.now()
  return Math.max(0, (correctedNowMs() - serverStartTimeMs) / 1000);
}

// =========================
// iOS Native Audio Path
// =========================
function iosStop(){
  try { iosPlayer.pause(); } catch {}
  iosPlayer.removeAttribute("src");
  iosPlayer.load();
}

async function iosPlaySynced(trackId, serverStartTimeMs){
  if (!armed || locallyPaused) return;

  const t = tracks[trackId];
  setNowPlaying(t ? t.name : trackId);

  const offset = expectedOffsetSec(serverStartTimeMs);

  // If already playing same track, don’t restart unless drift > 0.6s
  if (
    iosPlayer.src &&
    currentlyPlayingTrackId === trackId &&
    currentlyPlayingStartTime === serverStartTimeMs &&
    !iosPlayer.paused
  ) {
    const drift = Math.abs((iosPlayer.currentTime || 0) - offset);
    if (drift < 0.6) {
      setStatus("Synced", true);
      return;
    }
  }

  currentlyPlayingTrackId = trackId;
  currentlyPlayingStartTime = serverStartTimeMs;

  iosPlayer.src = t.file;
  iosPlayer.currentTime = offset;

  try {
    await iosPlayer.play();
    setStatus("Synced", true);
    pauseBtn.textContent = "PAUSE";
  } catch (e) {
    console.error("iOS play blocked:", e);
    setStatus("Tap PLAY (iOS audio blocked)", false);
  }
}

// =========================
// Non-iOS WebAudio Path
// =========================
function webStop(){
  try { if (source) source.stop(); } catch {}
  source = null;
  startedAtAudioCtxTime = null;
  startedAtTrackOffsetSec = 0;
  currentlyPlayingTrackId = null;
  currentlyPlayingStartTime = null;
}

async function webLoadBuffer(trackId){
  if (bufferCache[trackId]) return bufferCache[trackId];
  const t = tracks[trackId];
  const resp = await fetch(t.file, { cache:"no-store" });
  const arr = await resp.arrayBuffer();
  const buf = await audioCtx.decodeAudioData(arr);
  bufferCache[trackId] = buf;
  return buf;
}

function webActualOffsetSec(){
  if (!audioCtx || startedAtAudioCtxTime == null) return null;
  const elapsed = audioCtx.currentTime - startedAtAudioCtxTime;
  return Math.max(0, startedAtTrackOffsetSec + elapsed);
}

async function webEnsurePlayingSynced(trackId, serverStartTimeMs){
  if (!armed || !audioCtx || locallyPaused) return;

  const t = tracks[trackId];
  setNowPlaying(t ? t.name : trackId);

  const shouldBeSec = expectedOffsetSec(serverStartTimeMs);

  // Avoid restarts unless drift > 0.6s
  if (source && currentlyPlayingTrackId === trackId && currentlyPlayingStartTime === serverStartTimeMs) {
    const isSec = webActualOffsetSec();
    if (isSec != null) {
      const drift = Math.abs(isSec - shouldBeSec);
      if (drift < 0.6) { setStatus("Synced", true); return; }
    } else { setStatus("Synced", true); return; }
  }

  const buf = await webLoadBuffer(trackId);

  webStop();

  source = audioCtx.createBufferSource();
  source.buffer = buf;
  source.connect(audioCtx.destination);

  source.start(0, shouldBeSec);

  startedAtAudioCtxTime = audioCtx.currentTime;
  startedAtTrackOffsetSec = shouldBeSec;
  currentlyPlayingTrackId = trackId;
  currentlyPlayingStartTime = serverStartTimeMs;

  setStatus("Synced", true);
  pauseBtn.textContent = "PAUSE";
}

// =========================
// Controls
// =========================
pauseBtn.addEventListener("click", async () => {
  if (!armed) return;

  if (!locallyPaused) {
    locallyPaused = true;
    if (isIOS) iosStop(); else webStop();
    setStatus("Paused (tap Play to re-sync)", false);
    pauseBtn.textContent = "PLAY";
    return;
  }

  locallyPaused = false;
  pauseBtn.textContent = "PAUSE";

  if (state.playing && state.trackId && state.startTime) {
    if (isIOS) await iosPlaySynced(state.trackId, state.startTime);
    else await webEnsurePlayingSynced(state.trackId, state.startTime);
  } else {
    setStatus("Armed (waiting…)", false);
  }
});

armBtn.addEventListener("click", async () => {
  const name = familyInput.value.trim();
  if (!name) return;

  ws.send(JSON.stringify({ type:"register", name }));

  armed = true;
  locallyPaused = false;

  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
  setStatus("Armed (loading…)", false);

  // Start clock sync loop now that user interacted
  startTimeSyncLoop();

  if (isIOS) {
    // iOS unlock trick using your chime.mp3
    try {
      iosPlayer.src = "chime.mp3";
      iosPlayer.currentTime = 0;
      await iosPlayer.play();
      iosPlayer.pause();
      iosPlayer.removeAttribute("src");
      iosPlayer.load();
    } catch {}
  } else {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
    await audioCtx.resume();
  }

  setStatus("Armed (waiting…)", false);

  // Join immediately if broadcast running
  if (state.playing && state.trackId && state.startTime) {
    if (isIOS) await iosPlaySynced(state.trackId, state.startTime);
    else await webEnsurePlayingSynced(state.trackId, state.startTime);
  }
});

// =========================
// WebSocket
// =========================
function init(){
  ws = new WebSocket(location.origin.replace(/^http/, "ws"));

  ws.onopen = () => {
    ws.send(JSON.stringify({ type:"hello", role:"client" }));
    // Start syncing even before ARM; it helps display and readiness.
    // (No audio starts until ARM)
    startTimeSyncLoop();
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "timeSync") {
      // Compute offset using round-trip time
      const clientReceive = Date.now();
      const clientSend = msg.clientSend;
      const serverTime = msg.serverTime;

      const rtt = clientReceive - clientSend;
      const approxServerAtReceive = serverTime + (rtt / 2);
      const newOffset = approxServerAtReceive - clientReceive;

      // Keep the best (lowest RTT) estimate; it’s the cleanest
      if (rtt < bestRttMs) {
        bestRttMs = rtt;
        serverOffsetMs = newOffset;
      } else {
        // Gentle smoothing so it doesn’t jump
        serverOffsetMs = serverOffsetMs * 0.9 + newOffset * 0.1;
      }
      return;
    }

    if (msg.type === "tracks") { tracks = msg.tracks || {}; return; }

    if (msg.type === "state") {
      state = msg.state || state;

      if (!state.playing || !state.trackId) {
        setNowPlaying("—");
        if (armed && !locallyPaused) setStatus("Armed (waiting…)", false);
        if (!armed) setStatus("Not Armed", false);
        if (isIOS) iosStop(); else webStop();
        return;
      }

      if (armed && !locallyPaused && state.startTime) {
        if (isIOS) await iosPlaySynced(state.trackId, state.startTime);
        else await webEnsurePlayingSynced(state.trackId, state.startTime);
      } else {
        const t = tracks[state.trackId];
        setNowPlaying(t ? t.name : state.trackId);
        if (!armed) setStatus("Broadcast running — ARM to join", false);
      }
      return;
    }

    if (msg.type === "play") {
      state.playing = true;
      state.trackId = msg.trackId;
      state.startTime = msg.startTime;

      if (armed && !locallyPaused) {
        if (isIOS) await iosPlaySynced(msg.trackId, msg.startTime);
        else {
          try { await webLoadBuffer(msg.trackId); } catch {}
          await webEnsurePlayingSynced(msg.trackId, msg.startTime);
        }
      } else {
        const t = tracks[msg.trackId];
        setNowPlaying(t ? t.name : msg.trackId);
        if (!armed) setStatus("Broadcast running — ARM to join", false);
      }
      return;
    }

    if (msg.type === "stop") {
      state.playing = false;
      state.trackId = null;
      state.startTime = null;
      if (isIOS) iosStop(); else webStop();
      setNowPlaying("—");
      if (armed) setStatus(locallyPaused ? "Paused" : "Armed (waiting…)", false);
      else setStatus("Not Armed", false);
      return;
    }
  };

  ws.onclose = () => {
    if (isIOS) iosStop(); else webStop();
    setStatus("Disconnected (refresh page)", false);
  };
}

setStatus("Not Armed", false);
setNowPlaying("—");
init();
