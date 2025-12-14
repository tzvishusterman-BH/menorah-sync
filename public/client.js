let ws;
let audioCtx;
let buffer;
let currentTrack;

const armBtn = document.getElementById("armBtn");
const familyInput = document.getElementById("familyName");
const statusEl = document.getElementById("status");

function init() {
  ws = new WebSocket(location.origin.replace("http", "ws"));
  ws.onopen = () => ws.send(JSON.stringify({ type:"hello", role:"client" }));

  ws.onmessage = async e => {
    const msg = JSON.parse(e.data);

    if (msg.type === "play") {
      await playTrack(msg.trackId, msg.startTime);
    }
  };
}

async function playTrack(id, startTime) {
  if (!audioCtx) return;

  const res = await fetch(id === "tyh" ? "TYH.mp3" : "");
  const arr = await res.arrayBuffer();
  buffer = await audioCtx.decodeAudioData(arr);

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(audioCtx.destination);

  const offset = (Date.now() - startTime) / 1000;
  src.start(0, offset);

  statusEl.textContent = "Synced";
}

armBtn.onclick = async () => {
  if (!familyInput.value) return alert("Enter family name");
  ws.send(JSON.stringify({ type:"register", name:familyInput.value }));

  audioCtx = new AudioContext();
  await audioCtx.resume();
  statusEl.textContent = "Armed";
};

init();
