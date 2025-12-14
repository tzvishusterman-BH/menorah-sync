let ws;
let tracks = {};

const trackSelect = document.getElementById("trackSelect");
const nowPlaying = document.getElementById("nowPlaying");

ws = new WebSocket(location.origin.replace(/^http/, "ws"));

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "hello", role: "admin" }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  if (msg.type === "tracks") {
    tracks = msg.tracks;
    trackSelect.innerHTML = "";
    Object.values(tracks).forEach(t => {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.name;
      trackSelect.appendChild(o);
    });
  }

  if (msg.type === "state") {
    if (!msg.state.playing) {
      nowPlaying.textContent = "Now Playing: —";
    } else {
      nowPlaying.textContent = "Now Playing: " + tracks[msg.state.trackId]?.name;
    }
  }
};

document.getElementById("playBtn").onclick = () => {
  ws.send(JSON.stringify({ type: "play", trackId: trackSelect.value }));
};

document.getElementById("stopBtn").onclick = () => {
  ws.send(JSON.stringify({ type: "stop" }));
};
