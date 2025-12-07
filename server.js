const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from /public
app.use(express.static(path.join(__dirname, "public")));

let clients = new Set();       // regular listeners
let adminClients = new Set();  // admin connections

// Approximate length of your track in milliseconds.
// Example: 8 minutes = 8 * 60 * 1000 = 480000
// Adjust this to match your real track length.
const TRACK_DURATION_MS = 8 * 60 * 1000;

// Store info about the currently playing track, or null if nothing playing.
let currentTrack = null; // { serverStartTime, durationMs }

// --- Heartbeat to keep WebSocket connections alive on Render ---
function heartbeat() {
  this.isAlive = true;
}

// Ping clients every 30 seconds
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", function close() {
  clearInterval(interval);
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.role = "client"; // default

  ws.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.error("Invalid JSON from client:", message);
      return;
    }

    // First hello message tells us if this is admin or client
    if (msg.type === "hello") {
      if (msg.role === "admin") {
        ws.role = "admin";
        adminClients.add(ws);
        console.log("Admin connected");
      } else {
        ws.role = "client";
        clients.add(ws);
        console.log("Client connected");

        // If music is currently playing, tell this new client so they can join late.
        if (currentTrack) {
          const now = Date.now();
          const start = currentTrack.serverStartTime;
          const end = start + currentTrack.durationMs;

          if (now >= start && now <= end) {
            // Track is in progress: send late-join info
            ws.send(
              JSON.stringify({
                type: "late-join",
                serverStartTime: currentTrack.serverStartTime
              })
            );
          } else if (now > end) {
            // Track finished; clear state
            currentTrack = null;
          }
        }
      }
      return;
    }

    // Clock sync: client sends ping, server responds with pong + server time
    if (msg.type === "ping") {
      const response = {
        type: "pong",
        clientSendTime: msg.clientSendTime,
        serverTime: Date.now()
      };
      ws.send(JSON.stringify(response));
      return;
    }

    // Admin sends start command with a delay in ms
    if (msg.type === "start") {
      if (ws.role !== "admin") {
        console.warn("Non-admin tried to send start");
        return;
      }

      const delayMs = Number(msg.delayMs || 0);
      if (delayMs <= 0) {
        console.warn("Invalid delayMs", delayMs);
        return;
      }

      const serverStartTime = Date.now() + delayMs;

      console.log("Broadcasting start for", serverStartTime, "(in ms)");

      // Remember that a track is starting now so late joiners can sync in
      currentTrack = {
        serverStartTime,
        durationMs: 532000
      };

      broadcastToClients({
        type: "start",
        serverStartTime
      });

      return;
    }

    // Admin sends stop command: end the current track
    if (msg.type === "stop") {
      if (ws.role !== "admin") {
        console.warn("Non-admin tried to send stop");
        return;
      }

      console.log("Admin requested STOP. Ending current track.");

      // Clear current track state
      currentTrack = null;

      // Notify all clients to stop playback
      broadcastToClients({
        type: "stop"
      });

      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    adminClients.delete(ws);
    console.log(
      "Connection closed. Clients:",
      clients.size,
      "Admins:",
      adminClients.size
    );
  });
});

function broadcastToClients(obj) {
  const data = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) {
      c.send(data);
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on port", PORT);
});
