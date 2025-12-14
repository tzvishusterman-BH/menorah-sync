let ws;
const clientsEl = document.getElementById("clients");

ws = new WebSocket(location.origin.replace("http","ws"));
ws.onopen = () => ws.send(JSON.stringify({ type:"hello", role:"admin" }));

ws.onmessage = e => {
  const msg = JSON.parse(e.data);

  if (msg.type === "clients") {
    clientsEl.innerHTML = "";
    msg.list.forEach(n => {
      const li = document.createElement("li");
      li.textContent = n;
      clientsEl.appendChild(li);
    });
  }
};

document.getElementById("start").onclick = () =>
  ws.send(JSON.stringify({ type:"startPlaylist" }));
