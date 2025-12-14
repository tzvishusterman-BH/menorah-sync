let ws;
let tracks = {};
let state = { playing:false, trackId:null, startTime:null };

const audio = document.getElementById("iosPlayer");
const armBtn = document.getElementById("armBtn");
const pauseBtn = document.getElementById("pauseBtn");
const familyInput = document.getElementById("familyName");
const statusPill = document.getElementById("statusPill");
const nowPlayingPill = document.getElementById("nowPlayingPill");

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

// Start/sync playback to the parade position
async function syncToParade(trackId, startTimeMs){
  if (!armed) return;
  if (!trackId || !startTimeMs) return;
  const t = tracks[trackId];
  if (!t) return;

  setNowPlaying(t.name);

  // If user paused locally, don’t force audio; just show status
  if (locallyPaused) {
    setStatus("Paused (tap PLAY to re-sync)", false);
    return;
  }

  ensureTrackLoaded(trackId);

  const delayMs = Math.round(startTimeMs - correctedNowMs());

  // Countdown start (future)
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

    // If not playing, start at correct point
    if (!playing) {
      audio.currentTime = shouldBe;
      await audio.play();
      setStatus("Playing (Synced)", true);
      return;
    }

    // If playing but drift large, snap back
    if (drift > 0.35) {
      audio.pause();
      audio.currentTime = shouldBe;
      await audio.play();
      setStatus("Playing (Resynced)", true);
    } else {
      setStatus("Playing (Synced)", true);
    }
  } catch {
    setStatus("Tap PLAY (audio blocked)", false);
  }
}

// Drift correction loop (keeps “last week” tightness)
setInterval(async () => {
  if (!armed) return;
  if (locallyPaused) return;
  if (!state.playing || !state.trackId || !state.startTime) return;
  if (!ensureTrackLoaded(state.trackId)) return;
  if (audio.paused) return;

  const shouldBe = expectedOffsetSec(state.startTime);
  const actual = audio.currentTime || 0;
  const drift = actual - shouldBe;

  if (Math.abs(drift) > 0.45) {
    try {
      audio.pause();
      audio.currentTime = shouldBe;
      await audio.play();
      setStatus("Playing (Resynced)", true);
    } catch {}
  }
}, 1200);

// ARM
armBtn.onclick = async () => {
  const name = familyInput.value.trim();
  if (!name) {
    alert("Please enter your family name first.");
    familyInput.focus();
    return;
  }

  // register name (for admin list)
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

  // iOS unlock trick (uses your chime.mp3 if present; safe if missing)
  try {
    audio.src = "chime.mp3";
    audio.currentTime = 0;
    await audio.play();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } catch {}

  // Kick time sync once
  await timeSyncOnce();

  // Late join guarantee: if something is playing, sync immediately
  if (state.playing && state.trackId && state.startTime) {
    await syncToParade(state.trackId, state.startTime);
  }
};

// Pause/Play button: PLAY = REJOIN PARADE (not local resume)
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

    // Broadcast running
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
