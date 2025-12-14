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

let serverOffsetMs = 0;
let bestRttMs = Infinity;
let scheduledTimer = null;

function correctedNowMs(){ return Date.now() + serverOffsetMs; }

function timeSyncOnce(){
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:"timeSync", clientSend: Date.now() }));
  }
}

function setStatus(t){ statusPill.textContent = "Status: " + t; }
function setNowPlaying(t){ nowPlayingPill.textContent = "Now Playing: " + t; }

function clearSchedule(){
  if (scheduledTimer) clearTimeout(scheduledTimer);
  scheduledTimer = null;
}

function hardStop(){
  clearSchedule();
  try { audio.pause(); } catch {}
  audio.removeAttribute("src");
  audio.load();
}

async function scheduleStart(trackId, startTimeMs){
  if (!armed) return;
  const t = tracks[trackId];
  if (!t) return;

  // prevent double-start
  hardStop();

  audio.src = t.file;
  audio.load();

  const delayMs = Math.round(startTimeMs - correctedNowMs());
  setNowPlaying(t.name);

  if (delayMs > 0) {
    setStatus(`Synced (starting in ${(delayMs/1000).toFixed(1)}s)`);
    scheduledTimer = setTimeout(async () => {
      if (!armed) return;
      try {
        audio.currentTime = 0;
        await audio.play();
        setStatus("Playing (Synced)");
      } catch {
        setStatus("Tap PLAY (audio blocked)");
      }
    }, delayMs);
  } else {
    // late join: jump into the correct position
    const offsetSec = Math.max(0, (correctedNowMs() - startTimeMs) / 1000);
    try {
      audio.currentTime = offsetSec;
      await audio.play();
      setStatus("Playing (Synced)");
    } catch {
      setStatus("Tap PLAY (audio blocked)");
    }
  }
}

armBtn.onclick = async () => {
  const name = familyInput.value.trim();
  if (!name) { alert("Enter family name first"); return; }

  armed = true;
  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
  setStatus("Armed");

  // iOS unlock trick using chime.mp3
  try {
    audio.src = "chime.mp3";
    audio.currentTime = 0;
    await audio.play();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } catch {}

  // If already playing, join
  if (state.playing && state.trackId && state.startTime) {
    await scheduleStart(state.trackId, state.startTime);
  }
};

pauseBtn.onclick = async () => {
  if (!armed) return;
  if (audio.paused) {
    try { await audio.play(); } catch {}
  } else {
    audio.pause();
  }
};

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

  if (msg.type === "tracks") tracks = msg.tracks || {};

  if (msg.type === "state") {
    state = msg.state || state;
    if (!state.playing) {
      setNowPlaying("—");
      setStatus(armed ? "Armed" : "Not Armed");
      hardStop();
      return;
    }
    // if armed, join based on state
    if (armed && state.trackId && state.startTime) {
      await scheduleStart(state.trackId, state.startTime);
    }
    return;
  }

  if (msg.type === "play") {
    state.playing = true;
    state.trackId = msg.trackId;
    state.startTime = msg.startTime;
    if (armed) await scheduleStart(msg.trackId, msg.startTime);
    else setStatus("Broadcast running — ARM to join");
    return;
  }

  if (msg.type === "stop") {
    state.playing = false;
    state.trackId = null;
    state.startTime = null;
    hardStop();
    setNowPlaying("—");
    setStatus(armed ? "Armed" : "Not Armed");
  }
};

setStatus("Not Armed");
setNowPlaying("—");
