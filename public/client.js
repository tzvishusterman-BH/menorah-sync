let ws;
let audioCtx = null;
let armed = false;

let tracks = {};
let state = { playing:false, trackId:null, startTime:null };

let source = null;
let bufferCache = {}; // trackId -> AudioBuffer

let locallyPaused = false;

// These are the key anti-chop guards:
let currentlyPlayingTrackId = null;
let currentlyPlayingStartTime = null;
let startedAtAudioCtxTime = null;

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

function getExpectedOffsetSec(serverStartTime){
  return Math.max(0, (Date.now() - serverStartTime) / 1000);
}

function getCurrentPlaybackOffsetSec(){
  if (!audioCtx || startedAtAudioCtxTime == null || currentlyPlayingStartTime == null) return null;
  const elapsed = audioCtx.currentTime - startedAtAudioCtxTime;
  return Math.max(0, elapsed);
}

// Start playback ONCE, and only restart if necessary
async function ensurePlayingSynced(trackId, serverStartTime){
  if (!armed || !audioCtx) return;
  if (locallyPaused) return;

  const t = tracks[trackId];
  setNowPlaying(t ? t.name : trackId);

  // If we are already playing the right track, do NOT restart constantly.
  if (source && currentlyPlayingTrackId === trackId && currentlyPlayingStartTime === serverStartTime) {
    // Optional drift correction:
    // If we drift more than 250ms, do a single resync.
    const expected = getExpectedOffsetSec(serverStartTime);
    const actual = getCurrentPlaybackOffsetSec();
    if (actual != null) {
      const drift = Math.abs(actual - expected);
      if (drift < 0.25) {
        // close enough — avoid choppy restarts
        setStatus("Synced", true);
        return;
      }
      // Drift is big: resync once
    }
  }

  const buf = await loadBuffer(trackId);

  // Restart only when needed (track changed, startTime changed, or drift too large)
  stopAudio();

  const offsetSec = getExpectedOffsetSec(serverStartTime);

  source = audioCtx.createBufferSource();
  source.buffer = buf;
  source.connect(audioCtx.destination);

  try{
    source.start(0, offsetSec);
    startedAtAudioCtxTime = audioCtx.currentTime;
    currentlyPlayingTrackId = trackId;
    currentlyPlayingStartTime = serverStartTime;

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

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();

  armed = true;
  locallyPaused = false;

  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";

  setStatus("Armed (loading…)", false);

  // Preload the currently playing track (reduces choppiness)
  if (state.playing && state.trackId) {
    try { await loadBuffer(state.trackId); } catch {}
  }

  setStatus("Armed (waiting…)", false);

  // If broadcast already running, join immediately
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

      // IMPORTANT: do NOT restart audio constantly.
      // Only ensure synced if armed + not paused.
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
        // preload quickly then play
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
