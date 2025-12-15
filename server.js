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

const START_LEAD_MS = 2500;
const PRELOAD_LEAD_MS = 2500;

let state = {
  playing: false,
  paused: false,
  trackId: null,
  startTime: null,      // epoch ms where track position=0
  pausedAtMs: 0,        // elapsed ms when paused
  playlist: ["tyh"],
  playlistIndex: 0
};

const clients = new Set();
const admins = new Set();
const clientNames = new Map();

let endTimer = null;
let preloadTimer = null;

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(group, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of group) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
function broadcastState() {
  broadcast(clients, { type: "state", state });
  broadcast(admins, { type: "state", state });
}
function broadcastClientsList() {
  broadcast(admins, { type: "clients", list: [...clientNames.values()] });
}

function clearTimers() {
  if (endTimer) clearTimeout(endTimer);
  if (preloadTimer) clearTimeout(preloadTimer);
  endTimer = null;
  preloadTimer = null;
}

function currentElapsedMs() {
  if (!state.playing || !state.trackId || !state.startTime) return 0;
  if (state.paused) return Math.max(0, state.pausedAtMs);
  return Math.max(0, Date.now() - state.startTime); // clamps countdown to 0 automatically
}

function getNextTrackId() {
  const list = state.playlist || [];
  if (!list.length) return null;
  const i = state.playlistIndex ?? 0;
  const nextI = i + 1;
  if (nextI >= list.length) return null;
  return list[nextI];
}

function scheduleAutoNext() {
  clearTimers();

  if (!state.playing || state.paused || !state.trackId || !state.startTime) return;

  const t = TRACKS[state.trackId];
  if (!t?.duration) return;

  const elapsed = currentElapsedMs();
  const remaining = Math.max(0, t.duration - elapsed);

  const nextId = getNextTrackId();
  if (nextId) {
    const preloadIn = Math.max(0, remaining - PRELOAD_LEAD_MS);
    preloadTimer = setTimeout(() => {
      broadcast(clients, { type: "preload", trackId: nextId });
      broadcast(admins, { type: "preload", trackId: nextId });
    }, preloadIn);
  }

  endTimer = setTimeout(() => {
    // If something changed meanwhile, don't advance incorrectly
    if (!state.playing || state.paused) return;

    const nowElapsed = currentElapsedMs();
    const stillSame = state.trackId === t.id;
    const atEnd = nowElapsed >= (t.duration - 30); // small tolerance

    if (stillSame && atEnd) {
      advanceToNextTrack();
    } else {
      // if drifted (seek etc.), reschedule
      scheduleAutoNext();
    }
  }, remaining);
}

function startTrack(trackId) {
  if (!TRACKS[trackId]) return;

  state.playing = true;
  state.paused = false;
  state.trackId = trackId;
  state.pausedAtMs = 0;

  // Countdown lead-in for new starts
  state.startTime = Date.now() + START_LEAD_MS;

  broadcast(clients, { type: "play", trackId, startTime: state.startTime });
  broadcast(admins, { type: "play", trackId, startTime: state.startTime });
  broadcastState();

  scheduleAutoNext();
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
  if (!state.playing || state.paused || !state.trackId || !state.startTime) return;

  clearTimers();
  state.paused = true;

  // If paused during countdown, elapsed is 0
  state.pausedAtMs = Math.max(0, Date.now() - state.startTime);

  broadcast(clients, { type: "pause", pausedAtMs: state.pausedAtMs });
  broadcast(admins, { type: "pause", pausedAtMs: state.pausedAtMs });
  broadcastState();
}

function resumeAll() {
  if (!state.playing || !state.paused || !state.trackId) return;

  state.startTime = Date.now() - Math.max(0, state.pausedAtMs);
  state.paused = false;

  broadcast(clients, { type: "play", trackId: state.trackId, startTime: state.startTime });
  broadcast(admins, { type: "play", trackId: state.trackId, startTime: state.startTime });
  broadcastState();

  scheduleAutoNext();
}

// SEEK: if paused -> update pausedAtMs; if playing -> update startTime and broadcast new play
function seekToMs(ms) {
  if (!state.playing || !state.trackId) return;
  const t = TRACKS[state.trackId];
  if (!t?.duration) return;

  const clamped = Math.max(0, Math.min(Number(ms) || 0, t.duration));

  if (state.paused) {
    state.pausedAtMs = clamped;
    broadcast(clients, { type: "pause", pausedAtMs: state.pausedAtMs });
    broadcast(admins, { type: "pause", pausedAtMs: state.pausedAtMs });
    broadcastState();
    return;
  }

  state.startTime = Date.now() - clamped;

  broadcast(clients, { type: "play", trackId: state.trackId, startTime: state.startTime });
  broadcast(admins, { type: "play", trackId: state.trackId, startTime: state.startTime });
  broadcastState();

  scheduleAutoNext();
}

function advanceToNextTrack() {
  const list = state.playlist || [];
  if (!list.length) return stopAll();

  const i = state.playlistIndex ?? 0;
  const nextI = i + 1;

  if (nextI >= list.length) {
    // End of playlist: stop (or loop if you want; tell me and I’ll change it)
    return stopAll();
  }

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

    if (msg.type === "timeSync") {
      send(ws, { type: "timeSync", clientSend: msg.clientSend, serverTime: Date.now() });
      return;
    }

    if (msg.type === "hello") {
      ws.role = msg.role;

      if (ws.role === "client") clients.add(ws);
      if (ws.role === "admin") admins.add(ws);

      send(ws, { type: "tracks", tracks: TRACKS });
      send(ws, { type: "state", state });
      broadcastClientsList();
      return;
    }

    if (ws.role === "client" && msg.type === "register") {
      const name = String(msg.name || "").trim();
      if (name) clientNames.set(ws, name);
      broadcastClientsList();
      return;
    }

    if (ws.role !== "admin") return;

    if (msg.type === "stop") return stopAll();
    if (msg.type === "togglePause") return state.paused ? resumeAll() : pauseAll();
    if (msg.type === "seek") return seekToMs(msg.positionMs);

    if (msg.type === "next") return advanceToNextTrack();
    if (msg.type === "back") return goBackTrack();

    if (msg.type === "playTrack") {
      const id = msg.trackId;
      if (!TRACKS[id]) return;

      const idx = (state.playlist || []).indexOf(id);
      if (idx >= 0) state.playlistIndex = idx;

      return startTrack(id);
    }

    if (msg.type === "setPlaylist") {
      const pl = Array.isArray(msg.playlist) ? msg.playlist.filter(id => TRACKS[id]) : [];
      state.playlist = pl.length ? pl : ["tyh"];
      state.playlistIndex = Math.min(state.playlistIndex ?? 0, state.playlist.length - 1);
      broadcastState();
      return;
    }

    if (msg.type === "playAtIndex") {
      const idx = Number(msg.index);
      if (!Number.isFinite(idx)) return;
      if (!state.playlist?.length) return;

      const clamped = Math.max(0, Math.min(idx, state.playlist.length - 1));
      state.playlistIndex = clamped;
      return startTrack(state.playlist[clamped]);
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
