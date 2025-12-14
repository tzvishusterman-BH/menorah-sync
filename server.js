const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

// ==========================
// TRACKS
// ==========================
const TRACKS = {
  tyh: { id: "tyh", name: "Thank You Hashem", file: "TYH.mp3" },
  matisyahu: { id: "matisyahu", name: "Matisyahu", file: "Matisyahu.mp3" },
  yoniz: { id: "yoniz", name: "Yoni Z", file: "Yoni Z.mp3" },
  mendykraus: { id: "mendykraus", name: "Mendy Kraus", file: "Mendy Kraus.mp3" },
  meirshitrit: { id: "meirshitrit", name: "Meir Shitrit", file: "Meir Shitrit.mp3" },
  menachemlifshitz: { id: "menachemlifshitz", name: "Menachem Lifshitz", file: "Menachem Lifshitz.mp3" },
  chonimilecki: { id: "chonimilecki", name: "Choni Milecki", file: "Choni Milecki.mp3" },
  djshatz: { id: "djshatz", name: "DJ Shatz", file: "DJ Shatz.mp3" },
  srulivnetanel: { id: "srulivnetanel", name: "Sruli & Netanel", file: "Sruli V'Netanel.mp3" }
};

const START_LEAD_MS = 3000; // countdown length

let state = {
  playing: false,
  trackId: null,
  startTime: null // server epoch ms when track should start
};

const clients = new Set();
const admins = new Set();

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(group, obj) {
  const data = JSON.stringify(obj);
  for (const ws of group) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function broadcastState() {
  broadcast(clients, { type: "state", state });
  broadcast(admins, { type: "state", state });
}

wss.on("connection", (ws) => {
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // preset clock sync (server time)
    if (msg.type === "timeSync") {
      send(ws, { type: "timeSync", clientSend: msg.clientSend, serverTime: Date.now() });
      return;
    }

    if (msg.type === "hello") {
      ws.role = msg.role;

      if (ws.role === "client") {
        clients.add(ws);
        send(ws, { type: "tracks", tracks: TRACKS });
        send(ws, { type: "state", state });
        return;
      }

      if (ws.role === "admin") {
        admins.add(ws);
        send(ws, { type: "tracks", tracks: TRACKS });
        send(ws, { type: "state", state });
        return;
      }
      return;
    }

    if (ws.role !== "admin") return;

    if (msg.type === "play") {
      const trackId = msg.trackId;
      if (!TRACKS[trackId]) return;

      state.playing = true;
      state.trackId = trackId;
      state.startTime = Date.now() + START_LEAD_MS; // ✅ countdown / preset start

      // broadcast play with the fixed startTime
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
  });

  ws.on("close", () => {
    clients.delete(ws);
    admins.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Menorah Sync running on port", PORT));
