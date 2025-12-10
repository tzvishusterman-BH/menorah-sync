//-------------------------------------------------------------
//  ADMIN CONTROL CENTER — Berlin Menorah Parade 5786
//  Playlist Editor + Queue Engine + Skip/Back (Rule A)
//  Terminate (Kick) Clients • Soft Chime Notifications
//  Language System • PIN Screen • Live Clock
//-------------------------------------------------------------

let ws;
let tracks = {};                 // trackId → {id, name, file, duration}
let playlist = [];               // ordered array of track IDs
let broadcastState = {};         // state from server
let clients = [];                // connected clients

// UI Elements
const pinScreen = document.getElementById("pinScreen");
const adminPanel = document.getElementById("adminPanel");
const pinInput = document.getElementById("pinInput");
const pinError = document.getElementById("pinError");
const enterPinBtn = document.getElementById("enterPinBtn");

const playlistContainer = document.getElementById("playlistContainer");
const addTrackSelect = document.getElementById("addTrackSelect");
const addTrackBtn = document.getElementById("addTrackBtn");
const nextOverrideSelect = document.getElementById("nextOverrideSelect");

const seekSlider = document.getElementById("seekSlider");
const timeLabel = document.getElementById("timeLabel");
const nowPlayingEl = document.getElementById("nowPlaying");

const clientListEl = document.getElementById("clientList");
const clientCountEl = document.getElementById("clientCount");

const backBtn = document.getElementById("backBtn");
const skipBtn = document.getElementById("skipBtn");
const stopBtn = document.getElementById("stopBtn");

const langSelect = document.getElementById("langSelect");

//==============================================================
//   1.  PIN SCREEN
//==============================================================

enterPinBtn.addEventListener("click", () => {
  const entered = pinInput.value.trim();
  const correct = "130865";     // Your PIN

  if (entered !== correct) {
    pinError.innerText = "Incorrect PIN";
    return;
  }

  pinScreen.style.display = "none";
  adminPanel.style.display = "block";

  initWebSocket();
});

//==============================================================
//   2.  WEBSOCKET SETUP
//==============================================================

function initWebSocket() {
  ws = new WebSocket(location.origin.replace(/^http/, "ws"));

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", role: "admin" }));
  };

  ws.onmessage = msg => {
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }

    switch (data.type) {

      case "tracks":
        tracks = {};
        data.tracks.forEach(t => tracks[t.id] = t);
        populateTrackSelectors();
        break;

      case "playlist":
        playlist = data.playlist;
        renderPlaylist();
        break;

      case "state":
        broadcastState = data.state;
        updateStateUI();
        break;

      case "clients":
        clients = data.clients;
        renderClientList();
        break;

      case "trackEnded":
        playChime();
        showToast("Track ended — starting next...");
        break;
    }
  };
}

//==============================================================
//   3.  PLAYLIST UI RENDERING
//==============================================================

// Build dropdowns for Add Track & Next Override
function populateTrackSelectors() {
  addTrackSelect.innerHTML = "";
  nextOverrideSelect.innerHTML = "<option value=''>---</option>";

  for (const id in tracks) {
    const t = tracks[id];

    let opt1 = document.createElement("option");
    opt1.value = t.id;
    opt1.textContent = t.name;
    addTrackSelect.appendChild(opt1);

    let opt2 = document.createElement("option");
    opt2.value = t.id;
    opt2.textContent = t.name;
    nextOverrideSelect.appendChild(opt2);
  }
}

addTrackBtn.addEventListener("click", () => {
  const id = addTrackSelect.value;
  if (!id) return;

  playlist.push(id);
  sendPlaylist();
});

// Build playlist list view
function renderPlaylist() {
  playlistContainer.innerHTML = "";

  playlist.forEach((id, index) => {
    const t = tracks[id];
    if (!t) return;

    const card = document.createElement("div");
    card.className = "trackCard";
    card.draggable = true;
    card.dataset.index = index;

    // Highlight if playing
    if (broadcastState.trackId === id) {
      card.style.border = "2px solid #1db954";
    }

    const name = document.createElement("div");
    name.className = "trackName";
    name.textContent = t.name;

    const del = document.createElement("button");
    del.className = "deleteTrack";
    del.textContent = "X";
    del.onclick = () => {
      playlist.splice(index, 1);
      sendPlaylist();
    };

    card.appendChild(name);
    card.appendChild(del);

    // Drag events
    card.addEventListener("dragstart", onDragStart);
    card.addEventListener("dragover", onDragOver);
    card.addEventListener("drop", onDrop);

    playlistContainer.appendChild(card);
  });
}

let dragIndex = null;

function onDragStart(e) {
  dragIndex = Number(e.target.dataset.index);
}

function onDragOver(e) {
  e.preventDefault();
}

function onDrop(e) {
  const dropIndex = Number(e.target.closest(".trackCard").dataset.index);
  const item = playlist.splice(dragIndex, 1)[0];
  playlist.splice(dropIndex, 0, item);
  sendPlaylist();
}

// Send updated playlist to server
function sendPlaylist() {
  ws.send(JSON.stringify({ type: "playlistSet", playlist }));
}

//==============================================================
//   4.  NEXT OVERRIDE
//==============================================================

nextOverrideSelect.addEventListener("change", () => {
  const val = nextOverrideSelect.value;
  if (val) {
    ws.send(JSON.stringify({ type: "setNextOverride", trackId: val }));
    showToast("Next track override set.");
  }
});

//==============================================================
//   5.  CLIENT LIST + TERMINATE
//==============================================================

function renderClientList() {
  clientListEl.innerHTML = "";
  clientCountEl.textContent = `${clients.length} Cars Connected`;

  clients.forEach(c => {
    const row = document.createElement("div");

    const name = document.createElement("div");
    name.textContent = c.name || "(Unnamed)";

    const kill = document.createElement("button");
    kill.className = "terminateBtn";
    kill.textContent = "Terminate";
    kill.onclick = () => {
      ws.send(JSON.stringify({
        type: "terminateClient",
        clientId: c.id
      }));
    };

    row.appendChild(name);
    row.appendChild(kill);
    clientListEl.appendChild(row);
  });
}

//==============================================================
//   6.  CONTROL BUTTONS — SKIP/BACK/STOP
//==============================================================

backBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "back" }));
});

skipBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "skip" }));
});

stopBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "stop" }));
});

//==============================================================
//   7.  NOW PLAYING + SEEK BAR
//==============================================================

function updateStateUI() {
  if (!broadcastState || !broadcastState.trackId) {
    nowPlayingEl.textContent = "Now Playing: —";
    seekSlider.value = 0;
    timeLabel.textContent = "00:00 / 00:00";
    return;
  }

  const t = tracks[broadcastState.trackId];
  nowPlayingEl.textContent = "Now Playing: " + t.name;

  // Update playlist highlight
  renderPlaylist();

  if (!broadcastState.serverStartTime) return;

  const now = Date.now();
  const elapsed = now - broadcastState.serverStartTime;

  let dur = t.duration;
  let pct = Math.min(100, Math.floor((elapsed / dur) * 100));
  seekSlider.value = pct;

  function fmt(ms) {
    let s = Math.floor(ms / 1000);
    let m = Math.floor(s / 60);
    s = s % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  timeLabel.textContent =
    `${fmt(elapsed)} / ${fmt(dur)}`;
}

setInterval(updateStateUI, 250);

//==============================================================
//   8.  NOTIFICATIONS (Soft Chime + Toast)
//==============================================================

function playChime() {
  const audio = new Audio("chime.mp3");
  audio.volume = 0.4;
  audio.play().catch(() => {});
}

function showToast(msg) {
  const toast = document.createElement("div");
  toast.textContent = msg;
  toast.style.position = "fixed";
  toast.style.bottom = "20px";
  toast.style.left = "50%";
  toast.style.transform = "translateX(-50%)";
  toast.style.background = "#1db954";
  toast.style.color = "black";
  toast.style.padding = "12px 20px";
  toast.style.borderRadius = "10px";
  toast.style.fontWeight = "bold";
  toast.style.zIndex = 9999;
  toast.style.opacity = 1;
  toast.style.transition = "opacity 1s ease-out";

  document.body.appendChild(toast);

  setTimeout(() => toast.style.opacity = 0, 1500);
  setTimeout(() => toast.remove(), 2600);
}

//==============================================================
//   9.  LANGUAGE SYSTEM
//==============================================================

langSelect.addEventListener("change", () => {
  const lang = langSelect.value;
  localStorage.setItem("adminLang", lang);
  applyTranslations(lang);
});

function applyTranslations(lang) {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    el.textContent = translations[lang][key] || key;
  });
}

// Load saved language:
const savedLang = localStorage.getItem("adminLang") || "en";
langSelect.value = savedLang;
applyTranslations(savedLang);

//==============================================================
//   10. LIVE CLOCK
//==============================================================

const clockEl = document.getElementById("clock");

setInterval(() => {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  clockEl.textContent = `${h}:${m}:${s}`;
}, 500);
