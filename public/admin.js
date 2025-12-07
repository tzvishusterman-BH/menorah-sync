const PIN = "130865";

const pinScreen = document.getElementById("pinScreen");
const pinInput = document.getElementById("pinInput");
const enterBtn = document.getElementById("enterPinBtn");
const pinError = document.getElementById("pinError");

const adminPanel = document.getElementById("adminPanel");
const delaySeconds = document.getElementById("delaySeconds");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clientList = document.getElementById("clientList");

let ws;

function connectWS() {
  ws = new WebSocket(
    location.protocol === "https:" ?
      `wss://${location.host}` :
      `ws://${location.host}`
  );

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", role: "admin" }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "clients") {
      updateClientList(msg.clients);
    }
  };
}

function updateClientList(list) {
  clientList.innerHTML = "";
  list.forEach(c => {
    const li = document.createElement("li");
    li.textContent = `${c.id}. ${c.name}`;
    clientList.appendChild(li);
  });
}

enterBtn.addEventListener("click", () => {
  if (pinInput.value.trim() === PIN) {
    pinScreen.style.display = "none";
    adminPanel.style.display = "block";
    connectWS();
  } else {
    pinError.textContent = "Incorrect PIN";
  }
});

startBtn.addEventListener("click", () => {
  const ms = Number(delaySeconds.value) * 1000;
  ws.send(JSON.stringify({ type: "start", delayMs: ms }));
});

stopBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "stop" }));
});
