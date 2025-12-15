// ===== PIN gate (NOT saved) =====
const PIN_CODE = "130865";
const gate = document.getElementById("pinGate");
const pinInput = document.getElementById("pinInput");
const pinBtn = document.getElementById("pinBtn");
const pinMsg = document.getElementById("pinMsg");

pinBtn.onclick = () => {
  if (pinInput.value.trim() === PIN_CODE) {
    gate.style.display = "none";
  } else {
    pinMsg.style.display = "block";
    setTimeout(() => (pinMsg.style.display = "none"), 1200);
  }
};

// ===== WebSocket + state =====
let ws;
let tracks = {};
let state = {
  playing: false,
  paused: false,
  trackId: null,
  startTime: null,
  playlist: ["tyh"],
  playlistIndex: 0
};

const trackSelect = document.getElementById("trackSelect");
const nowPlayingEl = document.getElementById("nowPlaying");
const clockEl = document.getElementById("clock");
const countdownEl = document.getElementById("countdown");

const pausePlayBtn = document.getElementById("pausePlayBtn");
const stopBtn = document.getElementById("stopBtn");
const nextBtn = document.getElementById("nextBtn");
const backBtn = document.getElementById("backBtn");
const playSelectedBtn = document.getElementById("playSelectedBtn");

const addToPlaylistBtn = document.getElementById("addToPlaylistBtn");
const playlistEl = document.getElementById("playlist");

const clientsEl = document.getElementById("clients");
const carsCountEl = document.getElementById("carsCount");

// ===== Admin audio monitor =====
const adminAudio = document.getElementById("adminPlayer");
const monitorBtn = document.getElementById("monitorBtn");
const monitorVol = document.getElementById("monitorVol");
const monitorStatus = document.getElementById("monitorStatus");

let monitorEnabled = false;
let monitorCurrentTrackId = null;

// ===== Seek UI =====
const seekSlider = document.getElementById("seekSlider");
const seekTime = document.getElementById("seekTime");

let isDraggingSeek = false;
let lastSeekSentAt = 0;

// ===== Time sync =====
let serverOffsetMs = 0;
let bestRttMs = Infinity;

function correctedNowMs(){ return Date.now() + serverOffsetMs; }
function timeSyncOnce(){
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type:"timeSync", clientSend: Date.now() }));
  }
}
function fmtTime(ms){
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  const ss = String(d.getSeconds()).padStart(2,"0");
  return `${hh}:${mm}:${ss}`;
}
function fmtMMSS(ms){
  ms = Math.max(0, Math.floor(ms));
  const s = Math.floor(ms/1000);
  const mm = String(Math.floor(s/60)).padStart(2,"0");
  const ss = String(s%60).padStart(2,"0");
  return `${mm}:${ss}`;
}

function trackDurationMs(){
  const t = tracks[state.trackId];
  return t?.duration || 0;
}

function currentPositionMs(){
  if (!state.playing || !state.trackId || !state.startTime) return 0;
  if (state.paused) {
    // pausedAtMs is distributed via state (server)
    // but we don't store it in state object; we infer it from slider/seek updates and server logic.
    // We'll compute from time left in countdown if needed, otherwise use elapsed clamp.
  }
  const elapsed = Math.max(0, correctedNowMs() - state.startTime);
  return elapsed;
}

function effectivePositionMs(){
  // When paused: we want to display the slider's current value (what server is holding),
  // but we do NOT get pausedAtMs in state directly. We'll keep it via lastPauseHoldMs.
  if (state.paused) return lastPauseHoldMs;
  return currentPositionMs();
}

let lastPauseHoldMs = 0;

// ===== Top UI =====
function renderTop(){
  const now = correctedNowMs();
  clockEl.textContent = fmtTime(now);

  if (!state.playing || !state.trackId || !state.startTime) {
    countdownEl.textContent = "Countdown: —";
    nowPlayingEl.textContent = "Now Playing: —";
    pausePlayBtn.textContent = "PAUSE";
    // reset seek UI
    if (!isDraggingSeek) seekSlider.value = 0;
    seekSlider.max = 1000;
    seekTime.textContent = "00:00 / 00:00";
    return;
  }

  const tName = tracks[state.trackId]?.name || state.trackId;
  nowPlayingEl.textContent = `Now Playing: ${tName}`;

  if (state.paused) {
    countdownEl.textContent = "Paused";
    pausePlayBtn.textContent = "PLAY";
  } else {
    const leftMs = state.startTime - now;
    if (leftMs > 0) countdownEl.textContent = `Countdown: ${(leftMs/1000).toFixed(1)}s`;
    else countdownEl.textContent = "LIVE";
    pausePlayBtn.textContent = "PAUSE";
  }
}
setInterval(renderTop, 100);

// ===== Tracks + playlist UI =====
function renderTrackDropdown(){
  trackSelect.innerHTML = "";
  Object.values(tracks).forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    trackSelect.appendChild(opt);
  });
}

function renderPlaylist(){
  playlistEl.innerHTML = "";
  const pl = state.playlist || [];
  pl.forEach((id, idx) => {
    const li = document.createElement("li");
    li.className = "pl-item";
    li.dataset.trackId = id;

    const handle = document.createElement("div");
    handle.className = "handle";
    handle.textContent = "≡";

    const name = document.createElement("div");
    name.className = "pl-name";
    name.textContent = tracks[id]?.name || id;

    const actions = document.createElement("div");
    actions.className = "pl-actions";

    const playBtn = document.createElement("button");
    playBtn.textContent = "Play";
    playBtn.className = "gray";
    playBtn.onclick = () => {
      ws.send(JSON.stringify({ type:"playAtIndex", index: idx }));
    };

    const delBtn = document.createElement("button");
    delBtn.textContent = "✕";
    delBtn.className = "gray";
    delBtn.onclick = () => {
      const next = pl.slice(0, idx).concat(pl.slice(idx + 1));
      ws.send(JSON.stringify({ type:"setPlaylist", playlist: next }));
    };

    actions.appendChild(playBtn);
    actions.appendChild(delBtn);

    li.appendChild(handle);
    li.appendChild(name);
    li.appendChild(actions);
    playlistEl.appendChild(li);
  });
}

new Sortable(playlistEl, {
  handle: ".handle",
  animation: 150,
  onEnd: () => {
    const ids = [...playlistEl.querySelectorAll(".pl-item")].map(li => li.dataset.trackId);
    ws.send(JSON.stringify({ type:"setPlaylist", playlist: ids }));
  }
});

addToPlaylistBtn.onclick = () => {
  const id = trackSelect.value;
  const pl = (state.playlist || []).slice();
  pl.push(id);
  ws.send(JSON.stringify({ type:"setPlaylist", playlist: pl }));
};
playSelectedBtn.onclick = () => {
  ws.send(JSON.stringify({ type:"playTrack", trackId: trackSelect.value }));
};
pausePlayBtn.onclick = () => ws.send(JSON.stringify({ type:"togglePause" }));
stopBtn.onclick = () => ws.send(JSON.stringify({ type:"stop" }));
nextBtn.onclick = () => ws.send(JSON.stringify({ type:"next" }));
backBtn.onclick = () => ws.send(JSON.stringify({ type:"back" }));

function renderClients(list){
  carsCountEl.textContent = `Cars: ${list.length}`;
  clientsEl.innerHTML = "";
  list.forEach(n => {
    const li = document.createElement("li");
    li.textContent = n;
    clientsEl.appendChild(li);
  });
}

// ===== Admin monitor controls =====
monitorVol.oninput = () => {
  adminAudio.volume = Number(monitorVol.value);
};

monitorBtn.onclick = async () => {
  monitorEnabled = !monitorEnabled;

  if (!monitorEnabled) {
    try { adminAudio.pause(); } catch {}
    monitorBtn.textContent = "Enable Monitor Audio";
    monitorStatus.textContent = "Monitor: Off";
    return;
  }

  adminAudio.volume = Number(monitorVol.value);

  try {
    adminAudio.src = "chime.mp3";
    adminAudio.currentTime = 0;
    await adminAudio.play();
    adminAudio.pause();
    adminAudio.removeAttribute("src");
    adminAudio.load();
    monitorCurrentTrackId = null;

    monitorBtn.textContent = "Disable Monitor Audio";
    monitorStatus.textContent = "Monitor: On";
    await syncMonitorToState();
  } catch {
    monitorEnabled = false;
    monitorBtn.textContent = "Enable Monitor Audio";
    monitorStatus.textContent = "Monitor: Off (blocked)";
  }
};

// ===== Monitor sync logic =====
function expectedOffsetSec(startTimeMs){
  return Math.max(0, (correctedNowMs() - startTimeMs) / 1000);
}
function waitAudioEvent(evt, timeoutMs=2500){
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      adminAudio.removeEventListener(evt, on);
      resolve(false);
    }, timeoutMs);
    function on(){
      clearTimeout(t);
      adminAudio.removeEventListener(evt, on);
      resolve(true);
    }
    adminAudio.addEventListener(evt, on, { once:true });
  });
}
async function ensureMonitorTrackReady(trackId){
  const t = tracks[trackId];
  if (!t) return false;

  const same = (monitorCurrentTrackId === trackId) &&
    adminAudio.src && adminAudio.src.includes(encodeURI(t.file));

  if (!same) {
    try { adminAudio.pause(); } catch {}
    adminAudio.src = t.file;
    adminAudio.load();
    monitorCurrentTrackId = trackId;
  }

  if (!Number.isFinite(adminAudio.duration) || adminAudio.duration === 0) {
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
  if (Number.isFinite(adminAudio.duration) && adminAudio.duration > 0) {
    const max = Math.max(0, adminAudio.duration - 0.25);
    return Math.min(Math.max(0, seconds), max);
  }
  return Math.max(0, seconds);
}

async function syncMonitorToState(){
  if (!monitorEnabled) return;

  if (!state.playing || !state.trackId || !state.startTime) {
    try { adminAudio.pause(); } catch {}
    adminAudio.removeAttribute("src");
    adminAudio.load();
    monitorCurrentTrackId = null;
    monitorStatus.textContent = "Monitor: On (idle)";
    return;
  }

  if (state.paused) {
    try { adminAudio.pause(); } catch {}
    monitorStatus.textContent = "Monitor: On (paused)";
    return;
  }

  const ok = await ensureMonitorTrackReady(state.trackId);
  if (!ok) return;

  const delayMs = Math.round(state.startTime - correctedNowMs());

  if (delayMs > 0) {
    try { adminAudio.pause(); } catch {}
    monitorStatus.textContent = `Monitor: On (starts in ${(delayMs/1000).toFixed(1)}s)`;
    setTimeout(async () => {
      if (!monitorEnabled) return;
      if (state.paused) return;
      if (!state.playing || !state.trackId) return;

      await ensureMonitorTrackReady(state.trackId);
      try { adminAudio.currentTime = 0; } catch {}
      try { await adminAudio.play(); } catch {}
    }, delayMs);
    return;
  }

  const shouldBe = expectedOffsetSec(state.startTime);
  const target = clampSeekSeconds(state.trackId, shouldBe);
  try { adminAudio.currentTime = target; } catch {}
  try {
    if (adminAudio.paused) await adminAudio.play();
    monitorStatus.textContent = "Monitor: On (live)";
  } catch {
    monitorStatus.textContent = "Monitor: On (blocked)";
  }
}

// Drift correction for monitor audio
setInterval(async () => {
  if (!monitorEnabled) return;
  if (!state.playing || state.paused || !state.trackId || !state.startTime) return;
  if (adminAudio.paused) return;

  const shouldBe = expectedOffsetSec(state.startTime);
  const target = clampSeekSeconds(state.trackId, shouldBe);
  const actual = adminAudio.currentTime || 0;
  const drift = actual - target;

  if (Math.abs(drift) > 0.6) {
    try { adminAudio.currentTime = target; } catch {}
  }
}, 1500);

// ===== LIVE SEEK SLIDER logic =====
function updateSeekUI(){
  if (!state.playing || !state.trackId) return;

  const dur = trackDurationMs();
  if (dur <= 0) return;

  const pos = Math.max(0, Math.min(effectivePositionMs(), dur));
  const max = dur;

  // slider uses 0..max (ms)
  seekSlider.max = String(max);
  if (!isDraggingSeek) seekSlider.value = String(Math.floor(pos));

  seekTime.textContent = `${fmtMMSS(pos)} / ${fmtMMSS(max)}`;
}

setInterval(updateSeekUI, 100);

// drag behavior
seekSlider.addEventListener("input", () => {
  isDraggingSeek = true;
  const dur = Number(seekSlider.max) || 0;
  const pos = Math.max(0, Math.min(Number(seekSlider.value) || 0, dur));
  seekTime.textContent = `${fmtMMSS(pos)} / ${fmtMMSS(dur)}`;
});

// release -> send seek
seekSlider.addEventListener("change", () => {
  const dur = Number(seekSlider.max) || 0;
  const pos = Math.max(0, Math.min(Number(seekSlider.value) || 0, dur));
  isDraggingSeek = false;

  // remember this as pause-hold when paused
  lastPauseHoldMs = pos;

  // rate limit if someone spams
  const now = Date.now();
  if (now - lastSeekSentAt < 150) return;
  lastSeekSentAt = now;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "seek", positionMs: pos }));
  }

  // update monitor immediately too (local)
  if (monitorEnabled && state.trackId) {
    (async () => {
      await ensureMonitorTrackReady(state.trackId);
      try { adminAudio.currentTime = pos / 1000; } catch {}
    })();
  }
});

// Keep lastPauseHoldMs accurate when pause arrives
function onPauseHold(pausedAtMs){
  lastPauseHoldMs = Math.max(0, Number(pausedAtMs) || 0);
}

// ===== WebSocket =====
ws = new WebSocket(location.origin.replace(/^http/, "ws"));

ws.onopen = () => {
  ws.send(JSON.stringify({ type:"hello", role:"admin" }));
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
    renderTrackDropdown();
    renderPlaylist();
    return;
  }

  if (msg.type === "clients") {
    renderClients(msg.list || []);
    return;
  }

  if (msg.type === "state") {
    state = msg.state || state;
    renderPlaylist();

    // if paused, keep a stable hold value (best guess)
    if (state.paused) {
      // estimate from startTime (clamped) if possible
      const hold = Math.max(0, correctedNowMs() - (state.startTime || correctedNowMs()));
      // but ONLY if we don't already have a known pause hold
      if (!lastPauseHoldMs) lastPauseHoldMs = hold;
    } else {
      // when live, keep lastPauseHoldMs aligned so pause immediately looks right
      lastPauseHoldMs = currentPositionMs();
    }

    await syncMonitorToState();
    return;
  }

  if (msg.type === "pause") {
    // server sends pausedAtMs here
    onPauseHold(msg.pausedAtMs);
    state.paused = true;
    await syncMonitorToState();
    return;
  }

  if (msg.type === "play") {
    state.playing = true;
    state.paused = false;
    state.trackId = msg.trackId;
    state.startTime = msg.startTime;
    lastPauseHoldMs = currentPositionMs();
    await syncMonitorToState();
    return;
  }

  if (msg.type === "stop") {
    state.playing = false;
    state.paused = false;
    state.trackId = null;
    state.startTime = null;
    lastPauseHoldMs = 0;
    if (monitorEnabled) {
      try { adminAudio.pause(); } catch {}
      adminAudio.removeAttribute("src");
      adminAudio.load();
      monitorCurrentTrackId = null;
      monitorStatus.textContent = "Monitor: On (idle)";
    }
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
  }
};
