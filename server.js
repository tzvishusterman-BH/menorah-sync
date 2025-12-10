const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

// ==========================
// TRACK DEFINITIONS
// ==========================
const TRACKS = {
  "tyh": {
    id: "tyh",
    name: "Thank You Hashem",
    file: "TYH.mp3",
    duration: 532000
  },
  "matisyahu": {
    id: "matisyahu",
    name: "Matisyahu",
    file: "Matisyahu.mp3",
    duration: 247000
  },
  "yoniz": {
    id: "yoniz",
    name: "Yoni Z",
    file: "Yoni Z.mp3",
    duration: 151000
  },
  "mendykraus": {
    id: "mendykraus",
    name: "Mendy Kraus",
    file: "Mendy Kraus.mp3",
    duration: 803000
  },
  "meirshitrit": {
    id: "meirshitrit",
    name: "Meir Shitrit",
    file: "Meir Shitrit.mp3",
    duration: 2104000
  },
  "menachemlifshitz": {
    id: "menachemlifshitz",
    name: "Menachem Lifshitz",
    file: "Menachem Lifshitz.mp3",
    duration: 1460000
  },
  "chonimilecki": {
    id: "chonimilecki",
    name: "Choni Milecki",
    file: "Choni Milecki.mp3",
    duration: 1149000
  },
  "djshatz": {
    id: "djshatz",
    name: "DJ Shatz",
    file: "DJ Shatz.mp3",
    duration: 802000
  },
  "srulivnetanel": {
    id: "srulivnetanel",
    name: "Sruli & Netanel",
    file: "Sruli V'Netanel.mp3",
    duration: 206000
  }
};

let currentTrackId = "tyh";

// ==========================
// CONNECTION STORAGE
// ==========================
let clients = new Set();
let adminClients = new Set();
let clientMeta = new Map(); // ws → metadata

let nextClientId = 1;

// ==========================
// BROADCAST STATE
// ==========================
let broadcastState = {
  mode: "idle",
  trackId: "tyh",
  serverStartTime: null,
  pausedAt: null
};

// ==========================
// HEARTBEAT FOR RENDER
// ==========================
function heartbeat() { this.isAlive = true; }

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ==========================
// HELPERS
// ==========================
function broadcastToClients(obj) {
  const json = JSON.stringify(obj);
  for (const c of clients)
    if (c.readyState === WebSocket.OPEN) c.send(json);
}

function broadcastToAdmins(obj) {
  const json = JSON.stringify(obj);
  for (const a of adminClients)
    if (a.readyState === WebSocket.OPEN) a.send(json);
}

function broadcastStateUpdate() {
  broadcastToClients({ type: "state", state: broadcastState });
  broadcastToAdmins({ type: "state", state: broadcastState });
}

function sendClientList() {
  const list = [];
  for (const ws of clients) {
    const m = clientMeta.get(ws);
    if (!m) continue;
    list.push({
      id: m.id,
      name: m.name,
      armed: m.armed,
      playing: m.playing,
      paused: m.paused
    });
  }
  broadcastToAdmins({ type: "clients", clients: list });
}

// ==========================
// MAIN CONNECTION HANDLER
// ==========================
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.role = "client"; // default

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --------------------------
    // HELLO / ROLE SETUP
    // --------------------------
    if (msg.type === "hello") {
      if (msg.role === "admin") {
        ws.role = "admin";
        adminClients.add(ws);

        ws.send(JSON.stringify({ type: "tracks", tracks: Object.values(TRACKS) }));
        broadcastStateUpdate();
        sendClientList();

      } else {
        ws.role = "client";
        clients.add(ws);

        clientMeta.set(ws, {
          id: nextClientId++,
          name: null,
          armed: false,
          playing: false,
          paused: false
        });

        ws.send(JSON.stringify({ type: "tracks", tracks: Object.values(TRACKS) }));
        ws.send(JSON.stringify({ type: "state", state: broadcastState }));

        sendClientList();
      }
      return;
    }

    // --------------------------
    // CLIENT EVENTS
    // --------------------------
    if (ws.role === "client") {

      if (msg.type === "register") {
        const m = clientMeta.get(ws);
        if (m) {
          m.name = msg.name;
          sendClientList();
        }
        return;
      }

      if (msg.type === "armed") {
        const m = clientMeta.get(ws);
        if (m) {
          m.armed = true;
          sendClientList();
        }
        return;
      }

      if (msg.type === "clientState") {
        const m = clientMeta.get(ws);
        if (m) {
          m.playing = msg.playing;
          m.paused = msg.paused;
          sendClientList();
        }
        return;
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({
          type: "pong",
          clientSendTime: msg.clientSendTime,
          serverTime: Date.now()
        }));
        return;
      }
    }

    // --------------------------
    // ADMIN CONTROLS
    // --------------------------
    if (ws.role === "admin") {

      // STOP
      if (msg.type === "stop") {
        broadcastState.mode = "idle";
        broadcastState.serverStartTime = null;
        broadcastState.pausedAt = null;

        broadcastToClients({ type: "stop" });
        broadcastStateUpdate();
        return;
      }

      // SEEK (switch track + play at position)
      if (msg.type === "seek") {
        const offset = msg.offsetMs;
        const now = Date.now();

        // update track
        if (msg.trackId && TRACKS[msg.trackId]) {
          currentTrackId = msg.trackId;
          broadcastState.trackId = currentTrackId;
        }

        broadcastState.mode = "playing";
        broadcastState.pausedAt = null;
        broadcastState.serverStartTime = now - offset;

        broadcastToClients({
          type: "seek",
          serverStartTime: broadcastState.serverStartTime,
          trackId: currentTrackId
        });

        broadcastStateUpdate();
        return;
      }
    }
  });

  // --------------------------
  // DISCONNECT
  // --------------------------
  ws.on("close", () => {
    clients.delete(ws);
    adminClients.delete(ws);
    clientMeta.delete(ws);
    sendClientList();
  });
});

// ==========================
// START SERVER
// ==========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () =>
  console.log("Menorah Sync Server running on port", PORT)
);
