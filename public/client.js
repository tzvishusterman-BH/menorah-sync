//-------------------------------------------------------------
//  CLIENT PAGE — Berlin Menorah Parade 5786
//  Handles:
//   ✔ Audio sync
//   ✔ ARM gating with family name
//   ✔ Pause/play
//   ✔ Status indicator
//   ✔ Multi-language UI
//   ✔ Terminate (kick) handling
//-------------------------------------------------------------

let ws;
let audioCtx;
let audioBuffer = null;
let sourceNode = null;
let isPlaying = false;

let tracks = {};     // id → {id, name, file, duration}
let currentTrackId = null;
let serverStartTime = null;

const familyNameInput = document.getElementById("familyName");
const armBtn = document.getElementById("armBtn");
const pauseBtn = document.getElementById("pauseBtn");
const statusText = document.getElementById("statusText");
const trackTitle = document.getElementById("trackTitle");
const langSelect = document.getElementById("langSelect");

//==============================================================
// LANGUAGE
//==============================================================

langSelect.addEventListener("change", () => {
  const lang = langSelect.value;
  localStorage.setItem("clientLang", lang);
  applyTranslations(lang);
});

// Load saved preference
const savedLang = localStorage.getItem("clientLang") || "en";
langSelect.value = savedLang;
applyTranslations(savedLang);


//==============================================================
// START WEBSOCKET
//==============================================================

function initWS() {
  ws = new WebSocket(location.origin.replace(/^http/, "ws"));

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", role: "client" }));
  };

  ws.onmessage = async msg => {
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }

    switch (data.type) {

      case "tracks":
        tracks = {};
        data.tracks.forEach(t => tracks[t.id] = t);
        break;

      case "state":
        handleState(data.state);
        break;

      case "seek":
        handleSeek(data.trackId, data.serverStartTime);
        break;

      case "stop":
        stopAudio();
        updateStatus("Not Synced");
        break;

      case "terminated":
        stopAudio();
        alert("Your audio has been disabled by parade staff.");
        armBtn.disabled = true;
        break;
    }
  };
}

initWS();


//==============================================================
// ARM AUDIO
//==============================================================

armBtn.addEventListener("click", async () => {
  const name = familyNameInput.value.trim();
  if (!name) {
    alert("Please enter your family name first.");
    return;
  }

  // Send registration
  ws.send(JSON.stringify({ type: "register", name }));

  // ARM requires activating audio context
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
  } catch {}

  ws.send(JSON.stringify({ type: "armed" }));

  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";

  updateStatus("Armed — Waiting for playback…");
});


//==============================================================
// STATE HANDLING
//==============================================================

async function handleState(state) {
  if (!state || !state.trackId) {
    updateStatus("Idle");
    trackTitle.textContent = "Now Playing: —";
    stopAudio();
    return;
  }

  // Track changed?
  if (state.trackId !== currentTrackId) {
    await loadTrack(state.trackId);
  }

  currentTrackId = state.trackId;
  serverStartTime = state.serverStartTime;

  const t = tracks[state.trackId];
  trackTitle.textContent = "Now Playing: " + t.name;

  if (state.mode === "playing") {
    syncPlayback();
  }
}


//==============================================================
// SEEK HANDLING
//==============================================================

async function handleSeek(trackId, startTime) {
  if (trackId !== currentTrackId) {
    await loadTrack(trackId);
  }
  serverStartTime = startTime;
  syncPlayback();
}


//==============================================================
// LOAD AUDIO FILE
//==============================================================

async function loadTrack(trackId) {
  stopAudio();

  const t = tracks[trackId];
  if (!t) return;

  const url = t.file;

  try {
    const resp = await fetch(url);
    const arr = await resp.arrayBuffer();

    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.resume();
    }

    audioBuffer = await audioCtx.decodeAudioData(arr);
  } catch (err) {
    console.error("Audio load error:", err);
  }
}


//==============================================================
// SYNC PLAYBACK
//==============================================================

async function syncPlayback() {
  if (!audioBuffer || !audioCtx) return;

  stopAudio();

  const now = audioCtx.currentTime * 1000;
  const offsetMs = Date.now() - serverStartTime;
  const offsetSec = offsetMs / 1000;

  if (offsetSec < 0) return;

  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(audioCtx.destination);

  try {
    sourceNode.start(0, offsetSec);
    isPlaying = true;
    pauseBtn.textContent = translations[savedLang]["pauseBtn"];
    updateStatus("Synced");
  } catch (err) {
    console.error("Play error:", err);
  }
}


//==============================================================
// PAUSE / PLAY
//==============================================================

pauseBtn.addEventListener("click", async () => {
  if (!isPlaying) {
    syncPlayback();
    return;
  }

  stopAudio();
  isPlaying = false;
  pauseBtn.textContent = translations[savedLang]["playBtn"];
});


//==============================================================
// STOP AUDIO
//==============================================================

function stopAudio() {
  try {
    if (sourceNode) sourceNode.stop();
  } catch {}
  sourceNode = null;
  isPlaying = false;
}


//==============================================================
// UI HELPERS
//==============================================================

function updateStatus(msg) {
  statusText.textContent = translations[savedLang]["status"] + ": " + msg;
}


//==============================================================
// END OF CLIENT
//==============================================================
