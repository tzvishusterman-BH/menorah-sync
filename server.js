//-------------------------------------------------------------
//  BERLIN MENORAH PARADE — MASTER SYNC SERVER
//  Features:
//   • Playlist system (drag reorder / add / delete)
//   • Next override
//   • Skip / Back (Rule A)
//   • Track looping
//   • Terminate client (kick)
//   • Soft chime notification support
//   • Multi-language support hooks
//   • WebSocket protocol v2
//-------------------------------------------------------------

const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

//===================================================================
// TRACK DEFINITIONS (all tracks available to playlist)
//===================================================================
const TRACKS = {
  tyh: {
    id: "tyh",
    name: "Thank You Hashem",
    file: "TYH.mp3",
    duration: 532000
  },
  matisyahu: {
    id: "matisyahu",
    name: "Matisyahu",
    file: "Matisyahu.mp3",
    duration: 247000
  },
  yoniz: {
    id: "yoniz",
    name: "Yoni Z",
    file: "Yoni Z.mp3",
    duration: 151000
  },
  mendykraus: {
    id: "mendykraus",
    name: "Mendy Kraus",
    file: "Mendy Kraus.mp3",
    duration: 803000
  },
  meirshitrit: {
    id: "meirshitrit",
    name: "Meir Shitrit",
    file: "Meir Shitrit.mp3",
    duration: 2104000
  },
  menachemlifshitz: {
    id: "menachemlifshitz",
    name: "Menachem Lifshitz",
    file: "Menachem Lifshitz.mp3",
    duration: 1460000
  },
  chonimilecki: {
    id: "chonimilecki",
    name: "Choni Milecki",
    file: "Choni Milecki.mp3",
    duration: 1149000
  },
  djshatz: {
    id: "djshatz",
    name: "DJ Shatz",
    file: "DJ Shatz.mp3",
    duration: 802000
  },
  srulivnetanel: {
    id: "srulivnetanel",
    name: "Sruli & Netanel",
    file: "Sruli V'Netanel.mp3",
    duration: 206000
  }
};

//===================================================================
//  GLOBAL STATE
//===================================================================

// Playlist = array of track IDs, in order:
let playlist = ["tyh", "matisyahu", "yoniz"];  // starter example, admin will override

// If admin sets a temporary override:
let nextOverride = null;

// All connected clients:
let clients = new Set();
let adminClients = new Set();

// Per-client metadata:
let clientMeta = new Map();
let nextClientId = 1;

// Active track state:
let broadcastState = {
  mode: "idle",                // "idle" | "playing" | "paused"
  trackId: null,
  serverStartTime: null,
  pausedAt: null
};

//===================================================================
//  HELPER FUNCTIONS
//===================================================================

function broadcastAdmins(obj) {
  const data = JSON.stringify(obj);
  for (const ws of adminClients)
    if (ws.readyState === WebSocket.OPEN)
      ws.send(data);
}

function broadcastClients(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients)
    if (ws.readyState === WebSocket.OPEN)
      ws.send(data);
}

// Send updated full playlist to admins:
function sendPlaylist() {
  broadcastAdmins({
    type: "playlist",
    playlist
  });
}

// Highlight current track:
function sendCurrentState() {
  broadcastAdmins({
    type: "state",
    state: broadcastState
  });
  broadcastClients({
    type: "state",
    state: broadcastState
  });
}

// Utility:
function getTrackIndex(id) {
  return playlist.indexOf(id);
}

function getNextTrackId() {
  if (nextOverride) {
    let o = nextOverride;
    nextOverride = null;
    return o;
  }
  if (playlist.length === 0) return null;

  let idx = playlist.indexOf(broadcastState.trackId);
  if (idx === -1) idx = 0;

  let next = idx + 1;
  if (next >= playlist.length) next = 0;  // Loop mode (LA)

  return playlist[next];
}

function restartSameTrack() {
  const t = broadcastState.trackId;
  broadcastState.serverStartTime = Date.now();
  broadcastState.pausedAt = null;

  broadcastClients({
    type: "seek",
    trackId: t,
    serverStartTime: broadcastState.serverStartTime
  });

  sendCurrentState();
}

//===================================================================
//  MAIN PLAY LOGIC
//===================================================================

function startTrack(trackId) {
  broadcastState.mode = "playing";
  broadcastState.trackId = trackId;
  broadcastState.serverStartTime = Date.now();
  broadcastState.pausedAt = null;

  broadcastClients({
    type: "seek",
    trackId: trackId,
    serverStartTime: broadcastState.serverStartTime
  });

  sendCurrentState();

  // Schedule track-end detection + chime
  scheduleTrackEnd(trackId);
}

let trackEndTimer = null;

function scheduleTrackEnd(trackId) {
  if (trackEndTimer) clearTimeout(trackEndTimer);

  const dur = TRACKS[trackId].duration;
  trackEndTimer = setTimeout(() => {
    // Notify admin (soft chime)
    broadcastAdmins({
      type: "trackEnded",
      trackId
    });

    // Go to next track
    const nextId = getNextTrackId();
    if (nextId) startTrack(nextId);

  }, dur - 200); // fire slightly before end
}

//===================================================================
//  SKIP / BACK LOGIC
//===================================================================

function skipTrack() {
  const nextId = getNextTrackId();
  if (nextId) startTrack(nextId);
}

function backTrack() {
  if (!broadcastState.trackId) return;
  const now = Date.now();

  // BACK RULE A
  const msInto = now - broadcastState.serverStartTime;
  if (msInto > 5000) {
    // More than 5 seconds — restart same track
    restartSameTrack();
    return;
  }

  // Less than 5 sec — go to previous track
  const idx = playlist.indexOf(broadcastState.trackId);
  if (idx <= 0) {
    // wrap to last
    startTrack(playlist[playlist.length - 1]);
  } else {
    startTrack(playlist[idx - 1]);
  }
}

//===================================================================
//  TERMINATE CLIENT (T3 - Kick)
//===================================================================

function terminateClient(targetId) {
  for (const ws of clients) {
    const meta = clientMeta.get(ws);
    if (!meta) continue;
    if (meta.id === targetId) {
      // Tell the client they are terminated
      ws.send(JSON.stringify({ type: "terminated" }));
      // Close connection
      try { ws.close(); } catch {}
      clients.delete(ws);
      clientMeta.delete(ws);
      sendClientList();
      return;
    }
  }
}

function sendClientList() {
  const list = [];
  for (const ws of clients) {
    const m = clientMeta.get(ws);
    if (m) list.push(m);
  }
  broadcastAdmins({ type: "clients", clients: list });
}

//===================================================================
//  WEBSOCKET HANDLING
//===================================================================

wss.on("connection", ws => {

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    //-------------------------------------------------------
    // HELLO HANDSHAKE
    //-------------------------------------------------------
    if (msg.type === "hello") {

      if (msg.role === "admin") {
        adminClients.add(ws);

        // Send tracks + playlist + state + clients
        ws.send(JSON.stringify({ type: "tracks", tracks: Object.values(TRACKS) }));
        ws.send(JSON.stringify({ type: "playlist", playlist }));
        ws.send(JSON.stringify({ type: "state", state: broadcastState }));

        sendClientList();
        return;
      }

      if (msg.role === "client") {
        clients.add(ws);
        clientMeta.set(ws, {
          id: nextClientId++,
          name: null,
          armed: false,
          playing: false
        });

        ws.send(JSON.stringify({ type: "tracks", tracks: Object.values(TRACKS) }));
        ws.send(JSON.stringify({ type: "state", state: broadcastState }));

        sendClientList();
        return;
      }
    }

    //-------------------------------------------------------
    // CLIENT EVENTS
    //-------------------------------------------------------
    if (ws.role === "client") {
      const meta = clientMeta.get(ws);
      if (!meta) return;

      if (msg.type === "register") {
        meta.name = msg.name;
        sendClientList();
      }

      if (msg.type === "armed") {
        meta.armed = true;
        sendClientList();
      }

      if (msg.type === "clientState") {
        meta.playing = msg.playing;
        sendClientList();
      }

      return;
    }

    //-------------------------------------------------------
    // ADMIN EVENTS
    //-------------------------------------------------------
    if (ws.role === "admin") {

      // ---------------- Playlist updates ------------------
      if (msg.type === "playlistSet") {
        playlist = msg.playlist;  // array of track IDs
        sendPlaylist();
        return;
      }

      // Next override
      if (msg.type === "setNextOverride") {
        nextOverride = msg.trackId;
        return;
      }

      // ---------------- Controls ----------------------------
      if (msg.type === "skip") {
        skipTrack();
        return;
      }

      if (msg.type === "back") {
        backTrack();
        return;
      }

      if (msg.type === "stop") {
        broadcastState.mode = "idle";
        broadcastState.trackId = null;
        broadcastState.serverStartTime = null;
        broadcastState.pausedAt = null;

        broadcastClients({ type: "stop" });
        sendCurrentState();
        return;
      }

      if (msg.type === "startTrack") {
        startTrack(msg.trackId);
        return;
      }

      if (msg.type === "terminateClient") {
        terminateClient(msg.clientId);
        return;
      }
    }

  });

  //-------------------------------------------------------
  // ON CLOSE
  //-------------------------------------------------------
  ws.on("close", () => {
    clients.delete(ws);
    adminClients.delete(ws);
    clientMeta.delete(ws);
    sendClientList();
  });

});

//===================================================================
//  SERVER START
//===================================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Menorah Parade Sync Server running on port", PORT);
});
