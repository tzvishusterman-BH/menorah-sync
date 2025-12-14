let ws;
let tracks = {};
let armed = false;

let state = { playing:false, trackId:null, startTime:null };

const audio = document.getElementById("iosPlayer");
const armBtn = document.getElementById("armBtn");
const pauseBtn = document.getElementById("pauseBtn");
const familyInput = document.getElementById("familyName");
const statusPill = document.getElementById("statusPill");
const nowPlayingPill = document.getElementById("nowPlayingPill");

// ----- server clock (preset clock) -----
let serverOffsetMs = 0;
let bestRttMs = Infinity;

function correctedNowMs(){ return Date.now() + serverOffsetMs; }
function expectedOffsetSec(startTimeMs){
  return Math.max(0, (correctedNowMs() - startTimeMs) / 1000);
}

function timeSyncOnce(){
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:"timeSync", clientSend: Date.now() }));
  }
}

// ----- UI helpers -----
function setStatus(t){ statusPill.textContent = "Status: " + t; }
function setNowPlaying(t){ nowPlayingPill.textContent = "Now Playing: " + t; }

// ----- local flags -----
let locallyPaused = false;
let currentTrackId = null;   // what we currently have loaded
let scheduledTimer = null;   // for countdown starts

function clearSchedule(){
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = null;
}

function stopEverything(){
  clearSchedule();
  try { audio.pause(); } catch {}
  // do NOT always clear src here; only when changing tracks or stopping broadcast
}

function hardStopAndUnload(){
  clearSchedule();
  try { audio.pause(); } catch {}
  audio.removeAttribute("src");
  audio.load();
  currentTrackId = null;
}

function ensureTrackLoaded(trackId){
  const t = tracks[trackId];
  if (!t) return false;

  // If already loaded, do nothing
  if (currentTrackId === trackId && audio.src && audio.src.includes(encodeURI(t.file))) {
    return true;
  }

  // Load fresh track
  stopEverything();
  audio.src = t.file;
  audio.load();
  currentTrackId = trackId;
  return true;
}

// Core: “join the parade NOW” (or schedule if start is in future)
async function syncPlayNow(trackId, startTimeMs){
  if (!armed) return;
  if (!trackId || !startTimeMs) return;

  const t = tracks[trackId];
  if (!t) return;

  setNowPlaying(t.name);

  // If locally paused, we only resync when they press PLAY (below)
  if (locallyPaused) {
    setStatus("Paused (tap Play to re-sync)");
    return;
  }

  // load track if needed
  ensureTrackLoaded(trackId);

  const delayMs = Math.round(startTimeMs - correctedNowMs());

  if (delayMs > 0) {
    // Countdown start in the future
    setStatus(`Synced (starting in ${(delayMs/1000).toFixed(1)}s)`);
    stopEverything();
    clearSchedule();

    scheduledTimer = setTimeout(async () => {
      if (!armed || locallyPaused) return;
      try {
        audio.currentTime = 0;
        await audio.play();
        setStatus("Playing (Synced)");
      } catch {
        setStatus("Tap Play (audio blocked)");
      }
    }, delayMs);

    return;
  }

  // Already started: jump into correct position
  const shouldBe = expectedOffsetSec(startTimeMs);

  try {
    // If we are already playing, only correct if drift is large
    const isPlaying = !audio.paused;
    const actual = audio.currentTime || 0;
    const drift = Math.abs(actual - shouldBe);

    if (!isPlaying) {
      audio.currentTime = shouldBe;
      await audio.play();
      setStatus("Playing (Synced)");
      return;
    }

    // While playing: snap back only if needed
    if (drift > 0.35) {
      // iOS is happier if we pause before seeking
      audio.pause();
      audio.currentTime = shouldBe;
      await audio.play();
      setStatus("Playing (Resynced)");
    } else {
      setStatus("Playing (Synced)");
    }
  } catch {
    setStatus("Tap Play (audio blocked)");
  }
}

// Drift correction loop (this is what makes sync “way better”)
setInterval(async () => {
  if (!armed) return;
  if (locallyPaused) return;
  if (!state.playing || !state.trackId || !state.startTime) return;

  // if not loaded right track yet, try
  if (!ensureTrackLoaded(state.trackId)) return;

  // Only correct if audio is actually playing
  if (audio.paused) return;

  const shouldBe = expectedOffsetSec(state.startTime);
  const actual = audio.currentTime || 0;
  const drift = actual - shouldBe;

  // If drift is more than 450ms, resync gently
  if (Math.abs(drift) > 0.45) {
    try {
      audio.pause();
      audio.currentTime = shouldBe;
      await audio.play();
      setStatus("Playing (Resynced)");
    } catch {}
  }
}, 1200);

// ----- ARM -----
armBtn.onclick = async () => {
  const name = familyInput.value.trim();
  if (!name) { alert("Enter family name first"); return; }

  armed = true;
  locallyPaused = false;

  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
  pauseBtn.textContent = "PAUSE";
  setStatus("Armed");

  // iOS unlock trick (chime.mp3)
  try {
    audio.src = "chime.mp3";
    audio.currentTime = 0;
    await audio.play();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } catch {}

  // Start clock sync
  timeSyncOnce();

  // If parade already playing, join immediately
  if (state.playing && state.trackId && state.startTime) {
    await syncPlayNow(state.trackId, state.startTime);
  }
};

// ----- Pause/Play button behavior (THIS is your question) -----
// Pause: local pause
// Play: NOT resume. It *rejoins* the parade at correct timestamp.
pauseBtn.onclick = async () => {
  if (!armed) return;

  if (!locallyPaused) {
    locallyPaused = true;
    clearSchedule();
    try { audio.pause(); } catch {}
    pauseBtn.textContent = "PLAY";
    setStatus("Paused (tap Play to re-sync)");
    return;
  }

  // PLAY (re-sync)
  locallyPaused = false;
  pauseBtn.textContent = "PAUSE";

  if (state.playing && state.trackId && state.startTime) {
    await syncPlayNow(state.trackId, state.startTime);
  } else {
    setStatus("Armed (waiting…)");
  }
};

// ----- WebSocket -----
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
      setStatus(armed ? (locallyPaused ? "Paused" : "Armed") : "Not Armed");
      hardStopAndUnload();
      return;
    }

    // if armed and not locally paused, keep synced
    if (armed) {
      await syncPlayNow(state.trackId, state.startTime);
    } else {
      setStatus("Broadcast running — ARM to join");
    }
    return;
  }

  if (msg.type === "play") {
    state.playing = true;
    state.trackId = msg.trackId;
    state.startTime = msg.startTime;

    if (armed) {
      await syncPlayNow(msg.trackId, msg.startTime);
    } else {
      setStatus("Broadcast running — ARM to join");
    }
    return;
  }

  if (msg.type === "stop") {
    state.playing = false;
    state.trackId = null;
    state.startTime = null;
    hardStopAndUnload();
    setNowPlaying("—");
    setStatus(armed ? (locallyPaused ? "Paused" : "Armed") : "Not Armed");
    return;
  }
};

setStatus("Not Armed");
setNowPlaying("—");
