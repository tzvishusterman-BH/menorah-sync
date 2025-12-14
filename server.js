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

// Countdown length (everyone starts together)
const START_LEAD_MS = 3000;

// Global state
let state = {
  playing: false,
  trackId: null,
  startTime: null // server epoch ms when the track began (or will begin if in future)
};

const clients = new Set();
const admins = new Set();
const clientNames = new Map(); // ws -> name

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(group, obj) {
  const data = JSON.stringify(obj);
  for (const ws of group) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastState() {
  broadcast(clients, { type: "state", state });
  broadcast(admins, { type: "state", state });
}

function broadcastClientsList() {
  broadcast(admins, { type: "clients", list: [...clientNames.values()] });
}

wss.on("connection", (ws) => {
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Time sync (preset clock)
    if (msg.type === "timeSync") {
      send(ws, {
        type: "timeSync",
        clientSend: msg.clientSend,
        serverTime: Date.now()
      });
      return;
    }

    if (msg.type === "hello") {
      ws.role = msg.role;

      if (ws.role === "client") {
        clients.add(ws);
        send(ws, { type: "tracks", tracks: TRACKS });
        send(ws, { type: "state", state });
        broadcastClientsList();
        return;
      }

      if (ws.role === "admin") {
        admins.add(ws);
        send(ws, { type: "tracks", tracks: TRACKS });
        send(ws, { type: "state", state });
        broadcastClientsList();
        return;
      }
      return;
    }

    // Client register name
    if (ws.role === "client" && msg.type === "register") {
      const name = String(msg.name || "").trim();
      if (name) clientNames.set(ws, name);
      broadcastClientsList();
      return;
    }

    // Admin controls
    if (ws.role === "admin") {
      if (msg.type === "play") {
        const trackId = msg.trackId;
        if (!TRACKS[trackId]) return;

        state.playing = true;
        state.trackId = trackId;
        state.startTime = Date.now() + START_LEAD_MS;

        // Broadcast play with fixed startTime
        broadcast(clients, { type: "play", trackId, startTime: state.startTime });
        broadcast(admins, { type: "play", trackId, startTime: state.startTime });
        broadcastState();
        return;
      }

      if (msg.type === "stop") {
        state.playing = false;
        state.trackId = null;
        state.startTime = null;

        broadcast(clients, { type: "stop" });
        broadcast(admins, { type: "stop" });
        broadcastState();
        return;
      }

      // Optional: hard resync in middle (keeps same track position, re-aligns everyone)
      if (msg.type === "resync") {
        if (!state.playing || !state.trackId || !state.startTime) return;

        const elapsed = Date.now() - state.startTime; // can be negative during countdown
        const elapsedClamped = Math.max(0, elapsed);

        // schedule a new future start that preserves progress
        state.startTime = Date.now() + START_LEAD_MS - elapsedClamped;

        broadcast(clients, { type: "resync", trackId: state.trackId, startTime: state.startTime });
        broadcast(admins, { type: "resync", trackId: state.trackId, startTime: state.startTime });
        broadcastState();
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
