// CLIENT (listener) script with iOS fallback + late join support + stop

let ws;
let audioCtx;
let audioBuffer = null;
let htmlAudio = null; // for iOS fallback
let timeOffset = 0; // serverTime - clientTime (ms)
let armed = false;
let lateJoinStartTime = null; // serverStartTime if we joined mid-track
let currentSource = null; // Web Audio BufferSource

const statusEl = document.getElementById("status");
const armBtn = document.getElementById("armBtn");

function logStatus(msg) {
  console.log(msg);
  statusEl.textContent = msg;
}

// Basic iOS detection
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes("Mac") && "ontouchend" in document);

function getWSUrl() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}`;
}

function connectWS() {
  ws = new WebSocket(getWSUrl());

  ws.onopen = () => {
    console.log("WebSocket opened");
    ws.send(JSON.stringify({ type: "hello", role: "client" }));
    logStatus("Connected. Syncing clock…");
    runClockSync().then(() => {
      logStatus("Clock synced. Loading audio…");
      loadAudio();
    });
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "pong") {
      handlePong(msg);
    } else if (msg.type === "start") {
      handleStart(msg.serverStartTime);
    } else if (msg.type === "late-join") {
      handleLateJoin(msg.serverStartTime);
    } else if (msg.type === "stop") {
      handleStop();
    }
  };

  ws.onclose = () => {
    logStatus("Disconnected from server. Refresh if needed.");
  };

  ws.onerror = (err) => {
    console.error("WebSocket error", err);
  };
}

// CLOCK SYNC

let pendingPings = [];
let clockSyncResolve;

function runClockSync(samples = 10) {
  return new Promise((resolve) => {
    clockSyncResolve = resolve;
    window._offsetSamples = [];
    for (let i = 0; i < samples; i++) {
      sendPing();
    }
  });
}

function sendPing() {
  const clientSendTime = Date.now();
  pendingPings.push(clientSendTime);
  ws.send(JSON.stringify({ type: "ping", clientSendTime }));
}

function handlePong(msg) {
  const { clientSendTime, serverTime } = msg;
  const idx = pendingPings.indexOf(clientSendTime);
  if (idx === -1) return; // not found / already processed

  pendingPings.splice(idx, 1);

  const clientRecvTime = Date.now();
  const rtt = clientRecvTime - clientSendTime;
  const clientMid = clientSendTime + rtt / 2;
  const offsetSample = serverTime - clientMid;

  window._offsetSamples.push({ rtt, offsetSample });

  // When we have enough samples, compute offset
  if (window._offsetSamples.length >= 10 && clockSyncResolve) {
    const sorted = window._offsetSamples.sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.ceil(sorted.length / 2));
    timeOffset =
      best.reduce((sum, s) => sum + s.offsetSample, 0) / best.length;

    console.log("Time offset (server - client):", timeOffset, "ms");
    logStatus("Clock synced (~" + Math.round(timeOffset) + " ms offset).");
    clockSyncResolve();
    clockSyncResolve = null;
  } else if (clockSyncResolve) {
    // Request another ping until we hit the sample count
    sendPing();
  }
}

function getServerNow() {
  // clientTime + offset
  return Date.now() + timeOffset;
}

// AUDIO

async function loadAudio() {
  try {
    if (isIOS) {
      // iOS: use HTMLAudioElement
      htmlAudio = new Audio("track.mp3");
      htmlAudio.preload = "auto";

      htmlAudio.addEventListener("canplaythrough", () => {
        logStatus("Audio loaded. Tap ARM when ready.");
        armBtn.disabled = false;
      });

      htmlAudio.addEventListener("error", (e) => {
        console.error("Error loading audio on iOS:", e);
        logStatus("Error loading audio on iOS.");
      });

      // Force load
      htmlAudio.load();
    } else {
      // Non-iOS: use Web Audio API
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const res = await fetch("track.mp3");
      if (!res.ok) {
        throw new Error("Failed to fetch track.mp3");
      }
      const arrayBuffer = await res.arrayBuffer();
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      logStatus("Audio loaded. Tap ARM when ready.");
      armBtn.disabled = false;
    }
  } catch (err) {
    console.error("Error loading audio:", err);
    logStatus("Error loading audio: " + err.message);
  }
}

armBtn.addEventListener("click", () => {
  // ARM must be a user gesture
  if (isIOS) {
    if (!htmlAudio) {
      logStatus("Audio not ready yet.");
      return;
    }
    // iOS "unlock": play then immediately pause so we can play later
    htmlAudio
      .play()
      .then(() => {
        htmlAudio.pause();
        htmlAudio.currentTime = 0;
        armed = true;
        armBtn.disabled = true;

        if (lateJoinStartTime) {
          logStatus("Joining in progress (iOS)...");
          joinInProgress();
        } else {
          logStatus("Armed (iOS). Waiting for start signal…");
        }
      })
      .catch((err) => {
        console.error("Error unlocking audio on iOS:", err);
        logStatus("Tap ARM again to allow audio on iOS.");
      });
  } else {
    if (!audioCtx) {
      logStatus("Audio context not ready.");
      return;
    }

    // Needed for mobile autoplay restrictions
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }

    armed = true;
    armBtn.disabled = true;

    if (lateJoinStartTime) {
      logStatus("Joining in progress…");
      joinInProgress();
    } else {
      logStatus("Armed. Waiting for start signal…");
    }
  }
});

function handleStart(serverStartTime) {
  if (!armed) {
    // We might get this before the user arms; remember it as a future start.
    lateJoinStartTime = null; // clear any previous late join info
    logStatus("Start signal received. Tap ARM to join.");
    return;
  }

  const serverNow = getServerNow();
  const msUntilStart = serverStartTime - serverNow;

  if (msUntilStart < 0) {
    // Start time already passed => treat as late-join into current track
    lateJoinStartTime = serverStartTime;
    joinInProgress();
    return;
  }

  logStatus(
    "Music scheduled to start in " + Math.round(msUntilStart) + " ms."
  );

  if (isIOS) {
    // iOS: use setTimeout + HTMLAudio
    if (!htmlAudio) {
      logStatus("iOS audio not ready.");
      return;
    }
    console.log("iOS scheduling start in ms:", msUntilStart);
    setTimeout(() => {
      htmlAudio
        .play()
        .catch((err) => {
          console.error("Error playing audio on iOS:", err);
          logStatus("Error playing audio on iOS: " + err.message);
        });
    }, msUntilStart);
  } else {
    // Non-iOS: Web Audio scheduling
    if (!audioBuffer) {
      logStatus("Received start, but audio not loaded yet.");
      return;
    }

    const secondsUntilStart = msUntilStart / 1000;
    const when = audioCtx.currentTime + secondsUntilStart;

    // Stop any existing playback
    if (currentSource) {
      try {
        currentSource.stop();
      } catch (e) {}
      currentSource = null;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);
    source.start(when);
    currentSource = source;

    console.log(
      "Scheduling start at audioCtx.currentTime +",
      secondsUntilStart
    );
  }
}

function handleLateJoin(serverStartTime) {
  // Store info that the track is already in progress
  lateJoinStartTime = serverStartTime;

  const serverNow = getServerNow();
  const msSinceStart = serverNow - serverStartTime;

  if (msSinceStart < 0) {
    // Track hasn't started yet; this will be handled by handleStart anyway.
    logStatus("Track is scheduled to start soon.");
    return;
  }

  if (!armed) {
    logStatus(
      "Music already playing. Tap ARM to join in progress."
    );
  } else {
    logStatus("Joining track in progress…");
    joinInProgress();
  }
}

function joinInProgress() {
  if (!lateJoinStartTime) {
    logStatus("No late-join info available.");
    return;
  }

  const serverNow = getServerNow();
  let msSinceStart = serverNow - lateJoinStartTime;

  if (msSinceStart < 0) {
    // If somehow negative, just wait for handleStart instead
    logStatus("Track start is still in the future.");
    return;
  }

  const offsetSeconds = msSinceStart / 1000;
  console.log("Joining in progress at offset (s):", offsetSeconds);

  if (isIOS) {
    if (!htmlAudio) {
      logStatus("iOS audio not ready.");
      return;
    }
    htmlAudio.currentTime = offsetSeconds;
    htmlAudio
      .play()
      .catch((err) => {
        console.error("Error playing audio on iOS:", err);
        logStatus("Error playing audio on iOS: " + err.message);
      });
  } else {
    if (!audioCtx || !audioBuffer) {
      logStatus("Audio not ready to join in progress.");
      return;
    }

    // Stop any existing playback
    if (currentSource) {
      try {
        currentSource.stop();
      } catch (e) {}
      currentSource = null;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);

    // Start immediately with offset
    const when = audioCtx.currentTime + 0.1; // tiny delay to be safe
    source.start(when, offsetSeconds);
    currentSource = source;
  }
}

function handleStop() {
  console.log("Received STOP from server");
  stopPlayback();
}

function stopPlayback() {
  // Stop audio and reset state so user can ARM again
  if (isIOS) {
    if (htmlAudio) {
      htmlAudio.pause();
      htmlAudio.currentTime = 0;
    }
  } else {
    if (currentSource) {
      try {
        currentSource.stop();
      } catch (e) {}
      currentSource = null;
    }
  }

  lateJoinStartTime = null;
  armed = false;
  armBtn.disabled = false;

  logStatus("Playback stopped. Tap ARM to get ready for the next track.");
}

connectWS();
