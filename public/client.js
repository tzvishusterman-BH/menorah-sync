let ws;
let tracks = {};
let armed = false;

const audio = document.getElementById("iosPlayer");
const armBtn = document.getElementById("armBtn");
const pauseBtn = document.getElementById("pauseBtn");
const familyInput = document.getElementById("familyName");
const statusPill = document.getElementById("statusPill");
const nowPlayingPill = document.getElementById("nowPlayingPill");

function setStatus(t) {
  statusPill.textContent = "Status: " + t;
}

function setNowPlaying(t) {
  nowPlayingPill.textContent = "Now Playing: " + t;
}

armBtn.onclick = async () => {
  const name = familyInput.value.trim();
  if (!name) {
    alert("Enter family name first");
    return;
  }

  armed = true;
  armBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
  setStatus("Armed");

  try {
    audio.src = "chime.mp3";
    await audio.play();
    audio.pause();
    audio.src = "";
  } catch {}
};

pauseBtn.onclick = () => {
  if (audio.paused) audio.play();
  else audio.pause();
};

function stopAudio() {
  audio.pause();
  audio.src = "";
}

function playTrack(id) {
  if (!armed) return;
  const t = tracks[id];
  if (!t) return;
  stopAudio();
  audio.src = t.file;
  audio.currentTime = 0;
  audio.play();
  setNowPlaying(t.name);
  setStatus("Playing");
}

ws = new WebSocket(location.origin.replace(/^http/, "ws"));

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "hello", role: "client" }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  if (msg.type === "tracks") {
    tracks = msg.tracks;
  }

  if (msg.type === "play") {
    playTrack(msg.trackId);
  }

  if (msg.type === "stop") {
    stopAudio();
    setNowPlaying("—");
    setStatus("Stopped");
  }
};

setStatus("Not Armed");
setNowPlaying("—");
