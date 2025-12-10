const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

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

let clients = new Set();
let adminClients = new Set();
let clientMeta = new Map();
let nextClientId = 1;

let broadcastState = {
  mode: "idle",
  trackId: "tyh",
  serverStartTime: null,
  pausedAt: null
};

function broadcastClients(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients)
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function broadcastAdmins(obj) {
  const data = JSON.stringify(obj);
  for (const ws of adminClients)
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

function updateAll() {
  broadcastClients({ type: "state", state: broadcastState });
  broadcastAdmins({ type: "state", state: broadcastState });
}

wss.on("connection", ws => {

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "hello") {
      if (msg.role === "admin") {
        ws.role = "admin";
        adminClients.add(ws);

        ws.send(JSON.stringify({
          type: "tracks",
          tracks: Object.values(TRACKS)
        }));
        updateAll();
      } else {
        ws.role = "client";
        clients.add(ws);

        clientMeta.set(ws, {
          id: nextClientId++,
          name: null,
          armed: false,
          playing: false
        });

        ws.send(JSON.stringify({
          type: "tracks",
          tracks: Object.values(TRACKS)
        }));
        ws.send(JSON.stringify({ type: "state", state: broadcastState }));
      }
      return;
    }

    if (ws.role === "client") {
      const meta = clientMeta.get(ws);
      if (!meta) return;

      if (msg.type === "register") {
        meta.name = msg.name;
      }

      if (msg.type === "armed") {
        meta.armed = true;
      }

      if (msg.type === "clientState") {
        meta.playing = msg.playing;
      }
      return;
    }

    if (ws.role === "admin") {

      if (msg.type === "stop") {
        broadcastState.mode = "idle";
        broadcastState.serverStartTime = null;
        broadcastState.pausedAt = null;
        broadcastClients({ type: "stop" });
        updateAll();
        return;
      }

      if (msg.type === "seek") {
        const offset = msg.offsetMs ?? 0;

        broadcastState.mode = "playing";
        broadcastState.trackId = msg.trackId;
        broadcastState.serverStartTime = Date.now() - offset;
        broadcastState.pausedAt = null;

        broadcastClients({
          type: "seek",
          trackId: msg.trackId,
          serverStartTime: broadcastState.serverStartTime
        });

        updateAll();
        return;
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    adminClients.delete(ws);
    clientMeta.delete(ws);
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () =>
  console.log("Server running on port", PORT)
);
