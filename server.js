const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

// ==========================
// TRACK DEFINITIONS
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

let state = {
  playing: false,
  trackId: null
};

const clients = new Set();
const admins = new Set();

function broadcast(targets, msg) {
  const data = JSON.stringify(msg);
  for (const ws of targets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

wss.on("connection", (ws) => {
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "hello") {
      ws.role = msg.role;
      if (ws.role === "client") {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "tracks", tracks: TRACKS }));
        ws.send(JSON.stringify({ type: "state", state }));
      }
      if (ws.role === "admin") {
        admins.add(ws);
        ws.send(JSON.stringify({ type: "tracks", tracks: TRACKS }));
        ws.send(JSON.stringify({ type: "state", state }));
      }
      return;
    }

    if (ws.role === "admin") {
      if (msg.type === "play") {
        state.playing = true;
        state.trackId = msg.trackId;
        broadcast(clients, { type: "play", trackId: msg.trackId });
        broadcast(admins, { type: "state", state });
      }

      if (msg.type === "stop") {
        state.playing = false;
        state.trackId = null;
        broadcast(clients, { type: "stop" });
        broadcast(admins, { type: "state", state });
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    admins.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Menorah Sync running on port", PORT);
});
