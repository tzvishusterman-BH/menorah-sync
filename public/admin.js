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

// ------------ LIVE CLOCK ------------
setInterval(() => {
  const d = new Date();
  const hh = d.getHours().toString().padStart(2,"0");
  const mm = d.getMinutes().toString().padStart(2,"0");
  const ss = d.getSeconds().toString().padStart(2,"0");
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
  seekSlider.max = t.duration;
  seekLabel.textContent = `00:00 / ${formatMs(t.duration)}`;
}

trackSelect.onchange = updateTrackDuration;

// ------------ STATE UPDATES ------------
function updateState(st) {
  stateMode.textContent = st.mode;

  if (st.mode === "playing") {
    const updater = setInterval(() => {
      if (stateMode.textContent !== "playing") {
        clearInterval(updater);
        return;
      }
      const now = Date.now();
      const offset = now - st.serverStartTime;
      stateTime.textContent = formatMs(offset);
      seekSlider.value = offset;
      seekLabel.textContent = `${formatMs(offset)} / ${formatMs(currentDuration)}`;
    }, 200);
  } else if (st.mode === "paused") {
    stateTime.textContent = formatMs(st.pausedAt);
  } else {
    stateTime.textContent = "00:00";
  }
}

// ------------ BUTTONS ------------
seekGo.onclick = () => {
  const offset = Number(seekSlider.value);
  ws.send(JSON.stringify({
    type: "seek",
    offsetMs: offset
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
