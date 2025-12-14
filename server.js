const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

// ==========================
// TRACK DEFINITIONS (ALL)
// ==========================
const TRACKS = {
  tyh: { id: "tyh", name: "Thank You Hashem", file: "TYH.mp3", duration: 532000 },
  matisyahu: { id: "matisyahu", name: "Matisyahu", file: "Matisyahu.mp3", duration: 247000 },
  yoniz: { id: "yoniz", name: "Yoni Z", file: "Yoni Z.mp3", duration: 151000 },
  mendykraus: { id: "mendykraus", name: "Mendy Kraus", file: "Mendy Kraus.mp3", duration: 803000 },
  meirshitrit: { id: "meirshitrit", name: "Meir Shitrit", file: "Meir Shitrit.mp3", duration: 2104000 },
  menachemlifshitz: { id: "menachemlifshitz", name: "Menachem Lifshitz", file: "Menachem Lifshitz.mp3", duration: 1460000 },
  chonimilecki: { id: "chonimilecki", name: "Choni Milecki", file: "Choni Milecki.mp3", duration: 1149000 },
  djshatz: { id: "djshatz", name: "DJ Shatz", file: "DJ Shatz.mp3", duration: 802000 },
  srulivnetanel: { id: "srulivnetanel", name: "Sruli & Netanel", file: "Sruli V'Netanel.mp3", duration: 206000 }
};

// Default playlist order (Option B)
let playlist = [
  "tyh",
  "matisyahu",
  "yoniz",
  "mendykraus",
  "meirshitrit",
  "menachemlifshitz",
  "chonimilecki",
  "djshatz",
  "srulivnetanel"
];

let currentIndex = -1;

// Broadcast state
let state = {
  playing: false,
  trackId: null,
  startTime: null
};

let nextTimer = null;

// Connections
const clients = new Set();
const admins = new Set();
const clientNames = new Map(); // ws -> string

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(set, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastState() {
  broadcast(admins, { type: "state", state });
  broadcast(clients, { type: "state", state });
}

function broadcastClientsList() {
  broadcast(admins, { type: "clients", list: [...clientNames.values()] });
}

function clearNextTimer() {
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = null;
}

function scheduleAutoNext() {
  clearNextTimer();
  if (!state.playing || !state.trackId) return;

  const dur = TRACKS[state.trackId]?.duration;
  if (!dur) return;

  nextTimer = setTimeout(() => {
    playByIndex((currentIndex + 1) % playlist.length);
  }, dur);
}

function playByIndex(index) {
  if (!playlist.length) return;
  if (index < 0) index = playlist.length - 1;
  if (index >= playlist.length) index = 0;

  const trackId = playlist[index];
  if (!TRACKS[trackId]) return;

  currentIndex = index;

  state.playing = true;
  state.trackId = trackId;
  state.startTime = Date.now();

  // Tell clients to play this track at this startTime
  broadcast(clients, { type: "play", trackId, startTime: state.startTime });

  // Update admins + clients with state
  broadcastState();

  // Auto-advance
  scheduleAutoNext();
}

function startPlaylist() {
  playByIndex(0);
}

function playTrack(trackId) {
  const idx = playlist.indexOf(trackId);
  if (idx === -1) return;
  playByIndex(idx);
}

function skip() {
  if (!playlist.length) return;
  playByIndex((currentIndex + 1) % playlist.length);
}

function back() {
  if (!playlist.length) return;

  // Back Rule A (same as earlier): if > 5s into track, restart same track, else previous
  if (state.playing && state.startTime) {
    const msInto = Date.now() - state.startTime;
    if (msInto > 5000) {
      playByIndex(currentIndex);
      return;
    }
  }
  playByIndex(currentIndex - 1);
}

function stop() {
  clearNextTimer();
  state.playing = false;
  state.trackId = null;
  state.startTime = null;

  broadcast(clients, { type: "stop" });
  broadcastState();
}

wss.on("connection", (ws) => {
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "hello") {
      ws.role = msg.role;

      if (ws.role === "client") {
        clients.add(ws);
        send(ws, { type: "tracks", tracks: TRACKS });
        send(ws, { type: "playlist", playlist });
        send(ws, { type: "state", state });
        broadcastClientsList();
        return;
      }

      if (ws.role === "admin") {
        admins.add(ws);
        send(ws, { type: "tracks", tracks: TRACKS });
        send(ws, { type: "playlist", playlist });
        send(ws, { type: "state", state });
        broadcastClientsList();
        return;
      }
    }

    if (ws.role === "client") {
      if (msg.type === "register") {
        const name = String(msg.name || "").trim();
        if (name) clientNames.set(ws, name);
        broadcastClientsList();
      }
      return;
    }

    if (ws.role === "admin") {
      if (msg.type === "startPlaylist") {
        startPlaylist();
        return;
      }
      if (msg.type === "playTrack") {
        if (TRACKS[msg.trackId]) playTrack(msg.trackId);
        return;
      }
      if (msg.type === "skip") {
        skip();
        return;
      }
      if (msg.type === "back") {
        back();
        return;
      }
      if (msg.type === "stop") {
        stop();
        return;
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    admins.delete(ws);
    clientNames.delete(ws);
    broadcastClientsList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Menorah Sync running on port", PORT);
});
