let ws;
let audioCtx = null;
let armed = false;

let tracks = {};
let state = { playing:false, trackId:null, startTime:null };

let source = null;
let bufferCache = {}; // trackId -> AudioBuffer
let locallyPaused = false;

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

async function playSynced(trackId, startTime){
  if (!armed || !audioCtx) return;
  if (locallyPaused) return; // user paused locally

  const t = tracks[trackId];
  setNowPlaying(t ? t.name : trackId);

  const buf = await loadBuffer(trackId);
  stopAudio();

  const offsetSec = Math.max(0, (Date.now() - startTime) / 1000);

  source = audioCtx.createBufferSource();
  source.buffer = buf;
  source.connect(audioCtx.destination);

  try{
    source.start(0, offsetSec);
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
    // pause locally
    locallyPaused = true;
    stopAudio();
    setStatus("Paused (tap Play to re-sync)", false);
    pauseBtn.textContent = "PLAY";
    return;
  }

  // resume -> re-sync to current parade timestamp
  locallyPaused = false;
  pauseBtn.textContent = "PAUSE";

  if (state.playing && state.trackId && state.startTime) {
    await playSynced(state.trackId, state.startTime);
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

  setStatus("Armed (waiting…)", false);

  // If broadcast is already running, join immediately
  if (state.playing && state.trackId && state.startTime) {
    await playSynced(state.trackId, state.startTime);
  }
});

function init(){
  ws = new WebSocket(location.origin.replace(/^http/, "ws"));

  ws.onopen = () => {
    ws.send(JSON.stringify({ type:"hello", role:"client" }));
  };

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

      // If broadcast running, and we are armed + not paused, join/re-join
      if (armed && !locallyPaused && state.startTime) {
        await playSynced(state.trackId, state.startTime);
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
        await playSynced(msg.trackId, msg.startTime);
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
