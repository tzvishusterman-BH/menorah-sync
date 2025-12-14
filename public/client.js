let ws;
let tracks = {};
let state = { playing:false, paused:false, trackId:null, startTime:null };

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
  statusPill.style.borderColor = good ? "rgba(120,255,160,0.35)" : "rgba(255,255,255,0.14)";
}
function setNowPlaying(t){
  nowPlayingPill.textContent = "Now Playing: " + t;
}

function correctedNowMs(){ return Date.now() + serverOffsetMs; }
function expectedOffsetSec(startTimeMs){
  // ✅ NO iPhone bias; pure clock-based
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

async function timeSyncOnce(){
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:"timeSync", clientSend: Date.now() }));
  }
}

function waitAudioEvent(evt, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      audio.removeEventListener(evt, on);
      resolve(false);
    }, timeoutMs);
    function on() {
      clearTimeout(t);
      audio.removeEventListener(evt, on);
      resolve(true);
    }
    audio.addEventListener(evt, on, { once:true });
  });
}

async function ensureTrackReady(trackId){
  const t = tracks[trackId];
  if (!t) return false;

  const same = currentTrackId === trackId && audio.src && audio.src.includes(encodeURI(t.file));
  if (!same) {
    stopButKeepSrc();
    audio.src = t.file;
    audio.load();
    currentTrackId = trackId;
  }

  if (!Number.isFinite(audio.duration) || audio.duration === 0) {
    await waitAudioEvent("loadedmetadata", 3000);
  }
  return true;
}

function clampSeekSeconds(trackId, seconds){
  const t = tracks[trackId];
  const durMs = t?.duration;

  if (typeof durMs === "number" && durMs > 0) {
    const max = Math.max(0, (durMs/1000) - 0.25);
    return Math.min(Math.max(0, seconds), max);
  }
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    const max = Math.max(0, audio.duration - 0.25);
    return Math.min(Math.max(0, seconds), max);
  }
  return Math.max(0, seconds);
}

async function seekReliable(trackId, seconds){
  const ok = await ensureTrackReady(trackId);
  if (!ok) return false;

  const target = clampSeekSeconds(trackId, seconds);
  try { audio.currentTime = target; } catch { return false; }
  await waitAudioEvent("seeked", 1200);
  return true;
}

function driftThreshold(){ return isIOS ? 1.2 : 0.35; }
function driftLoopInterval(){ return isIOS ? 3500 : 1200; }

async function syncToParade(trackId, startTimeMs){
  if (!armed) return;
  if (!trackId || !startTimeMs) return;
  const t = tracks[trackId];
  if (!t) return;

  setNowPlaying(t.name);

  if (state.paused) {
    try { audio.pause(); } catch {}
    setStatus("Paused (Admin)", false);
    return;
  }
  if (locallyPaused) {
    setStatus("Paused (tap PLAY to re-sync)", false);
    return;
  }

  const delayMs = Math.round(startTimeMs - correctedNowMs());

  // If it truly hasn't started yet -> schedule start at 0
  if (delayMs > 0) {
    stopButKeepSrc();
    clearSchedule();
    setStatus(`Synced (starting in ${(delayMs/1000).toFixed(1)}s)`, true);

    scheduledTimer = setTimeout(async () => {
      if (!armed || locallyPaused || state.paused) return;

      await ensureTrackReady(trackId);
      try { audio.currentTime = 0; } catch {}

      try {
        await audio.play();
        setStatus("Playing (Synced)", true);
      } catch {
        setStatus("Tap PLAY (audio blocked)", false);
      }
    }, delayMs);

    return;
  }

  // Started already (including resume): seek into correct position and play
  const shouldBe = expectedOffsetSec(startTimeMs);
  await seekReliable(trackId, shouldBe);

  try {
    const playing = !audio.paused;
    if (!playing) {
      await audio.play();
    }
    setStatus("Playing (Synced)", true);
  } catch {
    setStatus("Tap PLAY (audio blocked)", false);
  }
}

// drift correction loop (gentle on iOS)
let driftTimer = null;
function startDriftLoop(){
  if (driftTimer) clearInterval(driftTimer);
  driftTimer = setInterval(async () => {
    if (!armed) return;
    if (locallyPaused) return;
    if (state.paused) return;
    if (!state.playing || !state.trackId || !state.startTime) return;
    if (audio.paused) return;

    const shouldBe = expectedOffsetSec(state.startTime);
    const target = clampSeekSeconds(state.trackId, shouldBe);
    const actual = audio.currentTime || 0;
    const drift = actual - target;

    if (Math.abs(drift) > driftThreshold()) {
      try {
        if (!isIOS) audio.pause();
        await seekReliable(state.trackId, shouldBe);
        if (!isIOS) await audio.play();
        setStatus("Playing (Resynced)", true);
      } catch {}
    }
  }, driftLoopInterval());
}
startDriftLoop();

armBtn.onclick = async () => {
  const name = familyInput.value.trim();
  if (!name) {
    alert("Please enter your family name first.");
    familyInput.focus();
    return;
  }

  // iOS unlock (also okay on Android)
  try {
    audio.src = "chime.mp3";
    audio.currentTime = 0;
    await audio.play();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    currentTrackId = null;
  } catch {}

  // register name for admin list
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type:"register", name }));
    }
  } catch {}

  armed = true;
  locallyPaused = false;
  armBtn.style.display = "none";
  pauseBtn.style.display = "block";
  pauseBtn.textContent = "PAUSE";
  setStatus("Armed", false);

  await timeSyncOnce();

  if (state.playing && state.trackId && state.startTime && !state.paused) {
    await syncToParade(state.trackId, state.startTime);
  }
};

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

  if (state.playing && state.trackId && state.startTime && !state.paused) {
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

  if (msg.type === "preload") {
    const t = tracks[msg.trackId];
    if (t) {
      try {
        const a = new Audio();
        a.preload = "auto";
        a.src = t.file;
        a.load();
      } catch {}
    }
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

    if (state.paused) {
      clearSchedule();
      try { audio.pause(); } catch {}
      setStatus("Paused (Admin)", false);
      return;
    }

    if (!armed) {
      setStatus("Broadcast running — ARM to join", false);
      return;
    }

    await syncToParade(state.trackId, state.startTime);
    return;
  }

  if (msg.type === "pause") {
    state.paused = true;
    clearSchedule();
    try { audio.pause(); } catch {}
    setStatus("Paused (Admin)", false);
    return;
  }

  if (msg.type === "play") {
    state.playing = true;
    state.paused = false;
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
    state.paused = false;
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
