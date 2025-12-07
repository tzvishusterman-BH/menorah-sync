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

wss.on("connection", (ws) => {
  ws.isAlive = true;
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

      console.log("Broadcasting start for", serverStartTime, " (in ms) ");

      broadcastToClients({
        type: "start",
        serverStartTime
      });

      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    adminClients.delete(ws);
    console.log("Connection closed. Clients:", clients.size, "Admins:", adminClients.size);
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
