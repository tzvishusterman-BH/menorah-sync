// ADMIN script

let ws;
const localTimeEl = document.getElementById("localTime");
const delaySecondsInput = document.getElementById("delaySeconds");
const startBtn = document.getElementById("startBtn");
const statusEl = document.getElementById("status");

function logStatus(msg) {
  console.log(msg);
  statusEl.textContent = msg;
}

function getWSUrl() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}`;
}

function updateLocalTime() {
  const now = new Date();
  localTimeEl.textContent = now.toLocaleTimeString();
}

setInterval(updateLocalTime, 1000);
updateLocalTime();

function connectWS() {
  ws = new WebSocket(getWSUrl());

  ws.onopen = () => {
    console.log("Admin WebSocket opened");
    ws.send(JSON.stringify({ type: "hello", role: "admin" }));
    logStatus("Connected as admin.");
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "pong") {
      // Not used for now
    }
  };

  ws.onclose = () => {
    logStatus("Disconnected from server.");
  };

  ws.onerror = (err) => {
    console.error("Admin WebSocket error", err);
  };
}

startBtn.addEventListener("click", () => {
  const delaySec = Number(delaySecondsInput.value || "10");
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logStatus("Not connected to server.");
    return;
  }
  if (delaySec <= 0) {
    logStatus("Delay must be > 0");
    return;
  }

  const delayMs = delaySec * 1000;

  ws.send(JSON.stringify({
    type: "start",
    delayMs
  }));

  logStatus("Sent start command for " + delaySec + " seconds from now.");
});

connectWS();
