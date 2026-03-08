'use strict';
// ─── Constants ────────────────────────────────────────────────────────────
const TILE_SIZE = 32;
const TILE_BLANK = 0, TILE_ROCK = 1, TILE_TREE = 2;

const WEAPON_NAMES = {
  laser: 'Basic Laser',
  triple_laser: 'Triple Laser',
  rocket: 'Rocket',
};

const POWERUP_COLORS = {
  triple_laser: '#40c0ff',
  rocket:       '#ff8040',
  full_armor:   '#40ff80',
  cloak:        '#c080ff',
};

const POWERUP_LETTERS = {
  triple_laser: 'T',
  rocket:       'R',
  full_armor:   'A',
  cloak:        'C',
};

// Default tank colors for FFA (by player index)
const TANK_COLORS = ['#e94560','#4080ff','#40c080','#ffd040','#c080ff','#ff8040'];


// ─── Global State ─────────────────────────────────────────────────────────
let ws = null, wsOpen = false, reconnectAttempts = 0;
let myId = null, myName = '', gameId = null, isHost = false;
let allowLateJoin = true;
let currentPhase = 'lobby'; // local tracking
let gameMap = null;
let localDir = 'E', firingHeld = false, isMoving = false;
let mode = 'ffa', teams = [];
let rockDensity = 2, treeDensity = 2; // percentages, synced from server
let gameIsPublic = true, gamePassword = '';
let endType = 'time', timeLimitMs = 10 * 60 * 1000, scoreLimit = 30;
let hostId = null;

// Browse / password flow
let pendingJoinGameId = null;
let browseRefreshTimer = null;
let passwordInputTimer = null;

// Canvas layers
let canvas, ctx;
let mapCanvas, mapCtx;   // static ground + rocks
let treeCanvas, treeCtx; // tree layer (renders over tanks)
let mapDirty = true;

// Render state from last snapshot
let renderPlayers = [];
let renderProjectiles = [];
let renderPowerups = [];
let renderScores = [];

// Kill feed
let killFeed = []; // [{text, expiresAt}]
let myWeapon = 'laser';

// Input interval handle
let inputInterval = null;

// rAF handle
let rafId = null;

// ─── Sound System State ───────────────────────────────────────────────────
let audioCtx = null;
let volMusic = 0.38, volLaser = 0.8, volRocket = 0.8, volEnemy = 0.10;
let bgDroneOsc = null, bgDroneGain = null, bgDramatic = false;
let bgScheduleTime = 0, bgScheduleTimer = null, bgBarCount = 0;
let prevProjectiles = [];   // for signature-based new-bullet detection
let myWasAlive = null;      // for spawn sound (null = unknown)

// ─── Confetti State ───────────────────────────────────────────────────────
let confettiCanvas = null, confettiCtx2d = null, confettiParticles = [], confettiRafId = null;
const CONFETTI_COLORS = ['#ffd040','#e94560','#4080ff','#40c080','#c080ff','#ff8040','#ffffff','#40ffff'];

// WebRTC
let rtcPeer = null, rtcChannel = null, rtcCandidateQueue = [], rtcReady = false;

// ─── Sound Functions ──────────────────────────────────────────────────────
function getAC() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function loadSoundSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('nm_sound') || '{}');
    if (s.music != null) volMusic = s.music;
    if (s.laser != null) volLaser = s.laser;
    if (s.rocket != null) volRocket = s.rocket;
    if (s.enemy != null) volEnemy = s.enemy;
  } catch {}
}

function saveSoundSettings() {
  try { localStorage.setItem('nm_sound', JSON.stringify({ music: volMusic, laser: volLaser, rocket: volRocket, enemy: volEnemy })); } catch {}
}

// ─── Bullet Sounds ────────────────────────────────────────────────────────
function playLaserSound(isOwn) {
  const ac = getAC(); if (!ac) return;
  const vol = (isOwn ? volLaser : volLaser * volEnemy) * 0.16;
  if (vol < 0.002) return;
  const t = ac.currentTime;
  // High-pitched electric zap
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  g.connect(ac.destination);
  const o = ac.createOscillator();
  o.type = 'square';
  o.frequency.setValueAtTime(isOwn ? 1200 : 950, t);
  o.frequency.exponentialRampToValueAtTime(isOwn ? 320 : 200, t + 0.12);
  o.connect(g); o.start(t); o.stop(t + 0.12);
}

function playRocketSound(isOwn) {
  const ac = getAC(); if (!ac) return;
  const vol = (isOwn ? volRocket : volRocket * volEnemy) * 0.25;
  if (vol < 0.002) return;
  const t = ac.currentTime;

  // 1) Sharp ignition pop (very short noise transient)
  const psz = Math.floor(ac.sampleRate * 0.025);
  const pbuf = ac.createBuffer(1, psz, ac.sampleRate);
  const pd = pbuf.getChannelData(0);
  for (let i = 0; i < psz; i++) pd[i] = (Math.random() * 2 - 1) * (1 - i / psz);
  const ps = ac.createBufferSource(); ps.buffer = pbuf;
  const phpf = ac.createBiquadFilter(); phpf.type = 'highpass'; phpf.frequency.value = 3000;
  const pg = ac.createGain(); pg.gain.value = vol * 1.4;
  ps.connect(phpf); phpf.connect(pg); pg.connect(ac.destination);
  ps.start(t); ps.stop(t + 0.03);

  // 2) Descending pitch whistle (the rocket flying away)
  const wo = ac.createOscillator(); wo.type = 'sawtooth';
  wo.frequency.setValueAtTime(800, t + 0.02);
  wo.frequency.exponentialRampToValueAtTime(120, t + 0.4);
  const wlpf = ac.createBiquadFilter(); wlpf.type = 'lowpass'; wlpf.frequency.value = 1800;
  const wg = ac.createGain();
  wg.gain.setValueAtTime(0, t + 0.02);
  wg.gain.linearRampToValueAtTime(vol * 0.55, t + 0.06);
  wg.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
  wo.connect(wlpf); wlpf.connect(wg); wg.connect(ac.destination);
  wo.start(t + 0.02); wo.stop(t + 0.44);

  // 3) Low bass thump on launch
  const bo = ac.createOscillator(); bo.type = 'sine';
  bo.frequency.setValueAtTime(120, t);
  bo.frequency.exponentialRampToValueAtTime(28, t + 0.22);
  const bg2 = ac.createGain();
  bg2.gain.setValueAtTime(vol * 1.1, t);
  bg2.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  bo.connect(bg2); bg2.connect(ac.destination); bo.start(t); bo.stop(t + 0.24);
}

// ─── Spawn Sound ──────────────────────────────────────────────────────────
function playSpawnSound() {
  const ac = getAC(); if (!ac) return;
  const t = ac.currentTime;
  // Rising arpeggiated chord — major A: A C# E A (upbeat respawn)
  [220, 277, 330, 440, 660].forEach((freq, i) => {
    const o = ac.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(freq * 0.55, t + i * 0.07);
    o.frequency.exponentialRampToValueAtTime(freq, t + i * 0.07 + 0.12);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t + i * 0.07);
    g.gain.linearRampToValueAtTime(0.28 * (1 - i * 0.1), t + i * 0.07 + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.25);
    o.connect(g); g.connect(ac.destination);
    o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.28);
  });
  // Sparkle noise burst
  const ssz = Math.floor(ac.sampleRate * 0.1);
  const sbuf = ac.createBuffer(1, ssz, ac.sampleRate);
  const sd = sbuf.getChannelData(0);
  for (let i = 0; i < ssz; i++) sd[i] = Math.random() * 2 - 1;
  const ss = ac.createBufferSource(); ss.buffer = sbuf;
  const shpf = ac.createBiquadFilter(); shpf.type = 'highpass'; shpf.frequency.value = 5500;
  const sg = ac.createGain();
  sg.gain.setValueAtTime(0.22, t); sg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  ss.connect(shpf); shpf.connect(sg); sg.connect(ac.destination);
  ss.start(t); ss.stop(t + 0.12);
}

// ─── Projectile detection (signature-based — only plays when bullet exists) ──
function detectAndPlayNewProjectileSounds(newProjs) {
  const newOnes = [];
  const usedOld = new Set();

  for (const np of newProjs) {
    let matched = false;
    for (let i = 0; i < prevProjectiles.length; i++) {
      if (usedOld.has(i)) continue;
      const op = prevProjectiles[i];
      if (op.weapon !== np.weapon || op.dx !== np.dx || op.dy !== np.dy) continue;
      // Old projectile should have moved in its direction — generous tolerance
      const dist = Math.hypot(np.x - op.x, np.y - op.y);
      if (dist < 110) { usedOld.add(i); matched = true; break; }
    }
    if (!matched) newOnes.push(np);
  }
  prevProjectiles = newProjs.slice();

  if (newOnes.length === 0) return;
  const me = renderPlayers.find(p => p.id === myId);
  for (const proj of newOnes) {
    // Own bullet: spawns close to my tank barrel
    const isOwn = me && me.alive && Math.hypot(proj.x - me.x, proj.y - me.y) < 58;
    if (proj.weapon === 'rocket') playRocketSound(isOwn);
    else playLaserSound(isOwn);
  }
}

// ─── Background Music (Web Audio scheduler) ───────────────────────────────
const BG_LOOK_AHEAD = 0.18; // seconds to schedule ahead

// Synthesised drum hits scheduled at precise Web Audio times
function kickAt(t) {
  const ac = getAC(); if (!ac || volMusic < 0.01) return;
  const v = volMusic * 0.72;
  const g = ac.createGain();
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.36);
  g.connect(ac.destination);
  const o = ac.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.32);
  o.connect(g); o.start(t); o.stop(t + 0.38);
}

function snareAt(t) {
  const ac = getAC(); if (!ac || volMusic < 0.01) return;
  const v = volMusic * 0.52;
  // Noise body
  const nsz = Math.floor(ac.sampleRate * 0.15);
  const nb = ac.createBuffer(1, nsz, ac.sampleRate);
  const nd = nb.getChannelData(0); for (let i = 0; i < nsz; i++) nd[i] = Math.random() * 2 - 1;
  const ns = ac.createBufferSource(); ns.buffer = nb;
  const hpf = ac.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 1600;
  const ng = ac.createGain();
  ng.gain.setValueAtTime(v, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
  ns.connect(hpf); hpf.connect(ng); ng.connect(ac.destination);
  ns.start(t); ns.stop(t + 0.16);
  // Pitched body tone
  const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = 190;
  const og2 = ac.createGain();
  og2.gain.setValueAtTime(v * 0.55, t); og2.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  o.connect(og2); og2.connect(ac.destination); o.start(t); o.stop(t + 0.08);
}

function hihatAt(t, open) {
  const ac = getAC(); if (!ac || volMusic < 0.01) return;
  const v = volMusic * (open ? 0.26 : 0.14);
  const dur = open ? 0.14 : 0.035;
  const nsz = Math.floor(ac.sampleRate * dur);
  const nb = ac.createBuffer(1, nsz, ac.sampleRate);
  const nd = nb.getChannelData(0); for (let i = 0; i < nsz; i++) nd[i] = Math.random() * 2 - 1;
  const ns = ac.createBufferSource(); ns.buffer = nb;
  const hpf = ac.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 7800;
  const ng = ac.createGain();
  ng.gain.setValueAtTime(v, t); ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
  ns.connect(hpf); hpf.connect(ng); ng.connect(ac.destination);
  ns.start(t); ns.stop(t + dur + 0.01);
}

// Dramatic alarm stab — two-tone "dun-dun"
function alarmAt(t) {
  const ac = getAC(); if (!ac || volMusic < 0.01) return;
  [[0, 740], [0.06, 550], [0.12, 740]].forEach(([off, freq]) => {
    const o = ac.createOscillator(); o.type = 'square'; o.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(volMusic * 0.18, t + off);
    g.gain.exponentialRampToValueAtTime(0.001, t + off + 0.055);
    o.connect(g); g.connect(ac.destination);
    o.start(t + off); o.stop(t + off + 0.06);
  });
}

// Bass note for normal mode groove
function bassAt(t, freq, dur) {
  const ac = getAC(); if (!ac || volMusic < 0.01) return;
  const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq;
  const lpf = ac.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 280;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(volMusic * 0.16, t + 0.01);
  g.gain.setValueAtTime(volMusic * 0.16, t + dur - 0.03);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(lpf); lpf.connect(g); g.connect(ac.destination);
  o.start(t); o.stop(t + dur + 0.01);
}

// Schedule one 16-step bar and queue the next
function scheduleBar() {
  const ac = getAC(); if (!ac) return;
  if (bgScheduleTime < ac.currentTime) bgScheduleTime = ac.currentTime + 0.05;

  const bpm  = bgDramatic ? 172 : 128;
  const step = 60 / bpm / 4;   // 16th note duration in seconds
  const t0   = bgScheduleTime;

  if (bgDramatic) {
    // ── Dramatic: hard double-kick, rapid snare, 16th hi-hats, alarm every 2 bars ──
    // Pattern (16 steps):
    //   K . K . K . K . K . K . K . K .
    //   . S . S . S . S . S . S . S . S
    //   h h h h h h h h h h h h h h h h
    for (let s = 0; s < 16; s++) {
      const t = t0 + s * step;
      if (s % 2 === 0) kickAt(t);
      if (s % 2 === 1) snareAt(t);
      hihatAt(t, false);
    }
    if (bgBarCount % 2 === 0) alarmAt(t0);
  } else {
    // ── Normal: groovy 4/4 with swung hi-hats and walking bass ──
    // Kick:  0, 5, 8, 13  (syncopated)
    // Snare: 4, 12
    // Hi-hat: 8th notes (0,2,4,6,8,10,12,14); open on step 6, 14
    [0, 5, 8, 13].forEach(s => kickAt(t0 + s * step));
    [4, 12].forEach(s => snareAt(t0 + s * step));
    for (let s = 0; s < 16; s += 2) hihatAt(t0 + s * step, s === 6 || s === 14);

    // Bass riff cycles across 6 bars: A E A G A D (power riff)
    const bassRiff = [110, 82.4, 110, 98, 110, 73.4];
    bassAt(t0, bassRiff[bgBarCount % bassRiff.length], step * 6);
  }

  bgBarCount++;
  bgScheduleTime = t0 + 16 * step;
  const delay = Math.max(40, (bgScheduleTime - ac.currentTime - BG_LOOK_AHEAD) * 1000);
  bgScheduleTimer = setTimeout(scheduleBar, delay);
}

function startBattleMusic() {
  getAC();
  stopBattleMusic();
  bgDramatic = false;
  bgBarCount = 0;
  bgScheduleTime = 0;
  const ac = getAC(); if (!ac) return;
  // Subtle sub-bass drone for weight
  bgDroneOsc = ac.createOscillator();
  bgDroneOsc.type = 'sine';
  bgDroneOsc.frequency.value = 55;
  bgDroneGain = ac.createGain();
  bgDroneGain.gain.value = volMusic * 0.028;
  bgDroneOsc.connect(bgDroneGain);
  bgDroneGain.connect(ac.destination);
  bgDroneOsc.start();
  bgScheduleTimer = setTimeout(scheduleBar, 300);
}

function stopBattleMusic() {
  if (bgScheduleTimer) { clearTimeout(bgScheduleTimer); bgScheduleTimer = null; }
  if (bgDroneOsc) { try { bgDroneOsc.stop(); } catch {} bgDroneOsc = null; bgDroneGain = null; }
  bgDramatic = false;
  bgScheduleTime = 0;
  bgBarCount = 0;
  const hud = document.getElementById('game-limit-display');
  if (hud) hud.classList.remove('dramatic');
}

function setDramaticMode(on) {
  if (bgDramatic === on) return;
  bgDramatic = on;
  const ac = getAC();
  if (bgDroneGain && ac) {
    bgDroneGain.gain.setTargetAtTime(volMusic * (on ? 0.06 : 0.028), ac.currentTime, 0.5);
  }
  const hud = document.getElementById('game-limit-display');
  if (hud) hud.classList.toggle('dramatic', on);
}

// ─── Confetti Functions ───────────────────────────────────────────────────
function startConfetti() {
  if (!confettiCanvas) {
    confettiCanvas = document.createElement('canvas');
    confettiCanvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:500';
    document.body.appendChild(confettiCanvas);
  }
  confettiCanvas.width = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
  confettiCtx2d = confettiCanvas.getContext('2d');
  confettiParticles = [];
  for (let i = 0; i < 190; i++) {
    confettiParticles.push({
      x: Math.random() * confettiCanvas.width,
      y: -20 - Math.random() * 380,
      vx: (Math.random() - 0.5) * 4.5,
      vy: 1.4 + Math.random() * 3.2,
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.14,
      w: 7 + Math.random() * 8,
      h: 4 + Math.random() * 5,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      alpha: 1,
    });
  }
  if (confettiRafId) cancelAnimationFrame(confettiRafId);
  (function loop() {
    confettiCtx2d.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    confettiParticles.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.rot += p.rotV;
      p.vy += 0.055; p.vx *= 0.996;
      if (p.y > confettiCanvas.height * 0.78) {
        p.alpha = Math.max(0, 1 - (p.y - confettiCanvas.height * 0.78) / (confettiCanvas.height * 0.22));
      }
      confettiCtx2d.save();
      confettiCtx2d.globalAlpha = p.alpha;
      confettiCtx2d.translate(p.x, p.y);
      confettiCtx2d.rotate(p.rot);
      confettiCtx2d.fillStyle = p.color;
      confettiCtx2d.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      confettiCtx2d.restore();
    });
    confettiParticles = confettiParticles.filter(p => p.y < confettiCanvas.height + 30 && p.alpha > 0.01);
    if (confettiParticles.length > 0) confettiRafId = requestAnimationFrame(loop);
    else confettiRafId = null;
  })();
}

function stopConfetti() {
  if (confettiRafId) { cancelAnimationFrame(confettiRafId); confettiRafId = null; }
  if (confettiCtx2d && confettiCanvas) confettiCtx2d.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  confettiParticles = [];
}

// ─── Screen Management ────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

// ─── Error Toast ──────────────────────────────────────────────────────────
let toastTimer = null;
function showError(msg) {
  const el = document.getElementById('error-toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

// ─── WebRTC ───────────────────────────────────────────────────────────────
function initRTC() {
  if (typeof RTCPeerConnection === 'undefined') return;
  cleanupRTC();
  try {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
    });
    rtcPeer = pc;
    const dc = pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
    rtcChannel = dc;
    dc.onopen = () => { rtcReady = true; };
    dc.onclose = dc.onerror = () => { rtcReady = false; rtcChannel = null; };
    dc.onmessage = ({ data }) => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      handleServerMessage(msg);
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendWS({ type: 'rtc_ice', candidate });
    };
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => sendWS({ type: 'rtc_offer', offer: rtcPeer.localDescription }))
      .catch(() => {});
  } catch { cleanupRTC(); }
}

function cleanupRTC() {
  rtcReady = false;
  rtcCandidateQueue = [];
  if (rtcChannel) { try { rtcChannel.close(); } catch {} rtcChannel = null; }
  if (rtcPeer) { try { rtcPeer.close(); } catch {} rtcPeer = null; }
}

function sendFast(msg) {
  const data = JSON.stringify(msg);
  if (rtcReady && rtcChannel && rtcChannel.readyState === 'open') {
    try { rtcChannel.send(data); return; } catch {}
  }
  if (ws && ws.readyState === 1) ws.send(data);
}

// ─── WebSocket ────────────────────────────────────────────────────────────
function connectWS(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    wsOpen = true;
    reconnectAttempts = 0;
    document.getElementById('reconnect-banner').style.display = 'none';
    if (onOpen) onOpen();
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMessage(msg);
  };
  ws.onclose = () => {
    wsOpen = false;
    if (currentPhase === 'playing' || currentPhase === 'lobby') {
      document.getElementById('reconnect-banner').style.display = 'block';
      scheduleReconnect();
    }
  };
  ws.onerror = () => { ws.close(); };
}

function sendWS(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(500 * reconnectAttempts, 5000);
  setTimeout(() => {
    connectWS(() => {
      if (gameId && myName) {
        sendWS({ type: 'join', name: myName, gameId });
      }
    });
  }, delay);
}

// ─── Server Message Handler ───────────────────────────────────────────────
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'game_created':
      myId = msg.playerId;
      gameId = msg.gameId;
      isHost = true;
      history.replaceState({}, '', `?game=${gameId}`);
      showScreen('lobby');
      updateLobbyId(gameId);
      break;

    case 'game_joined':
      myId = msg.playerId;
      gameId = msg.gameId;
      history.replaceState({}, '', `?game=${gameId}`);
      showScreen('lobby');
      updateLobbyId(gameId);
      break;

    case 'lobby_update':
      hostId = msg.hostId;
      isHost = myId === msg.hostId;
      mode = msg.mode;
      teams = msg.teams || [];
      if (typeof msg.rockDensity === 'number') rockDensity = Math.round(msg.rockDensity * 100);
      if (typeof msg.treeDensity === 'number') treeDensity = Math.round(msg.treeDensity * 100);
      if (typeof msg.isPublic === 'boolean') gameIsPublic = msg.isPublic;
      if (msg.endType) endType = msg.endType;
      if (typeof msg.timeLimitMs === 'number') timeLimitMs = msg.timeLimitMs;
      if (typeof msg.scoreLimit === 'number') scoreLimit = msg.scoreLimit;
      renderLobby(msg.players, msg.hostId, msg.mode, msg.teams);
      break;

    case 'game_start':
      currentPhase = 'playing';
      gameMap = msg.map;
      mapDirty = true;
      renderPlayers = msg.players;
      renderProjectiles = [];
      renderPowerups = [];
      killFeed = [];
      prevProjectiles = [];
      myWasAlive = true; // start alive — don't play spawn sound on game start
      initGameScreen();
      showScreen('game');
      startRenderLoop();
      startInputLoop();
      initRTC();
      startBattleMusic();
      break;


    case 'sync_state':
      currentPhase = msg.phase;
      if (msg.phase === 'playing') {
        gameMap = msg.map;
        mapDirty = true;
        if (!canvas) initGameScreen(); // late-joiner path
        prevProjectiles = [];
        myWasAlive = true;
        if (msg.snapshot) {
          applySnapshot(msg.snapshot);
        }
        showScreen('game');
        startRenderLoop();
        startInputLoop();
        initRTC();
        startBattleMusic();
      }
      document.getElementById('reconnect-banner').style.display = 'none';
      break;

    case 'state':
      applySnapshot(msg);
      break;

    case 'kill': {
      const text = `${msg.killerName} eliminated ${msg.victimName}`;
      killFeed.push({ text, expiresAt: Date.now() + 4000 });
      if (killFeed.length > 5) killFeed.shift();
      break;
    }

    case 'game_over':
      currentPhase = 'ended';
      stopInputLoop();
      stopRenderLoop();
      cleanupRTC();
      stopBattleMusic();
      showEndedScreen(msg.scores);
      showScreen('ended');
      break;

    case 'games_list':
      populateGamesList(msg.games);
      break;

    case 'password_required':
      showPasswordModal(msg.gameId);
      break;

    case 'late_join_changed':
      allowLateJoin = msg.value;
      { const el = document.getElementById('late-join-toggle'); if (el) el.checked = msg.value; }
      break;

    case 'error':
      showError(msg.message);
      break;

    case 'pong':
      break;

    case 'rtc_answer':
      if (rtcPeer) {
        rtcPeer.setRemoteDescription(msg.answer)
          .then(() => {
            for (const c of rtcCandidateQueue) rtcPeer.addIceCandidate(c).catch(() => {});
            rtcCandidateQueue = [];
          })
          .catch(() => {});
      }
      break;

    case 'rtc_ice':
      if (!msg.candidate) break;
      if (rtcPeer && rtcPeer.remoteDescription) {
        rtcPeer.addIceCandidate(msg.candidate).catch(() => {});
      } else {
        rtcCandidateQueue.push(msg.candidate);
      }
      break;
  }
}

function applySnapshot(snap) {
  renderPlayers = snap.players || [];
  renderPowerups = snap.powerups || [];
  if (snap.scores) { renderScores = snap.scores; updateScorePanel(snap.scores); }

  // Bullet sounds: compare against previous snapshot to find genuinely new projectiles
  detectAndPlayNewProjectileSounds(snap.projectiles || []);
  renderProjectiles = snap.projectiles || [];

  // Update my weapon + detect respawn
  const me = renderPlayers.find(p => p.id === myId);
  if (me) {
    // Spawn sound: only on re-spawn after death (false → true)
    if (myWasAlive === false && me.alive) playSpawnSound();
    myWasAlive = me.alive;
    const wname = WEAPON_NAMES[me.weapon] || 'Basic Laser';
    if (myWeapon !== me.weapon) {
      myWeapon = me.weapon;
      document.getElementById('weapon-name').textContent = wname;
    }
  }

  // Update game-limit HUD
  const hud = document.getElementById('game-limit-display');
  if (hud) {
    if (snap.endType === 'time' && snap.timeLeft != null) {
      const secs = Math.ceil(snap.timeLeft / 1000);
      const m = Math.floor(secs / 60), s = secs % 60;
      hud.textContent = `⏱ ${m}:${String(s).padStart(2,'0')}`;
      hud.style.display = '';
      setDramaticMode(snap.timeLeft <= 30000);
    } else if (snap.endType === 'score' && snap.scoreLimit != null) {
      let best = 0;
      if (mode === 'ffa') {
        best = renderScores.length ? renderScores[0].score : 0;
      } else {
        best = renderScores.length ? renderScores[0].total : 0;
      }
      hud.textContent = `🎯 ${best} / ${snap.scoreLimit}`;
      hud.style.display = '';
      setDramaticMode(best > 0 && (snap.scoreLimit - best) <= 5);
    } else {
      hud.style.display = 'none';
    }
  }
}

// ─── Lobby Screen ─────────────────────────────────────────────────────────
function updateLobbyId(id) {
  document.getElementById('lobby-game-id').textContent = id;
}

function renderLobby(players, hId, gameMode, gameTeams) {
  // ── Player list (with team dot) ──
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    if (!p.connected) li.classList.add('player-offline');

    if (gameMode === 'teams' && p.teamIndex >= 0 && p.teamIndex < gameTeams.length) {
      const dot = document.createElement('span');
      dot.className = 'player-team-dot';
      dot.style.background = gameTeams[p.teamIndex].color;
      li.appendChild(dot);
    }
    if (p.id === hId) {
      const badge = document.createElement('span');
      badge.className = 'player-host-badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    }
    li.appendChild(document.createTextNode(p.name || p.id));
    list.appendChild(li);
  }

  // ── Teams roster (visible to all when in teams mode) ──
  const roster = document.getElementById('teams-roster');
  if (gameMode === 'teams') {
    roster.style.display = '';
    roster.style.paddingTop = '';
    roster.innerHTML = '';
    // Align top of first team card with top of first player li
    requestAnimationFrame(() => {
      const firstLi = list.querySelector('li');
      if (firstLi) {
        const bodyEl = document.querySelector('.lobby-body');
        const offset = firstLi.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top;
        roster.style.paddingTop = offset + 'px';
      }
    });
    for (let i = 0; i < gameTeams.length; i++) {
      const t = gameTeams[i];
      const teamPlayers = players.filter(p => p.teamIndex === i);
      const card = document.createElement('div');
      card.className = 'team-card';

      // Header
      const header = document.createElement('div');
      header.className = 'team-card-header';
      const swatch = document.createElement('span');
      swatch.className = 'team-color-swatch';
      swatch.style.background = t.color;
      header.appendChild(swatch);

      if (isHost) {
        const nameInput = document.createElement('input');
        nameInput.className = 'team-name-input';
        nameInput.value = t.name;
        nameInput.maxLength = 16;
        nameInput.addEventListener('change', () => {
          teams[i].name = nameInput.value.trim() || `Team ${i + 1}`;
          sendSetup();
        });
        header.appendChild(nameInput);
        const removeBtn = document.createElement('button');
        removeBtn.className = 'team-remove-btn';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => { teams.splice(i, 1); sendSetup(); });
        header.appendChild(removeBtn);
      } else {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'team-card-name';
        nameSpan.textContent = t.name;
        header.appendChild(nameSpan);
      }

      // Join button (right side of header)
      const me = players.find(p => p.id === myId);
      const onThisTeam = me && me.teamIndex === i;
      const joinBtn = document.createElement('button');
      joinBtn.className = 'btn btn-small';
      joinBtn.style.marginLeft = 'auto';
      if (onThisTeam) {
        joinBtn.textContent = '✓ Joined';
        joinBtn.disabled = true;
      } else {
        joinBtn.textContent = 'Join';
        joinBtn.addEventListener('click', () => sendWS({ type: 'choose_team', teamIndex: i }));
      }
      header.appendChild(joinBtn);
      card.appendChild(header);

      // Members
      const ul = document.createElement('ul');
      ul.className = 'team-card-players';
      if (teamPlayers.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'team-empty';
        empty.textContent = 'No players yet';
        ul.appendChild(empty);
      } else {
        for (const p of teamPlayers) {
          const li = document.createElement('li');
          if (!p.connected) li.classList.add('player-offline');
          li.textContent = p.name;
          ul.appendChild(li);
        }
      }
      card.appendChild(ul);
      roster.appendChild(card);
    }
    // "Add New Team" button at bottom of roster (host only, max 4 teams)
    if (isHost && gameTeams.length < 4) {
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-small';
      addBtn.style.cssText = 'width:100%; margin-top:0.5rem';
      addBtn.textContent = 'Add New Team';
      addBtn.addEventListener('click', () => {
        const colors = ['#e94560','#4080ff','#40c080','#ffd040','#c080ff','#ff8040'];
        teams.push({ name: `Team ${teams.length + 1}`, color: colors[teams.length % colors.length] });
        sendSetup();
      });
      roster.appendChild(addBtn);
    }
  } else {
    roster.style.display = 'none';
    roster.style.paddingTop = '';
  }

  // ── Host controls / waiting msg ──
  const hostControls = document.getElementById('host-controls');
  const visRow = document.getElementById('visibility-row');
  const waitingMsg = document.getElementById('lobby-waiting-msg');
  const startBtn = document.getElementById('start-btn');
  if (isHost) {
    hostControls.style.display = '';
    visRow.style.display = '';
    waitingMsg.style.display = 'none';
    document.getElementById('mode-select').value = gameMode;
    document.getElementById('rock-density').value = rockDensity;
    document.getElementById('rock-density-val').textContent = rockDensity + '%';
    document.getElementById('tree-density').value = treeDensity;
    document.getElementById('tree-density-val').textContent = treeDensity + '%';
    document.getElementById('end-type-select').value = endType;
    updateEndValueUI();
    document.getElementById('game-public-toggle').checked = gameIsPublic;
    document.getElementById('visibility-hint').textContent = gameIsPublic ? 'Visible in browse list' : 'Private — share Game ID to invite';
    document.getElementById('game-password-wrap').style.display = gameIsPublic ? 'none' : '';

    // Validate start conditions
    let canStart = true;
    let startTitle = '';
    if (gameMode === 'teams') {
      const connectedPlayers = players.filter(p => p.connected);
      const populatedTeams = gameTeams.filter((_, i) => connectedPlayers.some(p => p.teamIndex === i));
      if (populatedTeams.length < 2) {
        canStart = false;
        startTitle = 'Need at least 2 teams with 1 player each';
      }
    }
    startBtn.disabled = !canStart;
    startBtn.title = startTitle;
  } else {
    hostControls.style.display = 'none';
    visRow.style.display = 'none';
    waitingMsg.style.display = '';
  }
}


function sendSetup() {
  sendWS({ type: 'setup', mode, teams, rockDensity: rockDensity / 100, treeDensity: treeDensity / 100, isPublic: gameIsPublic, password: gamePassword, endType, timeLimitMs, scoreLimit });
}

function updateEndValueUI() {
  const wrap = document.getElementById('end-value-wrap');
  const label = document.getElementById('end-value-label');
  const input = document.getElementById('end-value-input');
  if (endType === 'unlimited') {
    wrap.style.display = 'none';
  } else if (endType === 'time') {
    wrap.style.display = '';
    label.textContent = 'Minutes';
    input.min = 1; input.max = 60; input.step = 1;
    input.value = Math.round(timeLimitMs / 60000);
  } else {
    wrap.style.display = '';
    label.textContent = 'Score limit';
    input.min = 1; input.max = 9999; input.step = 1;
    input.value = scoreLimit;
  }
}

// ─── Browse Screen ────────────────────────────────────────────────────────
function showBrowseScreen() {
  showScreen('browse');
  const urlGameId = new URLSearchParams(location.search).get('game');
  if (urlGameId) document.getElementById('browse-game-id-input').value = urlGameId;
  document.getElementById('games-list').innerHTML = '';
  document.getElementById('games-list-empty').style.display = '';
  if (!wsOpen) {
    connectWS(() => sendWS({ type: 'list_games' }));
  } else {
    sendWS({ type: 'list_games' });
  }
  browseRefreshTimer = setInterval(() => { if (wsOpen) sendWS({ type: 'list_games' }); }, 5000);
}

function hideBrowseScreen() {
  clearInterval(browseRefreshTimer); browseRefreshTimer = null;
  showScreen('home');
}

function populateGamesList(gamesList) {
  const container = document.getElementById('games-list');
  const empty = document.getElementById('games-list-empty');
  container.innerHTML = '';
  if (!gamesList || gamesList.length === 0) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  for (const g of gamesList) {
    const entry = document.createElement('div');
    entry.className = 'game-entry';

    const info = document.createElement('div');
    info.className = 'game-entry-info';
    const hostSpan = document.createElement('span');
    hostSpan.className = 'game-entry-host';
    hostSpan.textContent = `${g.hostName}'s game`;
    const metaSpan = document.createElement('span');
    metaSpan.className = 'game-entry-meta';
    const modeLabel = g.mode === 'teams' ? 'Teams' : 'FFA';
    const phaseHtml = g.phase === 'playing'
      ? `<span class="game-entry-playing">Playing</span>`
      : 'In Lobby';
    metaSpan.innerHTML = `${modeLabel} &middot; ${g.playerCount} player${g.playerCount !== 1 ? 's' : ''} &middot; ${phaseHtml}`;
    info.appendChild(hostSpan);
    info.appendChild(metaSpan);

    const actions = document.createElement('div');
    actions.className = 'game-entry-actions';
    if (g.hasPassword) {
      const lock = document.createElement('span');
      lock.className = 'lock-badge'; lock.title = 'Password protected'; lock.textContent = '🔒';
      actions.appendChild(lock);
    }
    const joinBtn = document.createElement('button');
    joinBtn.className = 'btn btn-primary btn-small';
    joinBtn.textContent = 'Join';
    joinBtn.addEventListener('click', () => {
      if (g.hasPassword) { showPasswordModal(g.gameId); }
      else { connectAndJoin(g.gameId, ''); }
    });
    actions.appendChild(joinBtn);

    entry.appendChild(info);
    entry.appendChild(actions);
    container.appendChild(entry);
  }
}

function connectAndJoin(gid, password) {
  const doJoin = () => sendWS({ type: 'join', name: myName, gameId: gid, password: password || undefined });
  if (!wsOpen) { connectWS(doJoin); } else { doJoin(); }
}

// ─── Password Modal ───────────────────────────────────────────────────────
function showPasswordModal(gameId) {
  pendingJoinGameId = gameId;
  document.getElementById('join-password-input').value = '';
  document.getElementById('password-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('join-password-input').focus(), 50);
}

function hidePasswordModal() {
  document.getElementById('password-modal').style.display = 'none';
  pendingJoinGameId = null;
}

function submitPasswordJoin() {
  if (!pendingJoinGameId) return;
  const password = document.getElementById('join-password-input').value;
  connectAndJoin(pendingJoinGameId, password);
  hidePasswordModal();
}

// ─── Game Screen Initialization ───────────────────────────────────────────
function initGameScreen() {
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');

  mapCanvas = document.createElement('canvas');
  mapCanvas.width = 992; mapCanvas.height = 736;
  mapCtx = mapCanvas.getContext('2d');

  treeCanvas = document.createElement('canvas');
  treeCanvas.width = 992; treeCanvas.height = 736;
  treeCtx = treeCanvas.getContext('2d');

  document.getElementById('end-game-btn-wrap').style.display = isHost ? '' : 'none';
  document.getElementById('exit-game-btn-wrap').style.display = isHost ? 'none' : '';
  document.getElementById('instr-divider').style.display = isHost ? '' : 'none';
  const lateJoinWrap = document.getElementById('late-join-wrap');
  lateJoinWrap.style.display = isHost ? '' : 'none';
  document.getElementById('late-join-toggle').checked = allowLateJoin;
  document.getElementById('weapon-name').textContent = WEAPON_NAMES['laser'];
  myWeapon = 'laser';
}

// ─── Static Map Rendering ─────────────────────────────────────────────────
function renderStaticMap() {
  if (!gameMap) return;
  const { tiles, cols, rows } = gameMap;

  {
    mapCtx.fillStyle = '#2d4a1e';
    mapCtx.fillRect(0, 0, 992, 736);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const t = tiles[r * cols + c];
        const x = c * TILE_SIZE, y = r * TILE_SIZE;
        if (t === TILE_ROCK) {
          const mc = mapCtx;
          const cx = x + TILE_SIZE / 2, cy = y + TILE_SIZE / 2;
          // Drop shadow
          mc.fillStyle = 'rgba(0,0,0,0.38)';
          mc.beginPath(); mc.ellipse(cx + 4, cy + 5, 13, 9, 0.2, 0, Math.PI * 2); mc.fill();
          // Side face (south-east wall — gives 2.5D height)
          mc.fillStyle = '#303038';
          mc.beginPath(); mc.roundRect(x + 4, y + 5, TILE_SIZE - 2, TILE_SIZE - 2, 4); mc.fill();
          // Top face
          mc.fillStyle = '#5c5c6e';
          mc.strokeStyle = '#28282f'; mc.lineWidth = 1.5;
          mc.beginPath(); mc.roundRect(x + 1, y + 1, TILE_SIZE - 4, TILE_SIZE - 5, 4); mc.fill(); mc.stroke();
          // Top-face highlight (upper-left lit corner)
          mc.fillStyle = '#7a7a8e';
          mc.beginPath(); mc.roundRect(x + 3, y + 3, 11, 7, 2); mc.fill();
          // Crack
          mc.strokeStyle = 'rgba(0,0,0,0.30)'; mc.lineWidth = 1;
          mc.beginPath(); mc.moveTo(cx - 1, cy - 5); mc.lineTo(cx + 4, cy + 1); mc.lineTo(cx + 2, cy + 6); mc.stroke();
        } else {
          mapCtx.fillStyle = (c + r) % 2 === 0 ? '#2d4a1e' : '#2a451c';
          mapCtx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
        }
      }
    }
    // 2.5D top-down trees — drawn directly to treeCtx
    treeCtx.clearRect(0, 0, 992, 736);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (tiles[r * cols + c] !== TILE_TREE) continue;
        const x = c * TILE_SIZE + TILE_SIZE / 2;
        const y = r * TILE_SIZE + TILE_SIZE / 2;
        const tc = treeCtx;

        // Drop shadow — offset down-right to give 2.5D elevation feel
        tc.fillStyle = 'rgba(0,0,0,0.28)';
        tc.beginPath(); tc.ellipse(x + 5, y + 8, 18, 11, 0, 0, Math.PI * 2); tc.fill();

        // Canopy outer ring (dark rim)
        tc.fillStyle = '#1c5610'; tc.strokeStyle = '#0e3008'; tc.lineWidth = 1.5;
        tc.beginPath(); tc.arc(x, y, 18, 0, Math.PI * 2); tc.fill(); tc.stroke();

        // Main canopy
        tc.fillStyle = '#2e8c1a';
        tc.beginPath(); tc.arc(x, y - 1, 15, 0, Math.PI * 2); tc.fill();

        // Light side (sun from upper-left)
        tc.fillStyle = '#42b424';
        tc.beginPath(); tc.arc(x - 4, y - 5, 11, 0, Math.PI * 2); tc.fill();

        // Highlight dome
        tc.fillStyle = '#6cd836';
        tc.beginPath(); tc.arc(x - 6, y - 8, 6, 0, Math.PI * 2); tc.fill();

        // Specular glint
        tc.fillStyle = 'rgba(210,255,170,0.50)';
        tc.beginPath(); tc.arc(x - 8, y - 11, 3, 0, Math.PI * 2); tc.fill();

        // Shadow recesses in foliage
        tc.fillStyle = 'rgba(0,35,0,0.22)';
        tc.beginPath(); tc.arc(x + 9, y + 4, 7, 0, Math.PI * 2); tc.fill();
        tc.beginPath(); tc.arc(x - 7, y + 9, 5, 0, Math.PI * 2); tc.fill();

        // Trunk stub (visible at the south base in 2.5D)
        tc.fillStyle = '#5a3010'; tc.strokeStyle = '#3a1e08'; tc.lineWidth = 1;
        tc.beginPath(); tc.ellipse(x, y + 16, 3, 2, 0, 0, Math.PI * 2); tc.fill(); tc.stroke();
      }
    }
  }

  mapDirty = false;
}

// ─── Player Color Helper ──────────────────────────────────────────────────
function playerColor(player) {
  if (mode === 'teams' && player.teamIndex >= 0 && player.teamIndex < teams.length) {
    return teams[player.teamIndex].color;
  }
  const allIds = renderPlayers.map(p => p.id);
  const idx = allIds.indexOf(player.id);
  return TANK_COLORS[idx % TANK_COLORS.length];
}

// ─── Color Helper ─────────────────────────────────────────────────────────
function shadeColor(hex, amount) {
  try {
    const r = Math.max(0, Math.min(255, parseInt(hex.slice(1,3), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.slice(3,5), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.slice(5,7), 16) + amount));
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  } catch { return hex; }
}

// ─── Cartoon Tank Renderer ────────────────────────────────────────────────
function drawCartoonTank(ctx, dir, color) {
  const ol = '#111';

  // Drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath(); ctx.ellipse(4, 5, 15, 11, 0, 0, Math.PI * 2); ctx.fill();

  // Tracks
  ctx.fillStyle = '#3e3e3e';
  ctx.strokeStyle = ol;
  ctx.lineWidth = 1;
  if (dir === 'E' || dir === 'W') {
    ctx.beginPath(); ctx.roundRect(-13, -15, 26, 5, 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(-13, 10, 26, 5, 2); ctx.fill(); ctx.stroke();
    // Track link marks
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 0.7;
    for (let tx = -10; tx <= 10; tx += 4) {
      ctx.beginPath(); ctx.moveTo(tx, -15); ctx.lineTo(tx, -10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tx, 10); ctx.lineTo(tx, 15); ctx.stroke();
    }
  } else {
    ctx.beginPath(); ctx.roundRect(-15, -13, 5, 26, 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(10, -13, 5, 26, 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 0.7;
    for (let ty = -10; ty <= 10; ty += 4) {
      ctx.beginPath(); ctx.moveTo(-15, ty); ctx.lineTo(-10, ty); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(10, ty); ctx.lineTo(15, ty); ctx.stroke();
    }
  }

  // Barrel
  ctx.fillStyle = '#aaaaaa';
  ctx.strokeStyle = ol; ctx.lineWidth = 1.5;
  if      (dir === 'E') { ctx.beginPath(); ctx.roundRect( 9,    -3.5, 13, 7, 3); ctx.fill(); ctx.stroke(); }
  else if (dir === 'W') { ctx.beginPath(); ctx.roundRect(-22,   -3.5, 13, 7, 3); ctx.fill(); ctx.stroke(); }
  else if (dir === 'N') { ctx.beginPath(); ctx.roundRect(-3.5, -22,   7, 13, 3); ctx.fill(); ctx.stroke(); }
  else if (dir === 'S') { ctx.beginPath(); ctx.roundRect(-3.5,   9,   7, 13, 3); ctx.fill(); ctx.stroke(); }

  // Body side face (2.5D depth — darker offset copy)
  ctx.fillStyle = shadeColor(color, -70);
  ctx.strokeStyle = ol; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(-9, -9, 22, 22, 4); ctx.fill(); ctx.stroke();

  // Body top face
  ctx.fillStyle = color;
  ctx.strokeStyle = ol; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(-11, -11, 22, 22, 4); ctx.fill(); ctx.stroke();

  // Body highlight (top-left sheen)
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath(); ctx.roundRect(-9, -9, 10, 7, 2); ctx.fill();

  // Turret
  ctx.fillStyle = shadeColor(color, -35);
  ctx.strokeStyle = ol; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, 7.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  // Turret highlight
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath(); ctx.arc(-2, -2, 3.5, 0, Math.PI * 2); ctx.fill();
}

// ─── Powerup Icon Renderer ────────────────────────────────────────────────
function drawPowerupIcon(ctx, type, x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  switch (type) {
    case 'rocket': {
      ctx.save();
      ctx.rotate(-Math.PI / 4); // 45° diagonal, pointing up-right
      // Body
      ctx.beginPath();
      ctx.roundRect(-2.5, -7, 5, 11, 1.5);
      ctx.fill();
      // Nose cone
      ctx.beginPath();
      ctx.moveTo(-2.5, -7); ctx.lineTo(2.5, -7); ctx.lineTo(0, -12);
      ctx.closePath(); ctx.fill();
      // Left fin
      ctx.beginPath();
      ctx.moveTo(-2.5, 1); ctx.lineTo(-6, 6); ctx.lineTo(-2.5, 4);
      ctx.closePath(); ctx.fill();
      // Right fin
      ctx.beginPath();
      ctx.moveTo(2.5, 1); ctx.lineTo(6, 6); ctx.lineTo(2.5, 4);
      ctx.closePath(); ctx.fill();
      // Flame
      ctx.fillStyle = '#fff9';
      ctx.beginPath();
      ctx.moveTo(-2, 4); ctx.lineTo(2, 4); ctx.lineTo(0, 8);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      break;
    }
    case 'triple_laser': {
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      // Three converging beams
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(-9, i * 3.5);
        ctx.lineTo(5, i * 1.2);
        ctx.stroke();
      }
      // Arrowhead
      ctx.beginPath();
      ctx.moveTo(5, -3); ctx.lineTo(10, 0); ctx.lineTo(5, 3);
      ctx.closePath(); ctx.fill();
      break;
    }
    case 'full_armor': {
      ctx.lineWidth = 1.5;
      // Shield outline
      ctx.beginPath();
      ctx.moveTo(0, -10); ctx.lineTo(8, -5); ctx.lineTo(8, 3);
      ctx.lineTo(0, 10); ctx.lineTo(-8, 3); ctx.lineTo(-8, -5);
      ctx.closePath();
      ctx.fillStyle = color + '28'; ctx.fill();
      ctx.stroke();
      // Checkmark
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(-4, 0); ctx.lineTo(-1, 4); ctx.lineTo(5, -4);
      ctx.stroke();
      break;
    }
    case 'cloak': {
      ctx.lineWidth = 1.5;
      // Ghost body
      ctx.beginPath();
      ctx.arc(0, -1, 8, Math.PI, 0);
      ctx.lineTo(8, 8);
      ctx.quadraticCurveTo(5.5, 11, 3.5, 8);
      ctx.quadraticCurveTo(1.5, 5, 0, 8);
      ctx.quadraticCurveTo(-1.5, 11, -3.5, 8);
      ctx.lineTo(-8, 8);
      ctx.closePath();
      ctx.fillStyle = color + '25'; ctx.fill();
      ctx.stroke();
      // Eyes
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(-2.5, 1.5, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(2.5, 1.5, 1.5, 0, Math.PI * 2); ctx.fill();
      break;
    }
    default: {
      ctx.font = 'bold 13px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, 0);
    }
  }
  ctx.restore();
}

// ─── Instruction Icons ────────────────────────────────────────────────────
function drawInstructionIcons() {
  const icons = [
    { id: 'icon-triple-laser', type: 'triple_laser', color: '#40c0ff' },
    { id: 'icon-rocket',       type: 'rocket',       color: '#ff8040' },
    { id: 'icon-armor',        type: 'full_armor',   color: '#40ff80' },
    { id: 'icon-cloak',        type: 'cloak',        color: '#c080ff' },
  ];
  for (const { id, type, color } of icons) {
    const el = document.getElementById(id);
    if (!el) continue;
    const c = el.getContext('2d');
    const cx = 14, cy = 14;
    c.clearRect(0, 0, 28, 28);
    c.beginPath(); c.arc(cx, cy, 13, 0, Math.PI * 2);
    c.fillStyle = color + '28'; c.fill();
    c.beginPath(); c.arc(cx, cy, 13, 0, Math.PI * 2);
    c.strokeStyle = color; c.lineWidth = 1.5; c.stroke();
    drawPowerupIcon(c, type, cx, cy, color);
  }
}

// ─── Main Render Frame ────────────────────────────────────────────────────
function renderFrame() {
  if (!canvas || !gameMap) return;
  const now = Date.now();

  if (mapDirty) renderStaticMap();

  // Blit ground + rocks
  ctx.drawImage(mapCanvas, 0, 0);

  // Powerups
  for (const pu of renderPowerups) {
    const color = POWERUP_COLORS[pu.type] || '#ffffff';
    ctx.save();
    // Glowing circle background
    ctx.beginPath();
    ctx.arc(pu.x, pu.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = color + '28';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pu.x, pu.y, 13, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Icon
    drawPowerupIcon(ctx, pu.type, pu.x, pu.y, color);
    ctx.restore();
  }

  // Tanks
  for (const p of renderPlayers) {
    if (!p.alive) continue;
    const isMe = p.id === myId;
    if (p.cloaked && !isMe) continue;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = p.cloaked ? 0.4 : 1.0;
    const color = playerColor(p);

    // Spawn-protection shield ring (replaces the old blink effect)
    if (p.spawnProtected) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.013); // slow pulsing
      // Outer glow
      ctx.beginPath(); ctx.arc(0, 0, 25, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(80,200,255,${0.10 + pulse * 0.22})`; ctx.lineWidth = 11; ctx.stroke();
      // Hard ring
      ctx.beginPath(); ctx.arc(0, 0, 25, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(160,230,255,${0.55 + pulse * 0.45})`; ctx.lineWidth = 2; ctx.stroke();
      // Inner shimmer
      ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(200,240,255,${pulse * 0.4})`; ctx.lineWidth = 1.5; ctx.stroke();
    }

    if (p.armored) {
      // Pulsing armor ring (green) — same style as spawn shield
      const armorPulse = 0.5 + 0.5 * Math.sin(now * 0.016);
      ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(64,255,128,${0.10 + armorPulse * 0.24})`; ctx.lineWidth = 11; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(80,255,160,${0.55 + armorPulse * 0.45})`; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(160,255,200,${armorPulse * 0.38})`; ctx.lineWidth = 1.5; ctx.stroke();
    }
    drawCartoonTank(ctx, p.dir, color);
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = isMe ? '#ffffff' : '#dddddd';
    ctx.font = isMe ? 'bold 11px sans-serif' : '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(p.name || '', 0, -19);
    ctx.restore();
  }

  // Projectiles
  for (const pr of renderProjectiles) {
    if (pr.weapon === 'rocket') {
      // Draw rocket sprite aligned to travel direction
      // North=0, East=+π/2 (CW), South=π (flip), West=-π/2 (CCW)
      let angle = 0;
      if      (pr.dx > 0) angle =  Math.PI / 2;
      else if (pr.dx < 0) angle = -Math.PI / 2;
      else if (pr.dy > 0) angle =  Math.PI;
      const scale = pr.size / 10;
      ctx.save();
      ctx.translate(pr.x, pr.y);
      ctx.rotate(angle);
      ctx.scale(scale, scale);
      ctx.fillStyle = '#ff8040';
      // Body
      ctx.beginPath(); ctx.roundRect(-2.5, -7, 5, 11, 1.5); ctx.fill();
      // Nose cone
      ctx.beginPath();
      ctx.moveTo(-2.5, -7); ctx.lineTo(2.5, -7); ctx.lineTo(0, -12);
      ctx.closePath(); ctx.fill();
      // Left fin
      ctx.beginPath();
      ctx.moveTo(-2.5, 1); ctx.lineTo(-6, 6); ctx.lineTo(-2.5, 4);
      ctx.closePath(); ctx.fill();
      // Right fin
      ctx.beginPath();
      ctx.moveTo(2.5, 1); ctx.lineTo(6, 6); ctx.lineTo(2.5, 4);
      ctx.closePath(); ctx.fill();
      // Flame
      ctx.fillStyle = '#fff9';
      ctx.beginPath();
      ctx.moveTo(-2, 4); ctx.lineTo(2, 4); ctx.lineTo(0, 8);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = '#ffff80';
      const half = pr.size / 2;
      ctx.fillRect(pr.x - half, pr.y - half, pr.size, pr.size);
    }
  }

  // Trees on top — semi-transparent so hidden tanks are still visible
  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.drawImage(treeCanvas, 0, 0);
  ctx.restore();

  renderKillFeed(now);
}

function updateScorePanel(scores) {
  const body = document.getElementById('score-panel-body');
  if (!body) return;

  body.innerHTML = '';

  if (mode === 'ffa') {
    for (const s of (scores || [])) {
      const row = document.createElement('div');
      row.className = 'panel-score-row' + (s.id === myId ? ' is-me' : '');

      const dot = document.createElement('span');
      dot.className = 'panel-score-dot';
      dot.style.background = TANK_COLORS[renderPlayers.findIndex(p => p.id === s.id) % TANK_COLORS.length] || '#888';
      const name = document.createElement('span');
      name.className = 'panel-score-name';
      name.textContent = s.name;
      const pts = document.createElement('span');
      pts.className = 'panel-score-pts';
      pts.textContent = s.score;
      row.append(dot, name, pts);
      body.appendChild(row);
    }
  } else {
    for (const team of (scores || [])) {
      const color = (teams[team.index] || {}).color || '#888';
      const header = document.createElement('div');
      header.className = 'panel-team-header';

      const dot = document.createElement('span');
      dot.className = 'panel-score-dot';
      dot.style.background = color;
      header.appendChild(dot);
      header.appendChild(document.createTextNode(team.name));
      const total = document.createElement('span');
      total.className = 'panel-team-total';
      total.textContent = team.total;
      header.appendChild(total);
      body.appendChild(header);
      for (const p of (team.players || [])) {
        const row = document.createElement('div');
        row.className = 'panel-score-row' + (p.id === myId ? ' is-me' : '');
        row.style.paddingLeft = '1rem';

        const name = document.createElement('span');
        name.className = 'panel-score-name';
        name.textContent = p.name;
        const pts = document.createElement('span');
        pts.className = 'panel-score-pts';
        pts.textContent = p.score;
        row.append(name, pts);
        body.appendChild(row);
      }
    }
  }

}

function renderKillFeed(now) {
  // Clean expired
  killFeed = killFeed.filter(k => k.expiresAt > now);
  const container = document.getElementById('kill-feed');
  container.innerHTML = '';
  for (const k of killFeed.slice(-4)) {
    const div = document.createElement('div');
    div.className = 'kill-entry';
    div.textContent = k.text;
    container.appendChild(div);
  }
}

// ─── Render Loop ──────────────────────────────────────────────────────────
function startRenderLoop() {
  if (rafId) return;
  function loop() {
    renderFrame();
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
}

function stopRenderLoop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

// ─── Input Loop ───────────────────────────────────────────────────────────
function startInputLoop() {
  if (inputInterval) return;
  inputInterval = setInterval(() => {
    sendFast({ type: 'input', dir: localDir, firing: firingHeld, moving: isMoving });
  }, 50);
}

function stopInputLoop() {
  if (inputInterval) { clearInterval(inputInterval); inputInterval = null; }
}

// ─── Ended Screen ─────────────────────────────────────────────────────────
const MEDALS = ['🥇', '🥈', '🥉'];

function showEndedScreen(scores) {
  stopConfetti();
  const container = document.getElementById('final-scores');
  container.innerHTML = '';

  if (!scores || scores.length === 0) {
    container.textContent = 'No scores recorded.';
    document.getElementById('play-again-btn').style.display = isHost ? '' : 'none';
    return;
  }

  if (mode === 'ffa') {
    for (let i = 0; i < scores.length; i++) {
      const s = scores[i];
      const row = document.createElement('div');
      row.className = 'score-row' + (i === 0 ? ' score-winner' : '');
      const rankEl = i < 3
        ? `<span class="score-rank-medal">${MEDALS[i]}</span>`
        : `<span class="score-rank">${i + 1}.</span>`;
      row.innerHTML = `${rankEl}<span class="score-name">${escHtml(s.name)}</span><span class="score-pts">${s.score} pts</span>`;
      container.appendChild(row);
    }
  } else {
    for (let ti = 0; ti < scores.length; ti++) {
      const team = scores[ti];
      const header = document.createElement('div');
      header.className = 'score-team-header' + (ti === 0 ? ' score-winner-team' : '');
      const dot = document.createElement('span');
      dot.className = 'score-team-dot';
      dot.style.background = (teams[team.index] || {}).color || '#888';
      header.appendChild(dot);
      const medalPrefix = ti < 3 ? MEDALS[ti] + ' ' : '';
      header.appendChild(document.createTextNode(`${medalPrefix}${team.name} — Rank ${ti + 1}`));
      const total = document.createElement('span');
      total.className = 'score-team-total';
      total.textContent = `${team.total} pts`;
      header.appendChild(total);
      container.appendChild(header);

      for (const p of (team.players || [])) {
        const row = document.createElement('div');
        row.className = 'score-row score-indent';
        row.innerHTML = `<span class="score-name">${escHtml(p.name)}</span><span class="score-pts">${p.score} pts</span>`;
        container.appendChild(row);
      }
    }
  }

  document.getElementById('play-again-btn').style.display = isHost ? '' : 'none';

  // Confetti celebration when there's a real winner
  if (scores.length > 1) setTimeout(startConfetti, 300);
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Event Listeners ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  drawInstructionIcons();

  // Home screen
  const nameInput = document.getElementById('name-input');

  const urlParams = new URLSearchParams(location.search);
  const urlGameId = urlParams.get('game');

  function validateName(name) {
    if (name.length < 4) return 'Name must be at least 4 characters';
    if (name.length > 15) return 'Name must be at most 15 characters';
    if (!/^[\x20-\x7E]+$/.test(name)) return 'Name must contain only ASCII characters';
    return null;
  }

  // Prefill name from previous session
  try { const saved = localStorage.getItem('nm_name'); if (saved) nameInput.value = saved; } catch {}

  document.getElementById('create-btn').addEventListener('click', () => {
    myName = nameInput.value.trim();
    const err = validateName(myName);
    if (err) { showError(err); return; }
    try { localStorage.setItem('nm_name', myName); } catch {}
    connectWS(() => sendWS({ type: 'join', name: myName }));
  });

  document.getElementById('enter-lobby-btn').addEventListener('click', () => {
    myName = nameInput.value.trim();
    const err = validateName(myName);
    if (err) { showError(err); return; }
    try { localStorage.setItem('nm_name', myName); } catch {}
    showBrowseScreen();
  });

  document.getElementById('back-to-home-btn').addEventListener('click', hideBrowseScreen);
  document.getElementById('refresh-games-btn').addEventListener('click', () => {
    if (wsOpen) sendWS({ type: 'list_games' });
  });

  document.getElementById('browse-join-btn').addEventListener('click', () => {
    const gid = document.getElementById('browse-game-id-input').value.trim().toUpperCase();
    const pwd = document.getElementById('browse-password-input').value;
    if (!gid) { showError('Please enter a game ID'); return; }
    connectAndJoin(gid, pwd);
  });

  document.getElementById('browse-game-id-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('browse-join-btn').click();
  });
  document.getElementById('browse-password-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('browse-join-btn').click();
  });

  nameInput.focus();

  // Lobby
  document.getElementById('copy-link-btn').addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?game=${gameId}`;
    navigator.clipboard.writeText(url).catch(() => {});
    document.getElementById('copy-link-btn').textContent = 'Copied!';
    setTimeout(() => { document.getElementById('copy-link-btn').textContent = 'Copy Link'; }, 1500);
  });

  document.getElementById('mode-select').addEventListener('change', (e) => {
    mode = e.target.value;
    sendSetup();
  });

  document.getElementById('game-public-toggle').addEventListener('change', (e) => {
    gameIsPublic = e.target.checked;
    if (gameIsPublic) { gamePassword = ''; document.getElementById('game-password-input').value = ''; }
    document.getElementById('game-password-wrap').style.display = gameIsPublic ? 'none' : '';
    document.getElementById('visibility-hint').textContent = gameIsPublic ? 'Visible in browse list' : 'Private — share Game ID to invite';
    sendSetup();
  });

  document.getElementById('game-password-input').addEventListener('input', (e) => {
    gamePassword = e.target.value;
    clearTimeout(passwordInputTimer);
    passwordInputTimer = setTimeout(sendSetup, 600);
  });

  document.getElementById('password-submit-btn').addEventListener('click', submitPasswordJoin);
  document.getElementById('password-cancel-btn').addEventListener('click', hidePasswordModal);
  document.getElementById('join-password-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPasswordJoin();
    if (e.key === 'Escape') hidePasswordModal();
  });

  document.getElementById('rock-density').addEventListener('input', (e) => {
    rockDensity = parseInt(e.target.value);
    document.getElementById('rock-density-val').textContent = rockDensity + '%';
    sendSetup();
  });

  document.getElementById('tree-density').addEventListener('input', (e) => {
    treeDensity = parseInt(e.target.value);
    document.getElementById('tree-density-val').textContent = treeDensity + '%';
    sendSetup();
  });

  document.getElementById('end-type-select').addEventListener('change', (e) => {
    endType = e.target.value;
    updateEndValueUI();
    sendSetup();
  });

  document.getElementById('end-value-input').addEventListener('change', (e) => {
    const val = parseInt(e.target.value) || 0;
    if (endType === 'time') timeLimitMs = Math.max(60000, val * 60000);
    else scoreLimit = Math.max(1, val);
    sendSetup();
  });


  document.getElementById('start-btn').addEventListener('click', () => {
    sendWS({ type: 'start_game' });
  });

  // Game
  document.getElementById('end-game-btn').addEventListener('click', () => {
    if (confirm('End the game?')) sendWS({ type: 'end_game' });
  });

  document.getElementById('exit-game-btn').addEventListener('click', () => {
    if (confirm('Exit the game?')) {
      currentPhase = 'ended'; // prevent ws.onclose from triggering reconnect
      stopRenderLoop(); stopInputLoop(); cleanupRTC(); stopBattleMusic();
      if (ws) { ws.close(); ws = null; wsOpen = false; }
      document.getElementById('name-input').value = myName;
      showScreen('home');
    }
  });

  document.getElementById('late-join-toggle').addEventListener('change', (e) => {
    sendWS({ type: 'toggle_late_join', value: e.target.checked });
  });


  // Ended
  document.getElementById('play-again-btn').addEventListener('click', () => {
    sendWS({ type: 'play_again' });
    currentPhase = 'lobby';
    showScreen('lobby');
  });

  document.getElementById('leave-btn').addEventListener('click', () => {
    if (ws) ws.close();
    location.href = location.pathname;
  });

  // Keyboard input
  const DIR_KEYS = {
    ArrowUp: 'N', ArrowDown: 'S', ArrowLeft: 'W', ArrowRight: 'E',
    KeyW: 'N', KeyS: 'S', KeyA: 'W', KeyD: 'E',
    'w': 'N', 's': 'S', 'a': 'W', 'd': 'E',
  };

  document.addEventListener('keydown', (e) => {
    if (currentPhase !== 'playing') return;
    const dir = DIR_KEYS[e.code] || DIR_KEYS[e.key];
    if (dir) { localDir = dir; isMoving = true; e.preventDefault(); }
    if (e.code === 'Space') { firingHeld = true; e.preventDefault(); }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { isMoving = false; e.preventDefault(); }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') firingHeld = false;
  });

  // Sound config modal
  loadSoundSettings();

  function syncSoundUI() {
    document.getElementById('vol-music').value = Math.round(volMusic * 100);
    document.getElementById('vol-music-val').textContent = Math.round(volMusic * 100) + '%';
    document.getElementById('vol-laser').value = Math.round(volLaser * 100);
    document.getElementById('vol-laser-val').textContent = Math.round(volLaser * 100) + '%';
    document.getElementById('vol-rocket').value = Math.round(volRocket * 100);
    document.getElementById('vol-rocket-val').textContent = Math.round(volRocket * 100) + '%';
    document.getElementById('vol-enemy').value = Math.round(volEnemy * 100);
    document.getElementById('vol-enemy-val').textContent = Math.round(volEnemy * 100) + '%';
  }
  syncSoundUI();

  document.getElementById('sound-config-btn').addEventListener('click', () => {
    syncSoundUI();
    document.getElementById('sound-modal').style.display = 'flex';
  });

  document.getElementById('sound-modal-close').addEventListener('click', () => {
    document.getElementById('sound-modal').style.display = 'none';
    saveSoundSettings();
  });

  function bindVolSlider(id, setter) {
    document.getElementById(id).addEventListener('input', (e) => {
      const v = parseInt(e.target.value) / 100;
      setter(v);
      document.getElementById(id + '-val').textContent = e.target.value + '%';
    });
  }

  bindVolSlider('vol-music', v => {
    volMusic = v;
    if (bgDroneGain && audioCtx) bgDroneGain.gain.setTargetAtTime(volMusic * (bgDramatic ? 0.09 : 0.04), audioCtx.currentTime, 0.2);
  });
  bindVolSlider('vol-laser', v => { volLaser = v; });
  bindVolSlider('vol-rocket', v => { volRocket = v; });
  bindVolSlider('vol-enemy', v => { volEnemy = v; });

  // Ping keepalive
  setInterval(() => {
    if (wsOpen) sendWS({ type: 'ping' });
  }, 30000);
});
