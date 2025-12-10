const PIN = "130865";

const pinScreen = document.getElementById("pinScreen");
const pinInput = document.getElementById("pinInput");
const enterPinBtn = document.getElementById("enterPinBtn");
const pinError = document.getElementById("pinError");

const adminPanel = document.getElementById("adminPanel");
const trackSelect = document.getElementById("trackSelect");
const stopBtn = document.getElementById("stopBtn");
const seekSlider = document.getElementById("seekSlider");
const seekLabel = document.getElementById("seekLabel");
const seekGo = document.getElementById("seekGo");

const stateMode = document.getElementById("stateMode");
const stateTime = document.getElementById("stateTime");
const localClock = document.getElementById("localClock");
const clientList = document.getElementById("clientList");

let ws;
let trackMap = {};
let currentDuration = 532000;
let playbackInterval = null;
let lastState = null;

// ------------ LIVE CLOCK ------------
setInterval(() => {
  const d = new Date();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  localClock.textContent = `${hh}:${mm}:${ss}`;
}, 1000);

function formatMs(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

// ------------ WEBSOCKET ------------
function connectWS() {
  ws = new WebSocket(
    location.protocol === "https:"
      ? `wss://${location.host}`
      : `ws://${location.host}`
  );

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", role: "admin" }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "tracks") {
      // Populate track dropdown
      trackMap = {};
      trackSelect.innerHTML = "";

      msg.tracks.forEach((t) => {
        trackMap[t.id] = t;
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.name;
        trackSelect.appendChild(opt);
      });

      updateTrackDuration();
    }

    if (msg.type === "state") {
      updateState(msg.state);
    }

    if (msg.type === "clients") {
      updateClientList(msg.clients);
    }
  };
}

// ------------ CLIENT LIST ------------
function updateClientList(list) {
  clientList.innerHTML = "";
  list.forEach((c) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${c.name || "Unnamed"}</strong>
      – Armed: ${c.armed ? "🟢" : "⚪"}
      – Playing: ${c.playing ? "▶" : "⏸"}`;
    clientList.appendChild(li);
  });
}

// ------------ TRACK DURATION ------------
function updateTrackDuration() {
  const t = trackMap[trackSelect.value];
  if (!t) return;
  currentDuration = t.duration;
  seekSlider.max = currentDuration;
  seekLabel.textContent = `00:00 / ${formatMs(currentDuration)}`;
}

// When admin changes track manually
trackSelect.onchange = () => {
  updateTrackDuration();
};

// ------------ STATE UPDATES ------------
function clearPlaybackInterval() {
  if (playbackInterval) {
    clearInterval(playbackInterval);
    playbackInterval = null;
  }
}

function updateState(st) {
  lastState = st;
  stateMode.textContent = st.mode;

  // Make dropdown reflect the current track
  if (st.trackId && trackMap[st.trackId]) {
    trackSelect.value = st.trackId;
    updateTrackDuration();
  }

  clearPlaybackInterval();

  if (st.mode === "playing") {
    playbackInterval = setInterval(() => {
      if (!lastState || lastState.mode !== "playing") {
        clearPlaybackInterval();
        return;
      }
      const now = Date.now();
      const offset = now - lastState.serverStartTime;

      stateTime.textContent = formatMs(offset);
      seekSlider.value = offset;
      seekLabel.textContent = `${formatMs(offset)} / ${formatMs(currentDuration)}`;
    }, 200);
  } else if (st.mode === "paused") {
    stateTime.textContent = formatMs(st.pausedAt || 0);
    seekSlider.value = st.pausedAt || 0;
    seekLabel.textContent = `${formatMs(st.pausedAt || 0)} / ${formatMs(currentDuration)}`;
  } else {
    // idle or unknown
    stateTime.textContent = "00:00";
    seekSlider.value = 0;
    seekLabel.textContent = `00:00 / ${formatMs(currentDuration)}`;
  }
}

// ------------ BUTTONS ------------
seekGo.onclick = () => {
  const offset = Number(seekSlider.value) || 0;

  ws.send(JSON.stringify({
    type: "seek",
    offsetMs: offset,
    trackId: trackSelect.value
  }));
};

seekSlider.oninput = () => {
  seekLabel.textContent = `${formatMs(seekSlider.value)} / ${formatMs(currentDuration)}`;
};

stopBtn.onclick = () => {
  ws.send(JSON.stringify({ type: "stop" }));
};

// ------------ PIN ------------
enterPinBtn.onclick = () => {
  if (pinInput.value.trim() === PIN) {
    pinScreen.style.display = "none";
    adminPanel.style.display = "block";
    connectWS();
  } else {
    pinError.textContent = "Incorrect PIN";
  }
};
