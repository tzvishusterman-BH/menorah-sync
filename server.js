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

// ==========================
// STATE
// ==========================
let playlist = Object.keys(TRACKS);
let currentIndex = -1;
let state = {
  playing: false,
  trackId: null,
  startTime: null
};

const clients = new Set();
const admins = new Set();
const clientNames = new Map();

// ==========================
// HELPERS
// ==========================
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(set, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ==========================
// PLAYBACK ENGINE
// ==========================
function startTrackByIndex(index) {
  if (index < 0 || index >= playlist.length) return;

  currentIndex = index;
  const trackId = playlist[index];

  state.playing = true;
  state.trackId = trackId;
  state.startTime = Date.now();

  broadcast(clients, {
    type: "play",
    trackId,
    startTime: state.startTime
  });

  broadcast(admins, { type: "state", state });

  setTimeout(() => {
    startTrackByIndex((currentIndex + 1) % playlist.length);
  }, TRACKS[trackId].duration);
}

// ==========================
// WEBSOCKET
// ==========================
wss.on("connection", (ws) => {
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- HELLO ----
    if (msg.type === "hello") {
      ws.role = msg.role;

      if (ws.role === "client") {
        clients.add(ws);
        send(ws, { type: "tracks", tracks: TRACKS });
        send(ws, { type: "state", state });
        broadcast(admins, { type: "clients", list: [...clientNames.values()] });
      }

      if (ws.role === "admin") {
        admins.add(ws);
        send(ws, { type: "tracks", tracks: TRACKS });
        send(ws, { type: "playlist", playlist });
        send(ws, { type: "state", state });
      }
      return;
    }

    // ---- CLIENT ----
    if (ws.role === "client") {
      if (msg.type === "register") {
        clientNames.set(ws, msg.name);
        broadcast(admins, { type: "clients", list: [...clientNames.values()] });
      }
    }

    // ---- ADMIN ----
    if (ws.role === "admin") {
      if (msg.type === "startPlaylist") {
        startTrackByIndex(0);
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    admins.delete(ws);
    clientNames.delete(ws);
    broadcast(admins, { type: "clients", list: [...clientNames.values()] });
  });
});

server.listen(process.env.PORT || 3000, () =>
  console.log("Menorah Sync running")
);
