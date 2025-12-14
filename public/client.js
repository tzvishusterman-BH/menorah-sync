let ws;
let tracks = {};
let state = { playing: false, paused: false, trackId: null, startTime: null };

const audio = document.getElementById("iosPlayer");
const armBtn = document.getElementById("armBtn");
const pauseBtn = document.getElementById("pauseBtn");
const familyInput = document.getElementById("familyName");
const statusPill = document.getElementById("statusPill");
const nowPlayingPill = document.getElementById("nowPlayingPill");

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

// ✅ iOS audible output latency compensation (tune 700–1200ms)
const IOS_LATENCY_MS = 950;

let armed = false;
let locallyPaused = false;

let serverOffsetMs = 0;
let bestRttMs = Infinity;

let currentTrackId = null;
let scheduledTimer = null;
let unmuteTimer = null;
let preRollTimer = null;

function setStatus(t, good = false) {
  statusPill.textContent = "Status: " + t;
  statusPill.classList.remove("good", "bad");
  statusPill.classList.add(good ? "good" : "bad");
}
function setNowPlaying(t) {
  nowPlayingPill.textContent = "Now Playing: " + t;
}

function correctedNowMs() { return Date.now() + serverOffsetMs; }

// ✅ iOS: seek slightly ahead so audible output lines up
function expectedOffsetSec(startTimeMs) {
  const base = Math.max(0, (correctedNowMs() - startTimeMs) / 1000);
  return isIOS ? (base + IOS_LATENCY_MS / 1000) : base;
}

function clearSchedule() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  if (unmuteTimer) clearTimeout(unmuteTimer);
  if (preRollTimer) clearTimeout(preRollTimer);
  scheduledTimer = null;
  unmuteTimer = null;
  preRollTimer = null;
}

function hardStopUnload() {
  clearSchedule();
  try { audio.pause(); } catch {}
  try { audio.volume = 1; } catch {}
  audio.removeAttribute("src");
  audio.load();
  currentTrackId = null;
}

function stopButKeepSrc() {
  clearSchedule();
  try { audio.pause(); } catch {}
  try { audio.volume = 1; } catch {}
}

async function timeSyncOnce() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "timeSync", clientSend: Date.now() }));
  }
}

// Wait helper for an audio event (with timeout)
function waitAudioEvent(evt, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      audio.removeEventListener(evt, on);
      resolve(false);
    }, timeoutMs);

    function on() {
      clearTimeout(t);
      audio.removeEventListener(evt, on);
      resolve(true);
    }
    audio.addEventListener(evt, on, { once: true });
  });
}

// Ensure track is loaded AND metadata is ready before seeking
async function ensureTrackReady(trackId) {
  const t = tracks[trackId];
  if (!t) return false;

  const same = currentTrackId === trackId &&
    audio.src &&
    audio.src.includes(encodeURI(t.file));

  if (!same) {
    stopButKeepSrc();
    audio.src = t.file;
    audio.load();
    currentTrackId = trackId;
  }

  if (!Number.isFinite(audio.duration) || audio.duration === 0) {
    await waitAudioEvent("loadedmetadata", 3000);
  }
  return true;
}

// Clamp seek target so we never request impossible values
function clampSeekSeconds(trackId, seconds) {
  const t = tracks[trackId];
  const durMs = t?.duration;

  if (typeof durMs === "number" && durMs > 0) {
    const max = Math.max(0, (durMs / 1000) - 0.25);
    return Math.min(Math.max(0, seconds), max);
  }

  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    const max = Math.max(0, audio.duration - 0.25);
    return Math.min(Math.max(0, seconds), max);
  }

  return Math.max(0, seconds);
}

// Seek reliably (wait for seeked)
async function seekReliable(trackId, seconds) {
  const ok = await ensureTrackReady(trackId);
  if (!ok) return false;

  const target = clampSeekSeconds(trackId, seconds);

  try {
    audio.currentTime = target;
  } catch {
    return false;
  }

  await waitAudioEvent("seeked", 1200);
  return true;
}

// Thresholds: gentle on iOS
function driftThreshold() { return isIOS ? 1.2 : 0.35; }
function driftLoopInterval() { return isIOS ? 3500 : 1200; }

// Main sync function
async function syncToParade(trackId, startTimeMs) {
  if (!armed) return;
  if (!trackId || !startTimeMs) return;
  const t = tracks[trackId];
  if (!t) return;

  setNowPlaying(t.name);

  // If admin paused, don't try to play
  if (state.paused) {
    try { audio.pause(); } catch {}
    setStatus("Paused (Admin)", false);
    return;
  }

  // If user paused locally, don’t force audio
  if (locallyPaused) {
    setStatus("Paused (tap PLAY to re-sync)", false);
    return;
  }

  const delayMs = Math.round(startTimeMs - correctedNowMs());

  // Countdown start in the future
  if (delayMs > 0) {
    stopButKeepSrc();
    clearSchedule();
    setStatus(`Synced (starting in ${(delayMs / 1000).toFixed(1)}s)`, true);

    // ✅ iOS pre-roll: start slightly early muted, then unmute at exact start
    if (isIOS) {
      const preRollIn = Math.max(0, delayMs - IOS_LATENCY_MS);

      preRollTimer = setTimeout(async () => {
        if (!armed || locallyPaused || state.paused) return;

        await ensureTrackReady(trackId);
        try { audio.currentTime = 0; } catch {}
        try { audio.volume = 0; } catch {}

        try {
          await audio.play();
          setStatus("Starting… (Synced)", true);
        } catch {
          setStatus("Tap PLAY (audio blocked)", false);
        }
      }, preRollIn);

      unmuteTimer = setTimeout(() => {
        try { audio.volume = 1; } catch {}
      }, delayMs);

      return;
    }

    // Non-iOS: normal countdown start
    scheduledTimer = setTimeout(async () => {
      if (!armed || locallyPaused || state.paused) return;

      await ensureTrackReady(trackId);
      try { audio.currentTime = 0; } catch {}

      try {
        await audio.play();
        setStatus("Playing (Synced)", true);
      } catch {
        setStatus("Tap PLAY (audio blocked)", false);
      }
    }, delayMs);

    return;
  }

  // Already started: late join / resync to correct position
  const shouldBe = expectedOffsetSec(startTimeMs);
  const seekOk = await seekReliable(trackId, shouldBe);

  try {
    const playing = !audio.paused;
    const target = clampSeekSeconds(trackId, shouldBe);
    const actual = audio.currentTime || 0;
    const drift = Math.abs(actual - target);

    // If not playing, start now
    if (!playing) {
      if (!seekOk) {
        await ensureTrackReady(trackId);
        try { audio.currentTime = 0; } catch {}
      }
      await audio.play();
      setStatus("Playing (Synced)", true);
      return;
    }

    // While playing, only correct if significantly off
    if (drift > driftThreshold()) {
      if (isIOS) {
        await seekReliable(trackId, shouldBe);
        setStatus("Playing (Resynced)", true);
      } else {
        audio.pause();
        await seekReliable(trackId, shouldBe);
        await audio.play();
        setStatus("Playing (Resynced)", true);
      }
    } else {
      setStatus("Playing (Synced)", true);
    }
  } catch {
    setStatus("Tap PLAY (audio blocked)", false);
  }
}

// Drift correction loop
let driftTimer = null;
function startDriftLoop() {
  if (driftTimer) clearInterval(driftTimer);
  driftTimer = setInterval(async () => {
    if (!armed) return;
    if (locallyPaused) return;
    if (state.paused) return;
    if (!state.playing || !state.trackId || !state.startTime) return;
    if (audio.paused) return;

    const shouldBe = expectedOffsetSec(state.startTime);
    const target = clampSeekSeconds(state.trackId, shouldBe);
    const actual = audio.currentTime || 0;
    const drift = actual - target;

    if (Math.abs(drift) > driftThreshold()) {
      try {
        if (isIOS) {
          await seekReliable(state.trackId, shouldBe);
        } else {
          audio.pause();
          await seekReliable(state.trackId, shouldBe);
          await audio.play();
        }
        setStatus("Playing (Resynced)", true);
      } catch {}
    }
  }, driftLoopInterval());
}
startDriftLoop();

// ARM
armBtn.onclick = async () => {
  const name = familyInput.value.trim();
  if (!name) {
    alert("Please enter your family name first.");
    familyInput.focus();
    return;
  }

  // register name for admin list
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "register", name }));
    }
  } catch {}

  armed = true;
  locallyPaused = false;
  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
  pauseBtn.textContent = "PAUSE";

  setStatus("Armed", false);

  // iOS unlock trick
  try {
    audio.src = "chime.mp3";
    audio.currentTime = 0;
    await audio.play();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    currentTrackId = null;
  } catch {}

  await timeSyncOnce();

  // Late join guarantee
  if (state.playing && state.trackId && state.startTime && !state.paused) {
    await syncToParade(state.trackId, state.startTime);
  }
};

// Pause/Play: PLAY = rejoin parade
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

  if (state.playing && state.trackId && state.startTime && !state.paused) {
    await syncToParade(state.trackId, state.startTime);
  } else {
    setStatus("Armed (waiting…)", false);
  }
};

// WebSocket
ws = new WebSocket(location.origin.replace(/^http/, "ws"));

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "hello", role: "client" }));
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

    if (state.paused) {
      clearSchedule();
      try { audio.pause(); } catch {}
      setStatus("Paused (Admin)", false);
      return;
    }

    if (!armed) {
      setStatus("Broadcast running — ARM to join", false);
      return;
    }

    await syncToParade(state.trackId, state.startTime);
    return;
  }

  if (msg.type === "pause") {
    state.playing = true;
    state.paused = true;
    state.trackId = msg.trackId;
    clearSchedule();
    try { audio.pause(); } catch {}
    setStatus("Paused (Admin)", false);
    return;
  }

  if (msg.type === "preload") {
    // best-effort preload next track
    const t = tracks[msg.trackId];
    if (t) {
      try {
        const a = new Audio();
        a.preload = "auto";
        a.src = t.file;
        a.load();
      } catch {}
    }
    return;
  }

  if (msg.type === "play" || msg.type === "resync") {
    state.playing = true;
    state.paused = false;
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
    state.paused = false;
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
