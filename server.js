const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

// TRACK DEFINITIONS (expand this later easily)
const TRACKS = {
  "tyh": {
    id: "tyh",
    name: "TYH Upmix",
    file: "track.mp3",
    duration: 532000
  }
};

// CURRENT TRACK
let currentTrackId = "tyh";

// SETS OF CONNECTIONS
let clients = new Set();
let adminClients = new Set();

// PER-CLIENT METADATA
let clientMeta = new Map(); // ws -> { id, name, armed, playing, paused }
let nextClientId = 1;

// STATE MACHINE FOR BROADCAST
let broadcastState = {
  mode: "idle", // idle | scheduled | playing | paused
  trackId: "tyh",
  serverStartTime: null, // only during scheduled or playing
  pausedAt: null // ms offset inside track
};

// HEARTBEAT FOR RENDER
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


// ========= HELPERS ========= //

function getTrack(trackId) {
  return TRACKS[trackId] || TRACKS["tyh"];
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
  const payload = {
    type: "state",
    state: broadcastState
  };
  broadcastToClients(payload);
  broadcastToAdmins(payload);
}

function sendClientListToAllAdmins() {
  const list = [];
  for (const ws of clients) {
    const meta = clientMeta.get(ws);
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


// ========= CONNECTION HANDLING ========= //

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.role = "client";

  ws.on("message", (msgText) => {
    let msg;
    try { msg = JSON.parse(msgText); } catch { return; }

    // Identify role
    if (msg.type === "hello") {
      if (msg.role === "admin") {
        ws.role = "admin";
        adminClients.add(ws);
        ws.send(JSON.stringify({
          type: "tracks",
          tracks: Object.values(TRACKS)
        }));
        broadcastStateUpdate();
        sendClientListToAllAdmins();
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

        // Send initial state
        ws.send(JSON.stringify({
          type: "tracks",
          tracks: Object.values(TRACKS)
        }));

        ws.send(JSON.stringify({
          type: "state",
          state: broadcastState
        }));

        sendClientListToAllAdmins();
      }
      return;
    }

    // Register name
    if (msg.type === "register" && ws.role === "client") {
      const meta = clientMeta.get(ws);
      if (meta) {
        meta.name = msg.name;
        sendClientListToAllAdmins();
      }
      return;
    }

    // Client armed
    if (msg.type === "armed" && ws.role === "client") {
      const meta = clientMeta.get(ws);
      if (meta) {
        meta.armed = true;
        sendClientListToAllAdmins();
      }
      return;
    }

    // Client reports playing / paused state
    if (msg.type === "clientState" && ws.role === "client") {
      const meta = clientMeta.get(ws);
      if (meta) {
        meta.playing = msg.playing;
        meta.paused = msg.paused;
        sendClientListToAllAdmins();
      }
      return;
    }

    // Clock sync
    if (msg.type === "ping") {
      ws.send(JSON.stringify({
        type: "pong",
        clientSendTime: msg.clientSendTime,
        serverTime: Date.now()
      }));
      return;
    }

    // --- ADMIN CONTROLS: Start ---
    if (msg.type === "start" && ws.role === "admin") {
      const delayMs = Number(msg.delayMs);
      const now = Date.now();

      currentTrackId = msg.trackId || "tyh";
      const track = getTrack(currentTrackId);

      broadcastState.mode = "scheduled";
      broadcastState.trackId = currentTrackId;
      broadcastState.serverStartTime = now + delayMs;
      broadcastState.pausedAt = null;

      broadcastToClients({
        type: "start",
        trackId: currentTrackId,
        serverStartTime: broadcastState.serverStartTime
      });

      broadcastStateUpdate();
      return;
    }

    // --- ADMIN: STOP ---
    if (msg.type === "stop" && ws.role === "admin") {
      broadcastState.mode = "idle";
      broadcastState.serverStartTime = null;
      broadcastState.pausedAt = null;

      broadcastToClients({ type: "stop" });
      broadcastStateUpdate();
      return;
    }

    // --- ADMIN: PAUSE ---
    if (msg.type === "pause" && ws.role === "admin") {
      const now = Date.now();
      const start = broadcastState.serverStartTime;
      const offset = now - start;

      broadcastState.mode = "paused";
      broadcastState.pausedAt = offset;

      broadcastToClients({
        type: "pause",
        pausedAt: offset
      });

      broadcastStateUpdate();
      return;
    }

    // --- ADMIN: RESUME ---
    if (msg.type === "resume" && ws.role === "admin") {
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

    // --- ADMIN: SEEK ---
    if (msg.type === "seek" && ws.role === "admin") {
      const newOffset = msg.offsetMs;
      const now = Date.now();

      broadcastState.mode = "playing";
      broadcastState.pausedAt = null;
      broadcastState.serverStartTime = now - newOffset;

      broadcastToClients({
        type: "seek",
        serverStartTime: broadcastState.serverStartTime
      });

      broadcastStateUpdate();
      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    adminClients.delete(ws);
    clientMeta.delete(ws);
    sendClientListToAllAdmins();
  });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Server running", PORT));
