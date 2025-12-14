let ws;
let tracks = {};
let state = { playing:false, trackId:null, startTime:null };

const audio = document.getElementById("iosPlayer");
const armBtn = document.getElementById("armBtn");
const pauseBtn = document.getElementById("pauseBtn");
const familyInput = document.getElementById("familyName");
const statusPill = document.getElementById("statusPill");
const nowPlayingPill = document.getElementById("nowPlayingPill");

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

let armed = false;
let locallyPaused = false;

let serverOffsetMs = 0;
let bestRttMs = Infinity;

let currentTrackId = null;
let scheduledTimer = null;

function setStatus(t, good=false){
  statusPill.textContent = "Status: " + t;
  statusPill.classList.remove("good","bad");
  statusPill.classList.add(good ? "good" : "bad");
}
function setNowPlaying(t){
  nowPlayingPill.textContent = "Now Playing: " + t;
}

function correctedNowMs(){ return Date.now() + serverOffsetMs; }
function expectedOffsetSec(startTimeMs){
  return Math.max(0, (correctedNowMs() - startTimeMs) / 1000);
}

function clearSchedule(){
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = null;
}

function hardStopUnload(){
  clearSchedule();
  try { audio.pause(); } catch {}
  audio.removeAttribute("src");
  audio.load();
  currentTrackId = null;
}

function stopButKeepSrc(){
  clearSchedule();
  try { audio.pause(); } catch {}
}

function ensureTrackLoaded(trackId){
  const t = tracks[trackId];
  if (!t) return false;

  // already loaded?
  if (currentTrackId === trackId && audio.src && audio.src.includes(encodeURI(t.file))) {
    return true;
  }

  stopButKeepSrc();
  audio.src = t.file;
  audio.load();
  currentTrackId = trackId;
  return true;
}

async function timeSyncOnce(){
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:"timeSync", clientSend: Date.now() }));
  }
}

// 🔥 iOS-safe: only hard resync if REALLY off
function driftThreshold(){
  return isIOS ? 1.2 : 0.35; // seconds
}
function driftLoopInterval(){
  return isIOS ? 3500 : 1200; // ms
}

// Start/sync playback to parade position
async function syncToParade(trackId, startTimeMs){
  if (!armed) return;
  if (!trackId || !startTimeMs) return;
  const t = tracks[trackId];
  if (!t) return;

  setNowPlaying(t.name);

  // If user paused locally, don’t force audio
  if (locallyPaused) {
    setStatus("Paused (tap PLAY to re-sync)", false);
    return;
  }

  ensureTrackLoaded(trackId);

  const delayMs = Math.round(startTimeMs - correctedNowMs());

  // Countdown start in the future
  if (delayMs > 0) {
    stopButKeepSrc();
    clearSchedule();
    setStatus(`Synced (starting in ${(delayMs/1000).toFixed(1)}s)`, true);

    scheduledTimer = setTimeout(async () => {
      if (!armed || locallyPaused) return;
      try {
        audio.currentTime = 0;
        await audio.play();
        setStatus("Playing (Synced)", true);
      } catch {
        setStatus("Tap PLAY (audio blocked)", false);
      }
    }, delayMs);

    return;
  }

  // Already started: seek into correct position
  const shouldBe = expectedOffsetSec(startTimeMs);

  try {
    const playing = !audio.paused;
    const actual = audio.currentTime || 0;
    const drift = Math.abs(actual - shouldBe);

    if (!playing) {
      // late join / coming back: jump right to correct place
      audio.currentTime = shouldBe;
      await audio.play();
      setStatus("Playing (Synced)", true);
      return;
    }

    // While playing:
    // - On iOS: avoid pause/play churn; only adjust if VERY off
    if (drift > driftThreshold()) {
      if (isIOS) {
        // iOS: do a single jump without restarting playback
        audio.currentTime = shouldBe;
        setStatus("Playing (Resynced)", true);
      } else {
        audio.pause();
        audio.currentTime = shouldBe;
        await audio.play();
        setStatus("Playing (Resynced)", true);
      }
    } else {
      setStatus("Playing (Synced)", true);
    }
  } catch {
    setStatus("Tap PLAY (audio blocked)", false);
  }
}

// Drift correction loop (gentle on iOS)
let driftTimer = null;
function startDriftLoop(){
  if (driftTimer) clearInterval(driftTimer);
  driftTimer = setInterval(async () => {
    if (!armed) return;
    if (locallyPaused) return;
    if (!state.playing || !state.trackId || !state.startTime) return;
    if (!ensureTrackLoaded(state.trackId)) return;
    if (audio.paused) return;

    const shouldBe = expectedOffsetSec(state.startTime);
    const actual = audio.currentTime || 0;
    const drift = actual - shouldBe;

    // Only correct if significantly off
    if (Math.abs(drift) > driftThreshold()) {
      try {
        if (isIOS) {
          // no pause/play
          audio.currentTime = shouldBe;
        } else {
          audio.pause();
          audio.currentTime = shouldBe;
          await audio.play();
        }
        setStatus("Playing (Resynced)", true);
      } catch {}
    }
  }, driftLoopInterval());
}
startDriftLoop();

// ARM
armBtn.onclick = async () => {
  const name = familyInput.value.trim();
  if (!name) {
    alert("Please enter your family name first.");
    familyInput.focus();
    return;
  }

  // register name for admin list
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type:"register", name }));
    }
  } catch {}

  armed = true;
  locallyPaused = false;
  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
  pauseBtn.textContent = "PAUSE";

  setStatus("Armed", false);

  // iOS unlock trick (safe if missing)
  try {
    audio.src = "chime.mp3";
    audio.currentTime = 0;
    await audio.play();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } catch {}

  await timeSyncOnce();

  // Late join guarantee
  if (state.playing && state.trackId && state.startTime) {
    await syncToParade(state.trackId, state.startTime);
  }
};

// Pause/Play button: PLAY = rejoin parade
pauseBtn.onclick = async () => {
  if (!armed) return;

  if (!locallyPaused) {
    locallyPaused = true;
    clearSchedule();
    try { audio.pause(); } catch {}
    pauseBtn.textContent = "PLAY";
    setStatus("Paused (tap PLAY to re-sync)", false);
    return;
  }

  locallyPaused = false;
  pauseBtn.textContent = "PAUSE";

  if (state.playing && state.trackId && state.startTime) {
    await syncToParade(state.trackId, state.startTime);
  } else {
    setStatus("Armed (waiting…)", false);
  }
};

// WebSocket
ws = new WebSocket(location.origin.replace(/^http/, "ws"));

ws.onopen = () => {
  ws.send(JSON.stringify({ type:"hello", role:"client" }));
  timeSyncOnce();
  setInterval(timeSyncOnce, 2000);
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
    return;
  }

  if (msg.type === "state") {
    state = msg.state || state;

    if (!state.playing) {
      setNowPlaying("—");
      setStatus(armed ? (locallyPaused ? "Paused" : "Armed") : "Not Armed", false);
      hardStopUnload();
      return;
    }

    if (!armed) {
      setStatus("Broadcast running — ARM to join", false);
      return;
    }

    await syncToParade(state.trackId, state.startTime);
    return;
  }

  if (msg.type === "play" || msg.type === "resync") {
    state.playing = true;
    state.trackId = msg.trackId;
    state.startTime = msg.startTime;

    if (!armed) {
      setStatus("Broadcast running — ARM to join", false);
      return;
    }

    await syncToParade(msg.trackId, msg.startTime);
    return;
  }

  if (msg.type === "stop") {
    state.playing = false;
    state.trackId = null;
    state.startTime = null;
    hardStopUnload();
    setNowPlaying("—");
    setStatus(armed ? (locallyPaused ? "Paused" : "Armed") : "Not Armed", false);
    return;
  }
};

setStatus("Not Armed", false);
setNowPlaying("—");
