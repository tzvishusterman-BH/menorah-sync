let ws;
let audioCtx = null;
let armed = false;

let tracks = {}; // server sends object
let state = { playing:false, trackId:null, startTime:null };

let source = null;
let bufferCache = {}; // trackId -> decoded AudioBuffer

const armBtn = document.getElementById("armBtn");
const familyInput = document.getElementById("familyName");
const statusEl = document.getElementById("status");

function setStatus(s) { statusEl.textContent = s; }

function stopAudio() {
  try { if (source) source.stop(); } catch {}
  source = null;
}

async function loadBuffer(trackId) {
  if (bufferCache[trackId]) return bufferCache[trackId];

  const t = tracks[trackId];
  if (!t) throw new Error("Unknown track: " + trackId);

  const resp = await fetch(t.file);
  const arr = await resp.arrayBuffer();
  const buf = await audioCtx.decodeAudioData(arr);
  bufferCache[trackId] = buf;
  return buf;
}

async function playSynced(trackId, startTime) {
  if (!armed || !audioCtx) return;

  const buf = await loadBuffer(trackId);

  stopAudio();

  const offsetSec = Math.max(0, (Date.now() - startTime) / 1000);

  source = audioCtx.createBufferSource();
  source.buffer = buf;
  source.connect(audioCtx.destination);

  try {
    source.start(0, offsetSec);
    setStatus("Synced");
  } catch (e) {
    console.error(e);
    setStatus("Error playing audio");
  }
}

function init() {
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
      // if user already armed and broadcast is running, join immediately
      if (armed && state.playing && state.trackId && state.startTime) {
        await playSynced(state.trackId, state.startTime);
      }
      return;
    }

    if (msg.type === "play") {
      state.playing = true;
      state.trackId = msg.trackId;
      state.startTime = msg.startTime;
      await playSynced(msg.trackId, msg.startTime);
      return;
    }

    if (msg.type === "stop") {
      state.playing = false;
      state.trackId = null;
      state.startTime = null;
      stopAudio();
      setStatus(armed ? "Armed" : "Not synced");
      return;
    }
  };
}

armBtn.onclick = async () => {
  const name = familyInput.value.trim();
  if (!name) return alert("Enter family name");

  ws.send(JSON.stringify({ type:"register", name }));

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();

  armed = true;
  setStatus("Armed");

  // If broadcast already running, join immediately
  if (state.playing && state.trackId && state.startTime) {
    await playSynced(state.trackId, state.startTime);
  }
};

init();
