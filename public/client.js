// CLIENT (listener) script with iOS fallback, late join support,
// STOP handling, and required family name before ARM

let ws;
let audioCtx;
let audioBuffer = null;
let htmlAudio = null; // for iOS fallback
let timeOffset = 0; // serverTime - clientTime (ms)
let armed = false;
let serverStartTime = null; // last known start time from server
let currentSource = null; // Web Audio BufferSource

// NEW: name + state for enabling ARM
let clientName = "";
let hasName = false;
let audioLoaded = false;
let wsReady = false;

const statusEl = document.getElementById("status");
const armBtn = document.getElementById("armBtn");
const nameInput = document.getElementById("nameInput");
const saveNameBtn = document.getElementById("saveNameBtn");

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
    wsReady = true;
    ws.send(JSON.stringify({ type: "hello", role: "client" }));

    // If we already know the name (user typed it before WS was ready), send it now.
    if (hasName && clientName.trim().length > 0) {
      sendNameRegistration();
    }

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
    wsReady = false;
    logStatus("Disconnected from server. Refresh if needed.");
  };

  ws.onerror = (err) => {
    console.error("WebSocket error", err);
  };
}

// Enable/disable the ARM button based on state
function updateArmButtonState() {
  // ARM allowed only if:
  // - audio loaded
  // - we have a family name
  // - not already armed
  const enable = audioLoaded && hasName && !armed;
  armBtn.disabled = !enable;
  console.log("updateArmButtonState:", { audioLoaded, hasName, armed, enable });
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
        audioLoaded = true;
        logStatus("Audio loaded. Enter family name & tap ARM.");
        updateArmButtonState();
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
      audioLoaded = true;
      logStatus("Audio loaded. Enter family name & tap ARM.");
      updateArmButtonState();
    }
  } catch (err) {
    console.error("Error loading audio:", err);
    logStatus("Error loading audio: " + err.message);
  }
}

// NEW: handle saving family name
saveNameBtn.addEventListener("click", () => {
  const name = (nameInput.value || "").trim();
  if (!name) {
    logStatus("Please enter your family name before arming.");
    return;
  }
  clientName = name;
  hasName = true;
  logStatus(
    `Registered family name: ${clientName}. Once audio is loaded, you can tap ARM.`
  );
  updateArmButtonState();

  // send registration to server if possible
  if (wsReady) {
    sendNameRegistration();
  }
});

function sendNameRegistration() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!clientName || !clientName.trim()) return;
  ws.send(
    JSON.stringify({
      type: "register",
      name: clientName.trim()
    })
  );
}

// ARM BUTTON

armBtn.addEventListener("click", () => {
  if (!hasName) {
    logStatus("Please save your family name first.");
    return;
  }

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
        updateArmButtonState();

        if (serverStartTime) {
          logStatus("Armed (iOS). Joining current track…");
          scheduleOrJoin();
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

    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }

    armed = true;
    updateArmButtonState();

    if (serverStartTime) {
      logStatus("Armed. Joining current track…");
      scheduleOrJoin();
    } else {
      logStatus("Armed. Waiting for start signal…");
    }
  }
});

// START / LATE JOIN / STOP

function handleStart(startTimeFromServer) {
  serverStartTime = startTimeFromServer;

  const serverNow = getServerNow();
  const msUntilStart = serverStartTime - serverNow;

  if (armed) {
    scheduleOrJoin();
  } else {
    if (msUntilStart > 0) {
      logStatus(
        "Start signal received. Track begins soon. Enter family name & tap ARM to be ready."
      );
    } else {
      logStatus(
        "Track is already playing. Enter family name & tap ARM to join in progress."
      );
    }
  }
}

function handleLateJoin(startTimeFromServer) {
  serverStartTime = startTimeFromServer;

  const serverNow = getServerNow();
  const msSinceStart = serverNow - serverStartTime;

  if (msSinceStart < 0) {
    if (armed) {
      scheduleOrJoin();
    } else {
      logStatus(
        "Track scheduled to start soon. Enter family name & tap ARM to be ready."
      );
    }
    return;
  }

  if (armed) {
    logStatus("Music already playing. Joining in progress…");
    scheduleOrJoin();
  } else {
    logStatus(
      "Music already playing. Enter family name & tap ARM to join in progress."
    );
  }
}

function scheduleOrJoin() {
  if (!serverStartTime) {
    logStatus("No start time set yet.");
    return;
  }

  const serverNow = getServerNow();
  const msUntilStart = serverStartTime - serverNow;

  if (isIOS) {
    if (!htmlAudio) {
      logStatus("iOS audio not ready.");
      return;
    }

    if (msUntilStart > 0) {
      logStatus(
        "Music scheduled to start in " + Math.round(msUntilStart) + " ms."
      );
      setTimeout(() => {
        htmlAudio
          .play()
          .catch((err) => {
            console.error("Error playing audio on iOS:", err);
            logStatus("Error playing audio on iOS: " + err.message);
          });
      }, msUntilStart);
    } else {
      const offsetSeconds = -msUntilStart / 1000;
      console.log("iOS joining in progress at offset (s):", offsetSeconds);
      htmlAudio.currentTime = offsetSeconds;
      htmlAudio
        .play()
        .catch((err) => {
          console.error("Error playing audio on iOS:", err);
          logStatus("Error playing audio on iOS: " + err.message);
        });
    }
  } else {
    if (!audioCtx || !audioBuffer) {
      logStatus("Audio not ready on this device.");
      return;
    }

    // Stop any previous playback
    if (currentSource) {
      try {
        currentSource.stop();
      } catch (e) {}
      currentSource = null;
    }

    if (msUntilStart > 0) {
      const secondsUntilStart = msUntilStart / 1000;
      const when = audioCtx.currentTime + secondsUntilStart;

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.start(when);
      currentSource = source;

      logStatus(
        "Music scheduled to start in " + Math.round(msUntilStart) + " ms."
      );
      console.log(
        "Scheduling start at audioCtx.currentTime +",
        secondsUntilStart
      );
    } else {
      const offsetSeconds = -msUntilStart / 1000;
      console.log("Joining in progress at offset (s):", offsetSeconds);

      const when = audioCtx.currentTime + 0.1; // tiny delay for safety
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.start(when, offsetSeconds);
      currentSource = source;

      logStatus("Joining in progress…");
    }
  }
}

function handleStop() {
  console.log("Received STOP from server");
  stopPlayback();
}

function stopPlayback() {
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

  serverStartTime = null;
  armed = false;
  updateArmButtonState();

  logStatus(
    "Broadcast ended. Enter family name & tap ARM to be ready for the next track."
  );
}

connectWS();
