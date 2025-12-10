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
// CONNECTION SETS
// ==========================
let clients = new Set();
let adminClients = new Set();

// client metadata: ws → { id, name, armed, playing, paused }
let clientMeta = new Map();
let nextClientId = 1;

// ==========================
// BROADCAST STATE MACHINE
// ==========================
// mode:
//   - idle
//   - scheduled (start in X seconds)
//   - playing
//   - paused
//
// serverStartTime = timestamp (ms) music begins playing
// pausedAt = offset inside the track (ms)
let broadcastState = {
  mode: "idle",
  trackId: "tyh",
  serverStartTime: null,
  pausedAt: null
};

// ==========================
// HEARTBEAT (RENDER)
// ==========================
function heartbeat() {
  this.isAlive = true;
}

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ==========================
// HELPERS
// ==========================

function getTrack(id) {
  return TRACKS[id] || TRACKS["tyh"];
}

function broadcastToClients(obj) {
  const json = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(json);
  }
}

function broadcastToAdmins(obj) {
  const json = JSON.stringify(obj);
  for (const a of adminClients) {
    if (a.readyState === WebSocket.OPEN) a.send(json);
  }
}

function broadcastStateUpdate() {
  broadcastToAdmins({
    type: "state",
    state: broadcastState
  });
  broadcastToClients({
    type: "state",
    state: broadcastState
  });
}

function sendClientList() {
  const list = [];
  for (const ws of clients) {
    const meta = clientMeta.get(ws);
    if (!meta) continue;
    list.push({
      id: meta.id,
      name: meta.name,
      armed: meta.armed,
      playing: meta.playing,
      paused: meta.paused
    });
  }
  broadcastToAdmins({
    type: "clients",
    clients: list
  });
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
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // ========== ROLE DECLARATION ==========
    if (msg.type === "hello") {
      if (msg.role === "admin") {
        ws.role = "admin";
        adminClients.add(ws);

        // send track list
        ws.send(JSON.stringify({
          type: "tracks",
          tracks: Object.values(TRACKS)
        }));

        // send current state
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

        // send tracks
        ws.send(JSON.stringify({
          type: "tracks",
          tracks: Object.values(TRACKS)
        }));

        // send state
        ws.send(JSON.stringify({
          type: "state",
          state: broadcastState
        }));

        sendClientList();
      }
      return;
    }

    // ========== CLIENT: REGISTER NAME ==========
    if (msg.type === "register" && ws.role === "client") {
      const meta = clientMeta.get(ws);
      if (meta) {
        meta.name = msg.name;
        sendClientList();
      }
      return;
    }

    // ========== CLIENT: ARMED ==========
    if (msg.type === "armed" && ws.role === "client") {
      const meta = clientMeta.get(ws);
      if (meta) {
        meta.armed = true;
        sendClientList();
      }
      return;
    }

    // ========== CLIENT: UPDATE PLAYING / PAUSED ==========
    if (msg.type === "clientState" && ws.role === "client") {
      const meta = clientMeta.get(ws);
      if (meta) {
        meta.playing = msg.playing;
        meta.paused = msg.paused;
        sendClientList();
      }
      return;
    }

    // ========== CLOCK SYNC ==========
    if (msg.type === "ping") {
      ws.send(JSON.stringify({
        type: "pong",
        clientSendTime: msg.clientSendTime,
        serverTime: Date.now()
      }));
      return;
    }

    // ======================================================
    // ================ ADMIN CONTROLS ======================
    // ======================================================

    // ========== ADMIN: START ==========
    if (msg.type === "start" && ws.role === "admin") {
      const delayMs = Number(msg.delayMs);
      const now = Date.now();

      currentTrackId = msg.trackId || "tyh";

      broadcastState.mode = "scheduled";
      broadcastState.trackId = currentTrackId;
      broadcastState.serverStartTime = now + delayMs;
      broadcastState.pausedAt = null;

      // notify clients of start time
      broadcastToClients({
        type: "start",
        trackId: currentTrackId,
        serverStartTime: broadcastState.serverStartTime
      });

      broadcastStateUpdate();
      return;
    }

    // ========== ADMIN: STOP ==========
    if (msg.type === "stop" && ws.role === "admin") {
      broadcastState.mode = "idle";
      broadcastState.serverStartTime = null;
      broadcastState.pausedAt = null;

      broadcastToClients({ type: "stop" });
      broadcastStateUpdate();
      return;
    }

    // ========== ADMIN: PAUSE ==========
    if (msg.type === "pause" && ws.role === "admin") {
      if (broadcastState.mode !== "playing") return;

      const now = Date.now();
      const offset = now - broadcastState.serverStartTime;

      broadcastState.mode = "paused";
      broadcastState.pausedAt = offset;

      broadcastToClients({
        type: "pause",
        pausedAt: offset
      });

      broadcastStateUpdate();
      return;
    }

    // ========== ADMIN: RESUME ==========
    if (msg.type === "resume" && ws.role === "admin") {
      if (broadcastState.mode !== "paused") return;

      const now = Date.now();
      broadcastState.mode = "playing";
      broadcastState.serverStartTime = now - broadcastState.pausedAt;

      broadcastToClients({
        type: "resume",
        serverStartTime: broadcastState.serverStartTime
      });

      broadcastStateUpdate();
      return;
    }

    // ========== ADMIN: SEEK ==========
    if (msg.type === "seek" && ws.role === "admin") {
      const offset = msg.offsetMs;
      const now = Date.now();

      broadcastState.mode = "playing";
      broadcastState.pausedAt = null;
      broadcastState.serverStartTime = now - offset;

      broadcastToClients({
        type: "seek",
        serverStartTime: broadcastState.serverStartTime
      });

      broadcastStateUpdate();
      return;
    }
  });

  // ==========================
  // ON DISCONNECT
  // ==========================
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
server.listen(PORT, "0.0.0.0", () => {
  console.log("Menorah Sync Server running on port", PORT);
});
