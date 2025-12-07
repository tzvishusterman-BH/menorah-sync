const PIN = "130865";

const pinScreen = document.getElementById("pinScreen");
const pinInput = document.getElementById("pinInput");
const enterPinBtn = document.getElementById("enterPinBtn");
const pinError = document.getElementById("pinError");

const adminPanel = document.getElementById("adminPanel");
const trackSelect = document.getElementById("trackSelect");
const delaySeconds = document.getElementById("delaySeconds");
const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const stopBtn = document.getElementById("stopBtn");
const seekSlider = document.getElementById("seekSlider");
const seekLabel = document.getElementById("seekLabel");
const seekGo = document.getElementById("seekGo");

const stateMode = document.getElementById("stateMode");
const stateTime = document.getElementById("stateTime");
const clientList = document.getElementById("clientList");

let ws;
let trackMap = {};
let currentDuration = 532000;

function connectWS() {
  ws = new WebSocket(
    location.protocol==="https:"
    ? `wss://${location.host}`
    : `ws://${location.host}`
  );

  ws.onopen = () => {
    ws.send(JSON.stringify({type:"hello", role:"admin"}));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type==="tracks") {
      trackMap = {};
      trackSelect.innerHTML="";
      msg.tracks.forEach(t=>{
        trackMap[t.id] = t;
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.name;
        trackSelect.appendChild(opt);
      });
      updateTrackDuration();
    }

    if (msg.type==="state") {
      updateState(msg.state);
    }

    if (msg.type==="clients") {
      updateClientList(msg.clients);
    }
  };
}

function updateClientList(list) {
  clientList.innerHTML="";
  list.forEach(c=>{
    const li = document.createElement("li");
    li.innerHTML = `<strong>${c.name || "Unnamed"}</strong>
      – Armed: ${c.armed?"🟢":"⚪"} 
      – Playing: ${c.playing?"▶":"⏸"}`;
    clientList.appendChild(li);
  });
}

function updateState(st) {
  stateMode.textContent = st.mode;

  if (st.mode==="playing") {
    const now = Date.now();
    const offset = now - st.serverStartTime;
    stateTime.textContent = formatMs(offset);
  }
  if (st.mode==="paused") {
    stateTime.textContent = formatMs(st.pausedAt);
  }
}

function updateTrackDuration() {
  const t = trackMap[trackSelect.value];
  if (!t) return;
  currentDuration = t.duration;
  seekSlider.max = t.duration;
  seekLabel.textContent = `00:00 / ${formatMs(t.duration)}`;
}

trackSelect.onchange = updateTrackDuration;

function formatMs(ms) {
  if (ms<0) ms=0;
  const s = Math.floor(ms/1000);
  const m = Math.floor(s/60);
  const ss = (s%60).toString().padStart(2,"0");
  return `${m}:${ss}`;
}

// BUTTON HANDLERS
startBtn.onclick = () => {
  const delay = Number(delaySeconds.value)*1000;
  ws.send(JSON.stringify({
    type:"start",
    delayMs:delay,
    trackId: trackSelect.value
  }));
};

pauseBtn.onclick = () => {
  ws.send(JSON.stringify({type:"pause"}));
};

resumeBtn.onclick = () => {
  ws.send(JSON.stringify({type:"resume"}));
};

stopBtn.onclick = () => {
  ws.send(JSON.stringify({type:"stop"}));
};

seekGo.onclick = () => {
  const offset = Number(seekSlider.value);
  ws.send(JSON.stringify({
    type:"seek",
    offsetMs: offset
  }));
};

seekSlider.oninput = () => {
  seekLabel.textContent = `${formatMs(seekSlider.value)} / ${formatMs(currentDuration)}`;
};

enterPinBtn.onclick = () => {
  if (pinInput.value.trim()===PIN) {
    pinScreen.style.display="none";
    adminPanel.style.display="block";
    connectWS();
  } else {
    pinError.textContent="Incorrect PIN";
  }
};
