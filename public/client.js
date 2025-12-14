let ws;
let audioCtx = null;
let armed = false;

let tracks = {};
let state = { playing:false, trackId:null, startTime:null };

let source = null;
let bufferCache = {}; // trackId -> AudioBuffer
let locallyPaused = false;

// Playback tracking (IMPORTANT)
let currentlyPlayingTrackId = null;
let currentlyPlayingStartTime = null;   // server timestamp (ms)
let startedAtAudioCtxTime = null;       // audioCtx.currentTime when we started
let startedAtTrackOffsetSec = 0;        // the offsetSec we started at

const armBtn = document.getElementById("armBtn");
const pauseBtn = document.getElementById("pauseBtn");
const familyInput = document.getElementById("familyName");
const statusPill = document.getElementById("statusPill");
const nowPlayingPill = document.getElementById("nowPlayingPill");

function setStatus(text, good){
  statusPill.textContent = `Status: ${text}`;
  statusPill.classList.remove("good","bad");
  statusPill.classList.add(good ? "good" : "bad");
}

function setNowPlaying(text){
  nowPlayingPill.textContent = `Now Playing: ${text}`;
}

function stopAudio(){
  try { if (source) source.stop(); } catch {}
  source = null;

  startedAtAudioCtxTime = null;
  startedAtTrackOffsetSec = 0;
  currentlyPlayingTrackId = null;
  currentlyPlayingStartTime = null;
}

async function loadBuffer(trackId){
  if (bufferCache[trackId]) return bufferCache[trackId];

  const t = tracks[trackId];
  if (!t) throw new Error("Unknown trackId " + trackId);

  const resp = await fetch(t.file, { cache:"no-store" });
  const arr = await resp.arrayBuffer();
  const buf = await audioCtx.decodeAudioData(arr);
  bufferCache[trackId] = buf;
  return buf;
}

function expectedOffsetSec(serverStartTimeMs){
  return Math.max(0, (Date.now() - serverStartTimeMs) / 1000);
}

// Real current position in track = initialOffset + elapsed
function actualOffsetSec(){
  if (!audioCtx || startedAtAudioCtxTime == null) return null;
  const elapsed = audioCtx.currentTime - startedAtAudioCtxTime;
  return Math.max(0, startedAtTrackOffsetSec + elapsed);
}

/**
 * Start (or keep) playback synced.
 * Only restarts if:
 *  - track changes
 *  - startTime changes
 *  - OR drift is REALLY large
 */
async function ensurePlayingSynced(trackId, serverStartTimeMs){
  if (!armed || !audioCtx) return;
  if (locallyPaused) return;

  const t = tracks[trackId];
  setNowPlaying(t ? t.name : trackId);

  const shouldBeSec = expectedOffsetSec(serverStartTimeMs);

  // If we are already playing the same session, avoid restart unless drift is big
  if (
    source &&
    currentlyPlayingTrackId === trackId &&
    currentlyPlayingStartTime === serverStartTimeMs
  ) {
    const isSec = actualOffsetSec();
    if (isSec != null) {
      const drift = Math.abs(isSec - shouldBeSec);

      // ✅ MUCH less aggressive drift correction:
      // if drift < 0.8s, do nothing (prevents choppy restarts)
      if (drift < 0.8) {
        setStatus("Synced", true);
        return;
      }
      // Otherwise we’ll resync once below
    } else {
      // If we can't measure, don't restart
      setStatus("Synced", true);
      return;
    }
  }

  // Load audio (prevents decode lag)
  const buf = await loadBuffer(trackId);

  // Hard resync (rare)
  stopAudio();

  const startAt = shouldBeSec;

  source = audioCtx.createBufferSource();
  source.buffer = buf;
  source.connect(audioCtx.destination);

  try{
    source.start(0, startAt);

    startedAtAudioCtxTime = audioCtx.currentTime;
    startedAtTrackOffsetSec = startAt;

    currentlyPlayingTrackId = trackId;
    currentlyPlayingStartTime = serverStartTimeMs;

    setStatus("Synced", true);
    pauseBtn.textContent = "PAUSE";
  }catch(e){
    console.error(e);
    setStatus("Audio Error", false);
  }
}

function updateArmEnabled(){
  armBtn.disabled = familyInput.value.trim().length === 0;
}
familyInput.addEventListener("input", updateArmEnabled);
updateArmEnabled();

pauseBtn.addEventListener("click", async () => {
  if (!armed || !audioCtx) return;

  if (!locallyPaused) {
    locallyPaused = true;
    stopAudio();
    setStatus("Paused (tap Play to re-sync)", false);
    pauseBtn.textContent = "PLAY";
    return;
  }

  locallyPaused = false;
  pauseBtn.textContent = "PAUSE";

  if (state.playing && state.trackId && state.startTime) {
    await ensurePlayingSynced(state.trackId, state.startTime);
  } else {
    setStatus("Armed (waiting…)", false);
  }
});

armBtn.addEventListener("click", async () => {
  const name = familyInput.value.trim();
  if (!name) return;

  ws.send(JSON.stringify({ type:"register", name }));

  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });
  await audioCtx.resume();

  armed = true;
  locallyPaused = false;

  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";

  setStatus("Armed (loading…)", false);

  // Preload current track (helps reduce start glitches)
  if (state.playing && state.trackId) {
    try { await loadBuffer(state.trackId); } catch {}
  }

  setStatus("Armed (waiting…)", false);

  if (state.playing && state.trackId && state.startTime) {
    await ensurePlayingSynced(state.trackId, state.startTime);
  }
});

function init(){
  ws = new WebSocket(location.origin.replace(/^http/, "ws"));

  ws.onopen = () => ws.send(JSON.stringify({ type:"hello", role:"client" }));

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "tracks") {
      tracks = msg.tracks || {};
      return;
    }

    if (msg.type === "state") {
      state = msg.state || state;

      if (!state.playing || !state.trackId) {
        setNowPlaying("—");
        if (armed && !locallyPaused) setStatus("Armed (waiting…)", false);
        if (!armed) setStatus("Not Armed", false);
        stopAudio();
        return;
      }

      if (armed && !locallyPaused && state.startTime) {
        await ensurePlayingSynced(state.trackId, state.startTime);
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
        try { await loadBuffer(msg.trackId); } catch {}
        await ensurePlayingSynced(msg.trackId, msg.startTime);
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
      stopAudio();
      setNowPlaying("—");
      if (armed) setStatus(locallyPaused ? "Paused" : "Armed (waiting…)", false);
      else setStatus("Not Armed", false);
      return;
    }
  };

  ws.onclose = () => {
    stopAudio();
    setStatus("Disconnected (refresh page)", false);
  };
}

setStatus("Not Armed", false);
setNowPlaying("—");
init();
