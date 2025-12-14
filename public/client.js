let ws;
let armed = false;
let locallyPaused = false;

let tracks = {};
let state = { playing:false, trackId:null, startTime:null };

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

const armBtn = document.getElementById("armBtn");
const pauseBtn = document.getElementById("pauseBtn");
const familyInput = document.getElementById("familyName");
const statusPill = document.getElementById("statusPill");
const nowPlayingPill = document.getElementById("nowPlayingPill");

const iosPlayer = document.getElementById("iosPlayer");

// WebAudio
let audioCtx = null;
let source = null;
let bufferCache = {};

// Clock sync (nice-to-have; lead time is the main fix)
let serverOffsetMs = 0;
let bestRttMs = Infinity;
let timeSyncInterval = null;

function correctedNowMs() {
  return Date.now() + serverOffsetMs;
}
function timeSyncOnce() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "timeSync", clientSend: Date.now() }));
}
function startTimeSyncLoop() {
  if (timeSyncInterval) clearInterval(timeSyncInterval);
  timeSyncOnce();
  setTimeout(timeSyncOnce, 400);
  setTimeout(timeSyncOnce, 900);
  timeSyncInterval = setInterval(timeSyncOnce, 5000);
}

function setStatus(text, good){
  statusPill.textContent = `Status: ${text}`;
  statusPill.classList.remove("good","bad");
  statusPill.classList.add(good ? "good" : "bad");
}
function setNowPlaying(text){
  nowPlayingPill.textContent = `Now Playing: ${text}`;
}

function stopAudioAll(){
  // iOS
  try { iosPlayer.pause(); } catch {}
  iosPlayer.removeAttribute("src");
  iosPlayer.load();

  // WebAudio
  try { if (source) source.stop(); } catch {}
  source = null;
}

async function loadWebAudioBuffer(trackId){
  if (bufferCache[trackId]) return bufferCache[trackId];
  const t = tracks[trackId];
  const resp = await fetch(t.file, { cache:"no-store" });
  const arr = await resp.arrayBuffer();
  const buf = await audioCtx.decodeAudioData(arr);
  bufferCache[trackId] = buf;
  return buf;
}

function computeOffsetSec(serverStartTimeMs){
  // can be negative if start time is in the future
  return (correctedNowMs() - serverStartTimeMs) / 1000;
}

async function startPlaybackAtServerTime(trackId, serverStartTimeMs){
  if (!armed || locallyPaused) return;

  const t = tracks[trackId];
  setNowPlaying(t ? t.name : trackId);

  const offsetSec = computeOffsetSec(serverStartTimeMs);

  // If start is in future, wait; offset should start at 0
  if (offsetSec < 0) {
    setStatus("Synced (starting…)", true);
  }

  if (isIOS) {
    // iOS native audio
    iosPlayer.src = t.file;

    // If we are starting in the future, start at 0 and play exactly at the moment
    const startDelayMs = Math.max(0, Math.round(-offsetSec * 1000));

    iosPlayer.currentTime = Math.max(0, offsetSec);

    try {
      if (startDelayMs > 0) {
        // ensure file is ready
        iosPlayer.load();
        // schedule play exactly at start time
        setTimeout(async () => {
          if (!armed || locallyPaused) return;
          iosPlayer.currentTime = 0;
          try { await iosPlayer.play(); setStatus("Synced", true); }
          catch { setStatus("Tap PLAY (iOS blocked)", false); }
        }, startDelayMs);
      } else {
        iosPlayer.currentTime = Math.max(0, offsetSec);
        await iosPlayer.play();
        setStatus("Synced", true);
      }
      pauseBtn.textContent = "PAUSE";
    } catch (e) {
      console.error(e);
      setStatus("Tap PLAY (iOS blocked)", false);
    }

    return;
  }

  // WebAudio
  if (!audioCtx) return;

  const buf = await loadWebAudioBuffer(trackId);

  // Stop previous
  try { if (source) source.stop(); } catch {}
  source = null;

  const startDelaySec = Math.max(0, -offsetSec); // if offset negative, delay is positive
  const playFromSec = Math.max(0, offsetSec);    // if offset negative, play from 0

  source = audioCtx.createBufferSource();
  source.buffer = buf;
  source.connect(audioCtx.destination);

  // Schedule accurately
  source.start(audioCtx.currentTime + startDelaySec, playFromSec);

  setStatus(startDelaySec > 0 ? "Synced (starting…)" : "Synced", true);
  pauseBtn.textContent = "PAUSE";
}

pauseBtn.addEventListener("click", async () => {
  if (!armed) return;

  if (!locallyPaused) {
    locallyPaused = true;
    stopAudioAll();
    setStatus("Paused (tap Play to re-sync)", false);
    pauseBtn.textContent = "PLAY";
    return;
  }

  locallyPaused = false;
  pauseBtn.textContent = "PAUSE";

  if (state.playing && state.trackId && state.startTime) {
    await startPlaybackAtServerTime(state.trackId, state.startTime);
  } else {
    setStatus("Armed (waiting…)", false);
  }
});

armBtn.addEventListener("click", async () => {
  const name = familyInput.value.trim();
  if (!name) {
    alert("Please enter your family name first.");
    familyInput.focus();
    return;
  }

  // Don't crash if websocket isn't ready yet
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:"register", name }));
  }

  armed = true;
  locallyPaused = false;

  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
  setStatus("Armed (loading…)", false);

  // Start clock sync loop (if present)
  if (typeof startTimeSyncLoop === "function") {
    startTimeSyncLoop();
  }

  if (isIOS) {
    // iOS unlock trick (chime.mp3)
    try {
      iosPlayer.src = "chime.mp3";
      iosPlayer.currentTime = 0;
      await iosPlayer.play();
      iosPlayer.pause();
      iosPlayer.removeAttribute("src");
      iosPlayer.load();
    } catch {}
  } else {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    await audioCtx.resume();
  }

  setStatus("Armed (waiting…)", false);

  // If broadcast already running, join now
  if (state.playing && state.trackId && state.startTime) {
    await startPlaybackAtServerTime(state.trackId, state.startTime);
  }
});


  ws.send(JSON.stringify({ type:"register", name }));

  armed = true;
  locallyPaused = false;

  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
  setStatus("Armed (loading…)", false);

  startTimeSyncLoop();

  if (!isIOS) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    await audioCtx.resume();
  } else {
    // iOS unlock trick (chime.mp3)
    try {
      iosPlayer.src = "chime.mp3";
      iosPlayer.currentTime = 0;
      await iosPlayer.play();
      iosPlayer.pause();
      iosPlayer.removeAttribute("src");
      iosPlayer.load();
    } catch {}
  }

  setStatus("Armed (waiting…)", false);

  // If broadcast already running, join now (or schedule)
  if (state.playing && state.trackId && state.startTime) {
    await startPlaybackAtServerTime(state.trackId, state.startTime);
  }
});

function init(){
  ws = new WebSocket(location.origin.replace(/^http/, "ws"));

  ws.onopen = () => {
    ws.send(JSON.stringify({ type:"hello", role:"client" }));
    startTimeSyncLoop();
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "timeSync") {
      const clientReceive = Date.now();
      const rtt = clientReceive - msg.clientSend;
      const approxServerAtReceive = msg.serverTime + (rtt / 2);
      const newOffset = approxServerAtReceive - clientReceive;

      if (rtt < bestRttMs) {
        bestRttMs = rtt;
        serverOffsetMs = newOffset;
      } else {
        serverOffsetMs = serverOffsetMs * 0.9 + newOffset * 0.1;
      }
      return;
    }

    if (msg.type === "resync") {
  // treat resync like play
  state.playing = true;
  state.trackId = msg.trackId;
  state.startTime = msg.startTime;
  if (armed && !locallyPaused) {
    await startPlaybackAtServerTime(msg.trackId, msg.startTime);
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
        stopAudioAll();
        return;
      }

      const t = tracks[state.trackId];
      setNowPlaying(t ? t.name : state.trackId);

      if (armed && !locallyPaused && state.startTime) {
        await startPlaybackAtServerTime(state.trackId, state.startTime);
      } else if (!armed) {
        setStatus("Broadcast running — ARM to join", false);
      }
      return;
    }

    if (msg.type === "play") {
      state.playing = true;
      state.trackId = msg.trackId;
      state.startTime = msg.startTime;

      const t = tracks[msg.trackId];
      setNowPlaying(t ? t.name : msg.trackId);

      if (armed && !locallyPaused) {
        // preload for non-iOS
        if (!isIOS && audioCtx) {
          try { await loadWebAudioBuffer(msg.trackId); } catch {}
        }
        await startPlaybackAtServerTime(msg.trackId, msg.startTime);
      } else if (!armed) {
        setStatus("Broadcast running — ARM to join", false);
      }
      return;
    }

    if (msg.type === "stop") {
      state.playing = false;
      state.trackId = null;
      state.startTime = null;
      stopAudioAll();
      setNowPlaying("—");
      if (armed) setStatus(locallyPaused ? "Paused" : "Armed (waiting…)", false);
      else setStatus("Not Armed", false);
      return;
    }
  };

  ws.onclose = () => {
    stopAudioAll();
    setStatus("Disconnected (refresh page)", false);
  };
}

setStatus("Not Armed", false);
setNowPlaying("—");
init();
