const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

let clients = new Set();
let adminClients = new Set();
let clientMeta = new Map();
let nextClientId = 1;

// EXACT TRACK LENGTH
const TRACK_DURATION_MS = 532000;

let currentTrack = null;

// Keep Render WebSockets alive
function heartbeat() {
  this.isAlive = true;
}

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.role = "client";

  ws.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    // Identify role
    if (msg.type === "hello") {
      if (msg.role === "admin") {
        ws.role = "admin";
        adminClients.add(ws);

        sendClientListToAdmin(ws);
      } else {
        ws.role = "client";
        clients.add(ws);

        const id = nextClientId++;
        clientMeta.set(ws, { id, name: null });

        broadcastClientList();

        // Late join handler
        if (currentTrack) {
          const now = Date.now();
          const start = currentTrack.serverStartTime;
          const end = start + currentTrack.durationMs;

          if (now >= start && now <= end) {
            ws.send(JSON.stringify({
              type: "late-join",
              serverStartTime: start
            }));
          } else if (now > end) {
            currentTrack = null;
          }
        }
      }
      return;
    }

    // Family name registration
    if (msg.type === "register" && ws.role === "client") {
      const meta = clientMeta.get(ws);
      if (meta) {
        meta.name = (msg.name || "").trim();
        broadcastClientList();
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

    // Admin START
    if (msg.type === "start" && ws.role === "admin") {
      const delay = Number(msg.delayMs);
      if (!(delay > 0)) return;

      const serverStartTime = Date.now() + delay;

      currentTrack = {
        serverStartTime,
        durationMs: TRACK_DURATION_MS
      };

      broadcastToClients({
        type: "start",
        serverStartTime
      });
      return;
    }

    // Admin STOP
    if (msg.type === "stop" && ws.role === "admin") {
      currentTrack = null;

      broadcastToClients({
        type: "stop"
      });
      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    adminClients.delete(ws);

    if (clientMeta.has(ws)) {
      clientMeta.delete(ws);
      broadcastClientList();
    }
  });
});

function broadcastToClients(obj) {
  const data = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
}

function broadcastClientList() {
  const list = [];
  for (const meta of clientMeta.values()) {
    list.push({
      id: meta.id,
      name: meta.name || "Unnamed family"
    });
  }
  const json = JSON.stringify({ type: "clients", clients: list });

  for (const a of adminClients) {
    if (a.readyState === WebSocket.OPEN) a.send(json);
  }
}

function sendClientListToAdmin(ws) {
  const list = [];
  for (const meta of clientMeta.values()) {
    list.push({
      id: meta.id,
      name: meta.name || "Unnamed family"
    });
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "clients",
      clients: list
    }));
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Server running on", PORT));
