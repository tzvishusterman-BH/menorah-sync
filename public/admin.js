const PIN = "130865";

const pinScreen = document.getElementById("pinScreen");
const pinInput = document.getElementById("pinInput");
const enterPinBtn = document.getElementById("enterPinBtn");
const pinError = document.getElementById("pinError");

const adminPanel = document.getElementById("adminPanel");

const trackSelect = document.getElementById("trackSelect");
const seekSlider = document.getElementById("seekSlider");
const timeDisplay = document.getElementById("timeDisplay");
const seekGo = document.getElementById("seekGo");
const stopBtn = document.getElementById("stopBtn");

const stateMode = document.getElementById("stateMode");
const stateTime = document.getElementById("stateTime");
const localClock = document.getElementById("localClock");
const clientList = document.getElementById("clientList");

let ws;
let trackMap = {};
let currentDuration = 0;
let playInterval = null;
let lastState = null;

// ------------- LIVE CLOCK -------------
setInterval(() => {
  const d = new Date();
  localClock.textContent =
    d.toTimeString().split(" ")[0]; // HH:MM:SS
}, 1000);

// Format mm:ss
function fmt(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
}

// ------------- WEBSOCKET -------------
function connectWS() {
  ws = new WebSocket(
    location.protocol === "https:" ?
    `wss://${location.host}` :
    `ws://${location.host}`
  );

  ws.onopen = () => {
    ws.send(JSON.stringify({ type:"hello", role:"admin" }));
  };

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);

    if (msg.type === "tracks") {
      trackSelect.innerHTML = "";
      trackMap = {};

      msg.tracks.forEach(t => {
        trackMap[t.id] = t;
        const op = document.createElement("option");
        op.value = t.id;
        op.textContent = t.name;
        trackSelect.appendChild(op);
      });

      updateDuration();
    }

    if (msg.type === "state") {
      updateState(msg.state);
    }

    if (msg.type === "clients") {
      updateClients(msg.clients);
    }
  };
}

// ------------- CLIENT LIST -------------
function updateClients(list) {
  clientList.innerHTML = "";
  list.forEach(c => {
    const li = document.createElement("li");
    li.innerHTML =
      `<strong>${c.name || "Unnamed"}</strong> 
      – Armed: ${c.armed ? "🟢" : "⚪"} 
      – Playing: ${c.playing ? "▶" : "⏸"}`;
    clientList.appendChild(li);
  });
}

// ------------- TRACK DURATIONS -------------
function updateDuration() {
  const t = trackMap[trackSelect.value];
  if (!t) return;
  currentDuration = t.duration;
  seekSlider.max = currentDuration;
  timeDisplay.textContent = `00:00 / ${fmt(currentDuration)}`;
}

trackSelect.onchange = () => { updateDuration(); };

// ------------- STATE HANDLING -------------
function clearPlayInterval() {
  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
  }
}

function updateState(st) {
  lastState = st;

  stateMode.textContent = st.mode;

  if (st.trackId && trackMap[st.trackId]) {
    trackSelect.value = st.trackId;
    updateDuration();
  }

  clearPlayInterval();

  if (st.mode === "playing") {
    playInterval = setInterval(() => {
      const now = Date.now();
      const offset = now - st.serverStartTime;

      stateTime.textContent = fmt(offset);
      seekSlider.value = offset;
      timeDisplay.textContent = `${fmt(offset)} / ${fmt(currentDuration)}`;

    }, 200);

  } else if (st.mode === "paused") {
    stateTime.textContent = fmt(st.pausedAt);
    seekSlider.value = st.pausedAt;
    timeDisplay.textContent = `${fmt(st.pausedAt)} / ${fmt(currentDuration)}`;

  } else {
    stateTime.textContent = "00:00";
    seekSlider.value = 0;
    timeDisplay.textContent = `00:00 / ${fmt(currentDuration)}`;
  }
}

// ------------- CONTROLS -------------
seekGo.onclick = () => {
  const offset = Number(seekSlider.value) || 0;

  ws.send(JSON.stringify({
    type: "seek",
    offsetMs: offset,
    trackId: trackSelect.value
  }));
};

seekSlider.oninput = () => {
  timeDisplay.textContent = `${fmt(seekSlider.value)} / ${fmt(currentDuration)}`;
};

stopBtn.onclick = () => {
  ws.send(JSON.stringify({ type:"stop" }));
};

// ------------- PIN SYSTEM -------------
enterPinBtn.onclick = () => {
  if (pinInput.value.trim() === PIN) {
    pinScreen.style.display = "none";
    adminPanel.style.display = "block";
    connectWS();
  } else {
    pinError.textContent = "Incorrect PIN";
  }
};
