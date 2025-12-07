// ADMIN script with PIN gate + connected clients list

let ws;
const localTimeEl = document.getElementById("localTime");
const delaySecondsInput = document.getElementById("delaySeconds");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");

const pinScreen = document.getElementById("pinScreen");
const pinInput = document.getElementById("pinInput");
const pinBtn = document.getElementById("pinBtn");
const pinError = document.getElementById("pinError");
const adminContent = document.getElementById("adminContent");

const clientCountEl = document.getElementById("clientCount");
const clientListEl = document.getElementById("clientList");

// CHANGE THIS IF YOU EVER WANT A NEW PIN
const ADMIN_PIN = "130865";

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
    } else if (msg.type === "clients") {
      updateClientList(msg.clients || []);
    }
  };

  ws.onclose = () => {
    logStatus("Disconnected from server.");
  };

  ws.onerror = (err) => {
    console.error("Admin WebSocket error", err);
  };
}

function updateClientList(clients) {
  clientCountEl.textContent = `Connected: ${clients.length}`;
  clientListEl.innerHTML = "";
  clients.forEach((c) => {
    const li = document.createElement("li");
    li.textContent = `${c.id}. ${c.name}`;
    clientListEl.appendChild(li);
  });
}

// PIN handling
pinBtn.addEventListener("click", () => {
  const entered = (pinInput.value || "").trim();
  if (entered === ADMIN_PIN) {
    pinError.textContent = "";
    pinScreen.style.display = "none";
    adminContent.style.display = "block";
    connectWS();
  } else {
    pinError.textContent = "Incorrect PIN.";
  }
});

pinInput.addEventListener("keyup", (e) => {
  if (e.key === "Enter") {
    pinBtn.click();
  }
});

// Start button
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

  ws.send(
    JSON.stringify({
      type: "start",
      delayMs
    })
  );

  logStatus("Sent start command for " + delaySec + " seconds from now.");
});

// Stop button
stopBtn.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logStatus("Not connected to server.");
    return;
  }

  ws.send(
    JSON.stringify({
      type: "stop"
    })
  );

  logStatus("Sent STOP command. All clients should end playback.");
});
