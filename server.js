//-------------------------------------------------------------
//  BERLIN MENORAH PARADE — MASTER SYNC SERVER
//-------------------------------------------------------------

const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

//==========================
// TRACK DEFINITIONS
//==========================
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

//==========================
// GLOBAL STATE
//==========================
let playlist = ["tyh", "matisyahu", "yoniz"]; // default; admin can edit
let nextOverride = null;

let clients = new Set();
let adminClients = new Set();

let clientMeta = new Map();
let nextClientId = 1;

let broadcastState = {
  mode: "idle",              // "idle" | "playing"
  trackId: null,
  serverStartTime: null
};

let trackEndTimer = null;

//==========================
// HELPERS
//==========================
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(set, obj) {
  const data = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function sendClientList() {
  const list = [];
  for (const ws of clients) {
    const m = clientMeta.get(ws);
    if (m) list.push(m);
  }
  broadcast(adminClients, { type: "clients", clients: list });
}

function sendStateToAll() {
  broadcast(adminClients, { type: "state", state: broadcastState });
  broadcast(clients, { type: "state", state: broadcastState });
}

function sendPlaylistToAdmins() {
  broadcast(adminClients, { type: "playlist", playlist });
}

function getNextTrackId() {
  if (nextOverride) {
    const tmp = nextOverride;
    nextOverride = null;
    return tmp;
  }
  if (!playlist.length) return null;

  const idx = playlist.indexOf(broadcastState.trackId);
  const nextIdx = (idx === -1) ? 0 : (idx + 1) % playlist.length; // loop
  return playlist[nextIdx];
}

function scheduleTrackEnd(trackId) {
  if (trackEndTimer) clearTimeout(trackEndTimer);

  const dur = TRACKS[trackId]?.duration ?? 0;
  const wait = Math.max(100, dur - 150); // never negative

  trackEndTimer = setTimeout(() => {
    // notify admins (for chime + toast)
    broadcast(adminClients, { type: "trackEnded", trackId });

    const nextId = getNextTrackId();
    if (nextId) startTrack(nextId);
  }, wait);
}

function startTrack(trackId) {
  if (!TRACKS[trackId]) return;

  broadcastState.mode = "playing";
  broadcastState.trackId = trackId;
  broadcastState.serverStartTime = Date.now();

  // tell clients exactly what to play + start timestamp
  broadcast(clients, {
    type: "seek",
    trackId,
    serverStartTime: broadcastState.serverStartTime
  });

  sendStateToAll();
  scheduleTrackEnd(trackId);
}

function stopBroadcast() {
  broadcastState.mode = "idle";
  broadcastState.trackId = null;
  broadcastState.serverStartTime = null;

  if (trackEndTimer) clearTimeout(trackEndTimer);
  trackEndTimer = null;

  broadcast(clients, { type: "stop" });
  sendStateToAll();
}

function skipTrack() {
  const nextId = getNextTrackId();
  if (nextId) startTrack(nextId);
}

function backTrack() {
  if (!broadcastState.trackId || !broadcastState.serverStartTime) return;

  const msInto = Date.now() - broadcastState.serverStartTime;

  if (msInto > 5000) {
    // restart same track
    startTrack(broadcastState.trackId);
    return;
  }

  // previous in playlist (wrap)
  const idx = playlist.indexOf(broadcastState.trackId);
  if (idx <= 0) startTrack(playlist[playlist.length - 1]);
  else startTrack(playlist[idx - 1]);
}

function terminateClient(clientId) {
  for (const ws of clients) {
    const m = clientMeta.get(ws);
    if (m && m.id === clientId) {
      send(ws, { type: "terminated" });
      try { ws.close(); } catch {}
      clients.delete(ws);
      clientMeta.delete(ws);
      sendClientList();
      return;
    }
  }
}

//==========================
// WEBSOCKET
//==========================
wss.on("connection", (ws) => {

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // -------------------------
    // HELLO (sets role!)  ✅ FIX
    // -------------------------
    if (msg.type === "hello") {
      if (msg.role === "admin") {
        ws.role = "admin";                 // ✅ CRITICAL
        adminClients.add(ws);

        send(ws, { type: "tracks", tracks: Object.values(TRACKS) });
        send(ws, { type: "playlist", playlist });
        send(ws, { type: "state", state: broadcastState });
        sendClientList();
        return;
      }

      if (msg.role === "client") {
        ws.role = "client";                // ✅ CRITICAL
        clients.add(ws);

        clientMeta.set(ws, {
          id: nextClientId++,
          name: null,
          armed: false,
          playing: false
        });

        send(ws, { type: "tracks", tracks: Object.values(TRACKS) });
        send(ws, { type: "state", state: broadcastState });
        sendClientList();
        return;
      }

      return;
    }

    // -------------------------
    // CLIENT MESSAGES
    // -------------------------
    if (ws.role === "client") {
      const meta = clientMeta.get(ws);
      if (!meta) return;

      if (msg.type === "register") {
        meta.name = String(msg.name || "").trim() || null;
        sendClientList();
        return;
      }

      if (msg.type === "armed") {
        meta.armed = true;
        sendClientList();
        return;
      }

      if (msg.type === "clientState") {
        meta.playing = !!msg.playing;
        sendClientList();
        return;
      }

      return;
    }

    // -------------------------
    // ADMIN MESSAGES
    // -------------------------
    if (ws.role === "admin") {

      if (msg.type === "playlistSet") {
        // sanitize playlist
        const next = Array.isArray(msg.playlist) ? msg.playlist.filter(id => TRACKS[id]) : [];
        playlist = next.length ? next : playlist;
        sendPlaylistToAdmins();
        return;
      }

      if (msg.type === "setNextOverride") {
        if (TRACKS[msg.trackId]) nextOverride = msg.trackId;
        return;
      }

      if (msg.type === "startTrack") {
        startTrack(msg.trackId);
        return;
      }

      if (msg.type === "skip") {
        skipTrack();
        return;
      }

      if (msg.type === "back") {
        backTrack();
        return;
      }

      if (msg.type === "stop") {
        stopBroadcast();
        return;
      }

      if (msg.type === "terminateClient") {
        terminateClient(msg.clientId);
        return;
      }

      return;
    }
  });

  ws.on("close", () => {
    if (ws.role === "client") {
      clients.delete(ws);
      clientMeta.delete(ws);
      sendClientList();
    } else if (ws.role === "admin") {
      adminClients.delete(ws);
    }
  });
});

//==========================
// START SERVER
//==========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Menorah Parade Sync Server running on port", PORT);
});
