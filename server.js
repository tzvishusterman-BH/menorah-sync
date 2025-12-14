const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

// ==========================
// TRACK DEFINITIONS (ALL)
// ==========================
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

const START_LEAD_MS = 2500; // countdown before (re)start
const NEXT_PRELOAD_LEAD_MS = 2500; // when we notify clients of next track

let state = {
  playing: false,
  paused: false,
  trackId: null,
  startTime: null,       // epoch ms (when current track is aligned to 0)
  pausedAtMs: 0,         // elapsed ms into track at pause
  playlist: ["tyh"],     // default
  playlistIndex: 0
};

const clients = new Set();
const admins = new Set();
const clientNames = new Map(); // ws -> name

let nextTimer = null;
let preloadTimer = null;

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
function broadcastClientsList() {
  broadcast(admins, { type: "clients", list: [...clientNames.values()] });
}
function clearTimers() {
  if (nextTimer) clearTimeout(nextTimer);
  if (preloadTimer) clearTimeout(preloadTimer);
  nextTimer = null;
  preloadTimer = null;
}

function currentElapsedMs() {
  if (!state.playing || !state.trackId || !state.startTime) return 0;
  if (state.paused) return Math.max(0, state.pausedAtMs);
  return Math.max(0, Date.now() - state.startTime);
}

function scheduleAutoAdvance() {
  clearTimers();
  if (!state.playing || state.paused || !state.trackId) return;

  const t = TRACKS[state.trackId];
  if (!t || !t.duration) return;

  const elapsed = currentElapsedMs();
  const remaining = Math.max(0, t.duration - elapsed);

  // notify clients to preload next track a little before the end
  const nextId = getNextTrackId();
  if (nextId) {
    const preloadIn = Math.max(0, remaining - NEXT_PRELOAD_LEAD_MS);
    preloadTimer = setTimeout(() => {
      broadcast(clients, { type: "preload", trackId: nextId });
      broadcast(admins, { type: "preload", trackId: nextId });
    }, preloadIn);
  }

  nextTimer = setTimeout(() => {
    // end reached -> advance
    advanceToNextTrack();
  }, remaining);
}

function getNextTrackId() {
  const list = state.playlist || [];
  if (!list.length) return null;
  const i = state.playlistIndex ?? 0;
  const nextI = Math.min(i + 1, list.length - 1);
  if (nextI === i) return null;
  return list[nextI];
}

function startTrack(trackId) {
  if (!TRACKS[trackId]) return;

  clearTimers();
  state.playing = true;
  state.paused = false;
  state.trackId = trackId;
  state.startTime = Date.now() + START_LEAD_MS;
  state.pausedAtMs = 0;

  // broadcast start with fixed startTime
  broadcast(clients, { type: "play", trackId, startTime: state.startTime });
  broadcast(admins, { type: "play", trackId, startTime: state.startTime });
  broadcastState();

  // schedule next based on duration once we actually start (use the same clock)
  // (we can schedule immediately; it’s relative)
  scheduleAutoAdvance();
}

function stopAll() {
  clearTimers();
  state.playing = false;
  state.paused = false;
  state.trackId = null;
  state.startTime = null;
  state.pausedAtMs = 0;

  broadcast(clients, { type: "stop" });
  broadcast(admins, { type: "stop" });
  broadcastState();
}

function pauseAll() {
  if (!state.playing || state.paused || !state.trackId) return;

  clearTimers();
  state.paused = true;
  state.pausedAtMs = currentElapsedMs();

  broadcast(clients, { type: "pause", trackId: state.trackId, pausedAtMs: state.pausedAtMs });
  broadcast(admins, { type: "pause", trackId: state.trackId, pausedAtMs: state.pausedAtMs });
  broadcastState();
}

function resumeAll() {
  if (!state.playing || !state.paused || !state.trackId) return;

  // ✅ instant resume: startTime set so "now" equals paused position
  state.startTime = Date.now() - state.pausedAtMs;
  state.paused = false;

  broadcast(clients, { type: "play", trackId: state.trackId, startTime: state.startTime });
  broadcast(admins, { type: "play", trackId: state.trackId, startTime: state.startTime });
  broadcastState();

  scheduleAutoAdvance();
}


function advanceToNextTrack() {
  const list = state.playlist || [];
  if (!list.length) return stopAll();

  const i = state.playlistIndex ?? 0;
  const nextI = Math.min(i + 1, list.length - 1);
  if (nextI === i) return stopAll();

  state.playlistIndex = nextI;
  startTrack(list[nextI]);
}

function goBackTrack() {
  const list = state.playlist || [];
  if (!list.length) return;

  const i = state.playlistIndex ?? 0;
  const prevI = Math.max(0, i - 1);
  state.playlistIndex = prevI;
  startTrack(list[prevI]);
}

wss.on("connection", (ws) => {
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // time sync (preset clock)
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
        broadcastClientsList();
        return;
      }

      if (ws.role === "admin") {
        admins.add(ws);
        send(ws, { type: "tracks", tracks: TRACKS });
        send(ws, { type: "state", state });
        broadcastClientsList();
        return;
      }
      return;
    }

    if (ws.role === "client" && msg.type === "register") {
      const name = String(msg.name || "").trim();
      if (name) clientNames.set(ws, name);
      broadcastClientsList();
      return;
    }

    if (ws.role !== "admin") return;

    // playlist updates from admin
    if (msg.type === "setPlaylist") {
      const pl = Array.isArray(msg.playlist) ? msg.playlist.filter(id => TRACKS[id]) : [];
      state.playlist = pl.length ? pl : ["tyh"];
      // keep index sane
      state.playlistIndex = Math.min(state.playlistIndex ?? 0, state.playlist.length - 1);
      broadcastState();
      return;
    }

    if (msg.type === "playAtIndex") {
      const idx = Number(msg.index);
      if (!Number.isFinite(idx)) return;
      if (!state.playlist || !state.playlist.length) return;
      const clamped = Math.max(0, Math.min(idx, state.playlist.length - 1));
      state.playlistIndex = clamped;
      startTrack(state.playlist[clamped]);
      return;
    }

    if (msg.type === "stop") return stopAll();

    // pause/play toggle = pause everyone OR resume everyone with new startTime (resync)
    if (msg.type === "togglePause") {
      if (!state.playing) return;
      if (!state.paused) return pauseAll();
      return resumeAll();
    }

    if (msg.type === "next") return advanceToNextTrack();
    if (msg.type === "back") return goBackTrack();

    // play selected track immediately (sets playlistIndex to that track if present)
    if (msg.type === "playTrack") {
      const trackId = msg.trackId;
      if (!TRACKS[trackId]) return;

      const idx = (state.playlist || []).indexOf(trackId);
      if (idx >= 0) state.playlistIndex = idx;

      startTrack(trackId);
      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    admins.delete(ws);
    clientNames.delete(ws);
    broadcastClientsList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Menorah Sync running on port", PORT));
