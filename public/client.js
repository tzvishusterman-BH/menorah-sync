(() => {
  const debugBox = document.getElementById("debugBox");
  function debug(msg){
    if (!debugBox) return;
    debugBox.style.display = "block";
    debugBox.textContent = String(msg);
  }

  window.addEventListener("error", (e) => {
    debug("JS ERROR:\n" + (e?.message || e) + "\n" + (e?.filename || "") + ":" + (e?.lineno || ""));
  });

  // Required elements (if any missing, we show it)
  const armBtn = document.getElementById("armBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const familyInput = document.getElementById("familyName");
  const statusPill = document.getElementById("statusPill");
  const nowPlayingPill = document.getElementById("nowPlayingPill");
  const iosPlayer = document.getElementById("iosPlayer");

  const missing = [];
  if (!armBtn) missing.push("armBtn");
  if (!pauseBtn) missing.push("pauseBtn");
  if (!familyInput) missing.push("familyName");
  if (!statusPill) missing.push("statusPill");
  if (!nowPlayingPill) missing.push("nowPlayingPill");
  if (!iosPlayer) missing.push("iosPlayer");

  if (missing.length) {
    debug("Missing elements: " + missing.join(", "));
    return; // page is broken; stop here
  }

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

  let ws = null;
  let armed = false;
  let locallyPaused = false;
  let tracks = {};
  let state = { playing:false, trackId:null, startTime:null };

  // basic clock correction (optional, ok if it fails)
  let serverOffsetMs = 0;
  let bestRttMs = Infinity;
  function correctedNowMs(){ return Date.now() + serverOffsetMs; }
  function expectedOffsetSec(serverStartTimeMs){
    return (correctedNowMs() - serverStartTimeMs) / 1000;
  }

  // WebAudio (non-iOS)
  let audioCtx = null;
  let source = null;
  let bufferCache = {};

  function setStatus(text, good){
    statusPill.textContent = `Status: ${text}`;
    statusPill.classList.remove("good","bad");
    statusPill.classList.add(good ? "good" : "bad");
  }
  function setNowPlaying(text){
    nowPlayingPill.textContent = `Now Playing: ${text}`;
  }
  function stopAll(){
    // iOS
    try { iosPlayer.pause(); } catch {}
    iosPlayer.removeAttribute("src");
    iosPlayer.load();
    // WebAudio
    try { if (source) source.stop(); } catch {}
    source = null;
  }

  async function loadWebBuffer(trackId){
    if (bufferCache[trackId]) return bufferCache[trackId];
    const t = tracks[trackId];
    const resp = await fetch(t.file, { cache:"no-store" });
    const arr = await resp.arrayBuffer();
    const buf = await audioCtx.decodeAudioData(arr);
    bufferCache[trackId] = buf;
    return buf;
  }

  async function startPlaybackAtServerTime(trackId, serverStartTimeMs){
    if (!armed || locallyPaused) return;
    const t = tracks[trackId];
    setNowPlaying(t ? t.name : trackId);

    const off = expectedOffsetSec(serverStartTimeMs);
    const startDelayMs = Math.max(0, Math.round(-off * 1000));
    const playFrom = Math.max(0, off);

    stopAll();

    if (isIOS) {
      iosPlayer.src = t.file;
      iosPlayer.load();

      if (startDelayMs > 0) {
        setStatus("Synced (starting…)", true);
        setTimeout(async () => {
          if (!armed || locallyPaused) return;
          try {
            iosPlayer.currentTime = 0;
            await iosPlayer.play();
            setStatus("Synced", true);
          } catch (e) {
            debug("iOS play blocked: " + e);
            setStatus("Tap PLAY (iOS blocked)", false);
          }
        }, startDelayMs);
      } else {
        try {
          iosPlayer.currentTime = playFrom;
          await iosPlayer.play();
          setStatus("Synced", true);
        } catch (e) {
          debug("iOS play failed: " + e);
          setStatus("Tap PLAY (iOS blocked)", false);
        }
      }
      return;
    }

    if (!audioCtx) return;

    const buf = await loadWebBuffer(trackId);
    source = audioCtx.createBufferSource();
    source.buffer = buf;
    source.connect(audioCtx.destination);
    source.start(audioCtx.currentTime + (startDelayMs/1000), playFrom);
    setStatus(startDelayMs > 0 ? "Synced (starting…)" : "Synced", true);
  }

  // Websocket connect
  function connect(){
    ws = new WebSocket(location.origin.replace(/^http/, "ws"));

    ws.onopen = () => {
      ws.send(JSON.stringify({ type:"hello", role:"client" }));
      // kick off time sync
      ws.send(JSON.stringify({ type:"timeSync", clientSend: Date.now() }));
    };

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "timeSync") {
        const recv = Date.now();
        const rtt = recv - msg.clientSend;
        const approxServerAtRecv = msg.serverTime + (rtt / 2);
        const offset = approxServerAtRecv - recv;
        if (rtt < bestRttMs) { bestRttMs = rtt; serverOffsetMs = offset; }
        else serverOffsetMs = serverOffsetMs * 0.9 + offset * 0.1;
        return;
      }

      if (msg.type === "tracks") { tracks = msg.tracks || {}; return; }

      if (msg.type === "state") {
        state = msg.state || state;
        if (!state.playing || !state.trackId) {
          setNowPlaying("—");
          if (armed) setStatus(locallyPaused ? "Paused" : "Armed (waiting…)", false);
          else setStatus("Not Armed", false);
          stopAll();
          return;
        }
        const t = tracks[state.trackId];
        setNowPlaying(t ? t.name : state.trackId);
        if (armed && !locallyPaused && state.startTime) {
          await startPlaybackAtServerTime(state.trackId, state.startTime);
        }
        return;
      }

      if (msg.type === "play" || msg.type === "resync") {
        state.playing = true;
        state.trackId = msg.trackId;
        state.startTime = msg.startTime;
        if (armed && !locallyPaused) {
          await startPlaybackAtServerTime(msg.trackId, msg.startTime);
        }
        return;
      }

      if (msg.type === "stop") {
        state.playing = false;
        state.trackId = null;
        state.startTime = null;
        stopAll();
        setNowPlaying("—");
        setStatus(armed ? (locallyPaused ? "Paused" : "Armed (waiting…)" ) : "Not Armed", false);
      }
    };

    ws.onclose = () => {
      stopAll();
      setStatus("Disconnected (refresh page)", false);
    };
  }

  // ARM click — MUST WORK
  armBtn.addEventListener("click", async () => {
    // immediate UI feedback so you know click fired
    armBtn.textContent = "ARMING…";

    const name = familyInput.value.trim();
    if (!name) {
      armBtn.textContent = "ARM AUDIO";
      alert("Please enter your family name first.");
      familyInput.focus();
      return;
    }

    // register name if ws ready (don’t crash if not)
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type:"register", name }));
      }
    } catch {}

    armed = true;
    locallyPaused = false;

    armBtn.style.display = "none";
    pauseBtn.style.display = "inline-block";
    setStatus("Armed (waiting…)", false);

    try {
      if (isIOS) {
        // unlock audio using chime.mp3
        iosPlayer.src = "chime.mp3";
        iosPlayer.currentTime = 0;
        await iosPlayer.play();
        iosPlayer.pause();
        iosPlayer.removeAttribute("src");
        iosPlayer.load();
      } else {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
        await audioCtx.resume();
      }
    } catch (e) {
      debug("Audio init failed: " + e);
    }

    // If parade already playing, join immediately
    if (state.playing && state.trackId && state.startTime) {
      await startPlaybackAtServerTime(state.trackId, state.startTime);
    }
  });

  pauseBtn.addEventListener("click", async () => {
    if (!armed) return;

    if (!locallyPaused) {
      locallyPaused = true;
      stopAll();
      setStatus("Paused (tap Play to re-sync)", false);
      pauseBtn.textContent = "PLAY";
      return;
    }

    locallyPaused = false;
    pauseBtn.textContent = "PAUSE";

    if (state.playing && state.trackId && state.startTime) {
      await startPlaybackAtServerTime(state.trackId, state.startTime);
    } else {
      setStatus("Armed (waiting…)", false);
    }
  });

  // init
  setStatus("Not Armed", false);
  setNowPlaying("—");
  connect();
})();
