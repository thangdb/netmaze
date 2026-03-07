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
let allowLateJoin = false;
let currentPhase = 'lobby'; // local tracking
let gameMap = null;
let localDir = 'E', firingHeld = false, isMoving = false;
let mode = 'ffa', teams = [];
let rockDensity = 2, treeDensity = 2; // percentages, synced from server
let gameIsPublic = true, gamePassword = '';
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

// WebRTC
let rtcPeer = null, rtcChannel = null, rtcCandidateQueue = [], rtcReady = false;

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
      initGameScreen();
      showScreen('game');
      startRenderLoop();
      startInputLoop();
      initRTC();
      break;


    case 'sync_state':
      currentPhase = msg.phase;
      if (msg.phase === 'playing') {
        gameMap = msg.map;
        mapDirty = true;
        if (!canvas) initGameScreen(); // late-joiner path
        if (msg.snapshot) {
          applySnapshot(msg.snapshot);
        }
        showScreen('game');
        startRenderLoop();
        startInputLoop();
        initRTC();
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
  renderProjectiles = snap.projectiles || [];
  renderPowerups = snap.powerups || [];
  if (snap.scores) { renderScores = snap.scores; updateScorePanel(snap.scores); }

  // Update my weapon
  const me = renderPlayers.find(p => p.id === myId);
  if (me) {
    const wname = WEAPON_NAMES[me.weapon] || 'Basic Laser';
    if (myWeapon !== me.weapon) {
      myWeapon = me.weapon;
      document.getElementById('weapon-name').textContent = wname;
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
    roster.innerHTML = '';
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
  } else {
    roster.style.display = 'none';
  }

  // ── Host controls / waiting msg ──
  const hostControls = document.getElementById('host-controls');
  const visRow = document.getElementById('visibility-row');
  const waitingMsg = document.getElementById('lobby-waiting-msg');
  const addTeamBtn = document.getElementById('add-team-btn');
  const startBtn = document.getElementById('start-btn');
  if (isHost) {
    hostControls.style.display = '';
    visRow.style.display = '';
    waitingMsg.style.display = 'none';
    document.getElementById('mode-select').value = gameMode;
    addTeamBtn.style.display = gameMode === 'teams' ? '' : 'none';
    document.getElementById('rock-density').value = rockDensity;
    document.getElementById('rock-density-val').textContent = rockDensity + '%';
    document.getElementById('tree-density').value = treeDensity;
    document.getElementById('tree-density-val').textContent = treeDensity + '%';
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
  sendWS({ type: 'setup', mode, teams, rockDensity: rockDensity / 100, treeDensity: treeDensity / 100, isPublic: gameIsPublic, password: gamePassword });
}

// ─── Browse Screen ────────────────────────────────────────────────────────
function showBrowseScreen() {
  showScreen('browse');
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
  mapCanvas.width = 800; mapCanvas.height = 576;
  mapCtx = mapCanvas.getContext('2d');

  treeCanvas = document.createElement('canvas');
  treeCanvas.width = 800; treeCanvas.height = 576;
  treeCtx = treeCanvas.getContext('2d');

  document.getElementById('end-game-btn-wrap').style.display = isHost ? '' : 'none';
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
    mapCtx.fillRect(0, 0, 800, 576);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const t = tiles[r * cols + c];
        const x = c * TILE_SIZE, y = r * TILE_SIZE;
        if (t === TILE_ROCK) {
          mapCtx.fillStyle = '#555566';
          mapCtx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
          mapCtx.fillStyle = '#44445555';
          mapCtx.fillRect(x+2, y+2, TILE_SIZE-4, TILE_SIZE-4);
        } else {
          mapCtx.fillStyle = (c + r) % 2 === 0 ? '#2d4a1e' : '#2a451c';
          mapCtx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
        }
      }
    }
    treeCtx.clearRect(0, 0, 800, 576);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (tiles[r * cols + c] !== TILE_TREE) continue;
        const x = c * TILE_SIZE + TILE_SIZE / 2;
        const y = r * TILE_SIZE + TILE_SIZE / 2;
        treeCtx.beginPath();
        treeCtx.arc(x, y, 28, 0, Math.PI * 2);
        treeCtx.fillStyle = '#1a5c20';
        treeCtx.fill();
        treeCtx.beginPath();
        treeCtx.arc(x - 6, y - 6, 20, 0, Math.PI * 2);
        treeCtx.fillStyle = '#226b28';
        treeCtx.fill();
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
    ctx.beginPath();
    ctx.arc(pu.x, pu.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = color + '33';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pu.x, pu.y, 12, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(POWERUP_LETTERS[pu.type] || '?', pu.x, pu.y);
  }

  // Tanks
  for (const p of renderPlayers) {
    if (!p.alive) continue;
    const isMe = p.id === myId;
    if (p.cloaked && !isMe) continue;
    if (p.spawnProtected && Math.floor(now / 250) % 2 === 0) continue;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = p.cloaked ? 0.4 : 1.0;
    const color = playerColor(p);

    if (p.armored) {
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.strokeStyle = '#40ff80';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.fillRect(-13, -13, 26, 26);
    ctx.fillStyle = '#cccccc';
    const blen = 18;
    if (p.dir === 'N') ctx.fillRect(-3, -blen, 6, blen);
    else if (p.dir === 'S') ctx.fillRect(-3, 0, 6, blen);
    else if (p.dir === 'E') ctx.fillRect(0, -3, blen, 6);
    else if (p.dir === 'W') ctx.fillRect(-blen, -3, blen, 6);
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = isMe ? '#ffffff' : '#cccccc';
    ctx.font = isMe ? 'bold 11px sans-serif' : '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(p.name || '', 0, -15);
    ctx.restore();
  }

  // Projectiles
  for (const pr of renderProjectiles) {
    ctx.fillStyle = pr.weapon === 'rocket' ? '#ff8040' : '#ffff80';
    const half = pr.size / 2;
    ctx.fillRect(pr.x - half, pr.y - half, pr.size, pr.size);
  }

  // Trees on top
  ctx.drawImage(treeCanvas, 0, 0);

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
function showEndedScreen(scores) {
  const container = document.getElementById('final-scores');
  container.innerHTML = '';

  if (!scores || scores.length === 0) {
    container.textContent = 'No scores recorded.';
    return;
  }

  if (mode === 'ffa') {
    for (let i = 0; i < scores.length; i++) {
      const s = scores[i];
      const row = document.createElement('div');
      row.className = 'score-row';
      row.innerHTML = `
        <span class="score-rank">${i + 1}.</span>
        <span class="score-name">${escHtml(s.name)}</span>
        <span class="score-pts">${s.score} pts</span>`;
      container.appendChild(row);
    }
  } else {
    for (let ti = 0; ti < scores.length; ti++) {
      const team = scores[ti];
      const header = document.createElement('div');
      header.className = 'score-team-header';
      const dot = document.createElement('span');
      dot.className = 'score-team-dot';
      dot.style.background = (teams[team.index] || {}).color || '#888';
      header.appendChild(dot);
      header.appendChild(document.createTextNode(`${team.name} — Rank ${ti + 1}`));
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
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Event Listeners ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Home screen
  const nameInput = document.getElementById('name-input');
  const gameIdInput = document.getElementById('game-id-input');

  // Pre-fill game ID from URL
  const urlParams = new URLSearchParams(location.search);
  const urlGameId = urlParams.get('game');
  if (urlGameId) gameIdInput.value = urlGameId;

  document.getElementById('create-btn').addEventListener('click', () => {
    myName = nameInput.value.trim();
    if (!myName) { showError('Please enter your name'); return; }
    connectWS(() => sendWS({ type: 'join', name: myName }));
  });

  document.getElementById('join-btn').addEventListener('click', () => {
    myName = nameInput.value.trim();
    const gid = gameIdInput.value.trim().toUpperCase();
    if (!myName) { showError('Please enter your name'); return; }
    if (!gid) { showError('Please enter a game ID'); return; }
    connectWS(() => sendWS({ type: 'join', name: myName, gameId: gid }));
  });

  document.getElementById('browse-btn').addEventListener('click', () => {
    myName = nameInput.value.trim();
    if (!myName) { showError('Please enter your name first'); return; }
    showBrowseScreen();
  });

  document.getElementById('back-to-home-btn').addEventListener('click', hideBrowseScreen);
  document.getElementById('refresh-games-btn').addEventListener('click', () => {
    if (wsOpen) sendWS({ type: 'list_games' });
  });

  // If URL has game ID, auto-select join flow
  if (urlGameId) {
    document.getElementById('game-id-input').focus();
  } else {
    nameInput.focus();
  }

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
    document.getElementById('add-team-btn').style.display = mode === 'teams' ? '' : 'none';
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

  document.getElementById('add-team-btn').addEventListener('click', () => {
    const colors = ['#e94560','#4080ff','#40c080','#ffd040','#c080ff','#ff8040'];
    if (teams.length >= 4) return;
    teams.push({ name: `Team ${teams.length + 1}`, color: colors[teams.length % colors.length] });
    sendSetup();
  });

  document.getElementById('start-btn').addEventListener('click', () => {
    sendWS({ type: 'start_game' });
  });

  // Game
  document.getElementById('end-game-btn').addEventListener('click', () => {
    if (confirm('End the game?')) sendWS({ type: 'end_game' });
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

  // Ping keepalive
  setInterval(() => {
    if (wsOpen) sendWS({ type: 'ping' });
  }, 30000);
});
