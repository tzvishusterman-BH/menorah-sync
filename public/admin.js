let ws;
let tracks = {};          // trackId -> track object
let playlist = [];
let broadcastState = null;
let clients = [];

const pinScreen = document.getElementById("pinScreen");
const adminPanel = document.getElementById("adminPanel");
const pinInput = document.getElementById("pinInput");
const pinError = document.getElementById("pinError");
const enterPinBtn = document.getElementById("enterPinBtn");

const playlistContainer = document.getElementById("playlistContainer");
const addTrackSelect = document.getElementById("addTrackSelect");
const addTrackBtn = document.getElementById("addTrackBtn");
const nextOverrideSelect = document.getElementById("nextOverrideSelect");

const playNowSelect = document.getElementById("playNowSelect");
const playNowBtn = document.getElementById("playNowBtn");

const seekSlider = document.getElementById("seekSlider");
const timeLabel = document.getElementById("timeLabel");
const nowPlayingEl = document.getElementById("nowPlaying");

const clientListEl = document.getElementById("clientList");
const clientCountEl = document.getElementById("clientCount");

const backBtn = document.getElementById("backBtn");
const skipBtn = document.getElementById("skipBtn");
const stopBtn = document.getElementById("stopBtn");

const langSelect = document.getElementById("langSelect");
const clockEl = document.getElementById("clock");

enterPinBtn.addEventListener("click", () => {
  if (pinInput.value.trim() !== "130865") {
    pinError.textContent = "Incorrect PIN";
    return;
  }
  pinScreen.style.display = "none";
  adminPanel.style.display = "block";
  initWebSocket();
});

function initWebSocket() {
  ws = new WebSocket(location.origin.replace(/^http/, "ws"));

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", role: "admin" }));
  };

  ws.onmessage = (evt) => {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }

    if (data.type === "tracks") {
      tracks = {};
      data.tracks.forEach(t => tracks[t.id] = t);
      populateSelectors();
      renderPlaylist();
      updateStateUI();
    }

    if (data.type === "playlist") {
      playlist = data.playlist || [];
      renderPlaylist();
    }

    if (data.type === "state") {
      broadcastState = data.state;
      renderPlaylist();
      updateStateUI();
    }

    if (data.type === "clients") {
      clients = data.clients || [];
      renderClientList();
    }

    if (data.type === "trackEnded") {
      playChime();
      showToast("Track ended — next starting…");
    }
  };
}

function populateSelectors() {
  addTrackSelect.innerHTML = "";
  playNowSelect.innerHTML = "";
  nextOverrideSelect.innerHTML = "<option value=''>---</option>";

  Object.values(tracks).forEach(t => {
    const o1 = document.createElement("option");
    o1.value = t.id; o1.textContent = t.name;
    addTrackSelect.appendChild(o1);

    const o2 = document.createElement("option");
    o2.value = t.id; o2.textContent = t.name;
    playNowSelect.appendChild(o2);

    const o3 = document.createElement("option");
    o3.value = t.id; o3.textContent = t.name;
    nextOverrideSelect.appendChild(o3);
  });
}

addTrackBtn.addEventListener("click", () => {
  const id = addTrackSelect.value;
  if (!id) return;
  playlist.push(id);
  ws.send(JSON.stringify({ type: "playlistSet", playlist }));
});

nextOverrideSelect.addEventListener("change", () => {
  const id = nextOverrideSelect.value;
  if (!id) return;
  ws.send(JSON.stringify({ type: "setNextOverride", trackId: id }));
  showToast("Next override set.");
});

playNowBtn.addEventListener("click", () => {
  const id = playNowSelect.value;
  if (!id) return;
  ws.send(JSON.stringify({ type: "startTrack", trackId: id }));
});

backBtn.addEventListener("click", () => ws.send(JSON.stringify({ type: "back" })));
skipBtn.addEventListener("click", () => ws.send(JSON.stringify({ type: "skip" })));
stopBtn.addEventListener("click", () => ws.send(JSON.stringify({ type: "stop" })));

function renderClientList() {
  clientCountEl.textContent = `${clients.length} Cars Connected`;
  clientListEl.innerHTML = "";

  clients.forEach(c => {
    const row = document.createElement("div");

    const name = document.createElement("div");
    name.textContent = c.name || "(Unnamed)";

    const kill = document.createElement("button");
    kill.className = "terminateBtn";
    kill.textContent = "Terminate";
    kill.onclick = () => ws.send(JSON.stringify({ type: "terminateClient", clientId: c.id }));

    row.appendChild(name);
    row.appendChild(kill);
    clientListEl.appendChild(row);
  });
}

// ---- Playlist drag/drop ----
let dragIndex = null;

function renderPlaylist() {
  playlistContainer.innerHTML = "";

  playlist.forEach((id, index) => {
    const t = tracks[id];
    if (!t) return;

    const card = document.createElement("div");
    card.className = "trackCard";
    card.draggable = true;
    card.dataset.index = String(index);

    if (broadcastState?.trackId === id) {
      card.style.border = "2px solid #1db954";
    }

    // click to play NOW
    card.addEventListener("click", (e) => {
      if (e.target.classList.contains("deleteTrack")) return;
      ws.send(JSON.stringify({ type: "startTrack", trackId: id }));
    });

    const name = document.createElement("div");
    name.className = "trackName";
    name.textContent = t.name;

    const del = document.createElement("button");
    del.className = "deleteTrack";
    del.textContent = "X";
    del.onclick = () => {
      playlist.splice(index, 1);
      ws.send(JSON.stringify({ type: "playlistSet", playlist }));
    };

    card.appendChild(name);
    card.appendChild(del);

    card.addEventListener("dragstart", (e) => dragIndex = Number(e.currentTarget.dataset.index));
    card.addEventListener("dragover", (e) => e.preventDefault());
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      const dropIndex = Number(e.currentTarget.dataset.index);
      const item = playlist.splice(dragIndex, 1)[0];
      playlist.splice(dropIndex, 0, item);
      ws.send(JSON.stringify({ type: "playlistSet", playlist }));
    });

    playlistContainer.appendChild(card);
  });
}

// ---- Now playing + seek display (display-only) ----
function fmt(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`;
}

function updateStateUI() {
  if (!broadcastState || broadcastState.mode !== "playing" || !broadcastState.trackId) {
    nowPlayingEl.textContent = "Now Playing: —";
    seekSlider.value = 0;
    timeLabel.textContent = "00:00 / 00:00";
    return;
  }

  const t = tracks[broadcastState.trackId];
  if (!t) return;

  const elapsed = Date.now() - broadcastState.serverStartTime;
  const dur = t.duration;

  nowPlayingEl.textContent = `Now Playing: ${t.name}`;

  // slider shows percentage only
  const pct = Math.max(0, Math.min(100, Math.round((elapsed / dur) * 100)));
  seekSlider.value = pct;
  timeLabel.textContent = `${fmt(elapsed)} / ${fmt(dur)}`;
}

setInterval(updateStateUI, 250);

// ---- Notifications ----
function playChime() {
  const a = new Audio("chime.mp3");
  a.volume = 0.5;
  a.play().catch(() => {});
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

// ---- Language ----
langSelect.addEventListener("change", () => {
  const lang = langSelect.value;
  localStorage.setItem("adminLang", lang);
  applyTranslations(lang);
});

const saved = localStorage.getItem("adminLang") || "en";
langSelect.value = saved;
applyTranslations(saved);

// ---- Clock ----
setInterval(() => {
  const d = new Date();
  clockEl.textContent =
    `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
}, 300);
