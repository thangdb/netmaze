'use strict';
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { randomUUID } = require('crypto');

// ─── WebRTC (optional — node-datachannel) ────────────────────────────────
let RTCPeerConnection = null;
try {
  ({ RTCPeerConnection } = require('node-datachannel/polyfill'));
  console.log('WebRTC enabled via node-datachannel');
} catch { console.log('node-datachannel not available — WebSocket only'); }

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ...(process.env.TURN_URL ? [{
    urls: process.env.TURN_URL,
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  }] : []),
];

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  TILE_SIZE: 32, MAP_COLS: 31, MAP_ROWS: 23,
  TICK_MS: 50,
  TANK_SPEED: 120,
  TANK_SIZE: 30, TANK_HALF: 15,
  LASER_SPEED: 300, ROCKET_SPEED: 600,
  LASER_COOLDOWN: 300, TRIPLE_COOLDOWN: 400, ROCKET_COOLDOWN: 500,
  RESPAWN_DELAY: 3000, SPAWN_PROTECTION: 2000,
  ARMOR_DURATION: 15000, CLOAK_DURATION: 15000,
  POWERUP_INTERVAL: 10000, POWERUP_LIFETIME: 20000, MAX_POWERUPS: 5,
  ROCK_DENSITY: 0.02, TREE_DENSITY: 0.02,
  PORT: process.env.PORT || 3001,
};

const TILE_BLANK = 0, TILE_ROCK = 1, TILE_TREE = 2;

// ─── GLOBAL STATE ──────────────────────────────────────────────────────────
const games = new Map(); // gameId → GameState
const wsToPlayer = new Map(); // ws → {gameId, playerId}

// ─── MAP GENERATION ────────────────────────────────────────────────────────
function generateMap(rockDensity = CONFIG.ROCK_DENSITY, treeDensity = CONFIG.TREE_DENSITY) {
  const { MAP_COLS: cols, MAP_ROWS: rows } = CONFIG;
  const tiles = new Uint8Array(cols * rows);

  // Corner spawn zones (3×3 at each corner) — always blank
  const spawnZones = [
    [0, 0], [cols - 3, 0], [0, rows - 3], [cols - 3, rows - 3],
  ];
  const isSpawn = (c, r) => spawnZones.some(([sc, sr]) => c >= sc && c < sc + 3 && r >= sr && r < sr + 3);

  // Place rocks
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isSpawn(c, r) && Math.random() < rockDensity) {
        tiles[r * cols + c] = TILE_ROCK;
      }
    }
  }

  // Ensure all blank tiles form one connected region.
  // Start flood-fill from (1,1) — always blank (top-left spawn zone).
  const DIRS4 = [[1,0],[-1,0],[0,1],[0,-1]];
  const flood = (sc, sr) => {
    const vis = new Uint8Array(cols * rows);
    vis[sr * cols + sc] = 1;
    const q = [sr * cols + sc];
    while (q.length) {
      const idx = q.pop();
      const c = idx % cols, r = (idx / cols) | 0;
      for (const [dc, dr] of DIRS4) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (!vis[ni] && tiles[ni] !== TILE_ROCK) { vis[ni] = 1; q.push(ni); }
      }
    }
    return vis;
  };

  let vis = flood(1, 1);
  for (;;) {
    // Find any blank tile not yet reachable from main region
    let isolated = -1;
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] !== TILE_ROCK && !vis[i]) { isolated = i; break; }
    }
    if (isolated < 0) break; // all blank tiles connected

    // BFS through ALL tiles (rocks included) to find shortest path to main region
    const prev = new Int32Array(tiles.length).fill(-1);
    const seen = new Uint8Array(tiles.length);
    seen[isolated] = 1;
    const q = [isolated];
    let target = -1;
    outer: while (q.length) {
      const cur = q.shift();
      const c = cur % cols, r = (cur / cols) | 0;
      for (const [dc, dr] of DIRS4) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (seen[ni]) continue;
        seen[ni] = 1;
        prev[ni] = cur;
        if (vis[ni]) { target = ni; break outer; }
        q.push(ni);
      }
    }
    if (target < 0) break; // unreachable (shouldn't happen on a finite grid)

    // Carve: trace path back from target to isolated cell, removing rocks
    let cur = target;
    while (prev[cur] !== -1) {
      cur = prev[cur];
      if (tiles[cur] === TILE_ROCK) tiles[cur] = TILE_BLANK;
    }

    vis = flood(1, 1); // re-flood: newly carved path may connect more regions
  }

  // Place trees on non-spawn blank tiles
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (tiles[idx] === TILE_BLANK && !isSpawn(c, r) && Math.random() < treeDensity) {
        tiles[idx] = TILE_TREE;
      }
    }
  }

  return { tiles, cols, rows };
}

// ─── SPAWN POINTS ──────────────────────────────────────────────────────────
function getRandomSpawnPoint(map, avoid = []) {
  const { MAP_COLS: cols, MAP_ROWS: rows, TILE_SIZE, TANK_HALF } = CONFIG;
  const minDist = TANK_HALF * 6; // keep spawns well apart
  for (let attempt = 0; attempt < 300; attempt++) {
    const c = Math.floor(Math.random() * cols);
    const r = Math.floor(Math.random() * rows);
    if (map.tiles[r * cols + c] !== TILE_BLANK) continue;
    const x = c * TILE_SIZE + TILE_SIZE / 2;
    const y = r * TILE_SIZE + TILE_SIZE / 2;
    if (avoid.some(p => Math.abs(p.x - x) < minDist && Math.abs(p.y - y) < minDist)) continue;
    return { x, y };
  }
  // Fallback: any blank tile
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (map.tiles[r * cols + c] === TILE_BLANK)
        return { x: c * TILE_SIZE + TILE_SIZE / 2, y: r * TILE_SIZE + TILE_SIZE / 2 };
    }
  }
  return { x: TILE_SIZE * 1.5, y: TILE_SIZE * 1.5 };
}

// ─── COLLISION DETECTION ───────────────────────────────────────────────────
function collidesWithWall(map, x, y) {
  const { TILE_HALF: _, TANK_HALF, TILE_SIZE, MAP_COLS: cols, MAP_ROWS: rows } = CONFIG;
  const half = TANK_HALF - 2; // 2px inset so tanks fit through 1-tile gaps (32px tile, 30px tank → 4px clearance)
  const corners = [
    [x - half, y - half],
    [x + half, y - half],
    [x - half, y + half],
    [x + half, y + half],
  ];
  for (const [cx, cy] of corners) {
    const tc = Math.floor(cx / TILE_SIZE);
    const tr = Math.floor(cy / TILE_SIZE);
    if (tc < 0 || tc >= cols || tr < 0 || tr >= rows) return true;
    if (map.tiles[tr * cols + tc] === TILE_ROCK) return true;
  }
  return false;
}

// ─── WEAPONS HELPERS ──────────────────────────────────────────────────────
function weaponCooldown(weapon) {
  if (weapon === 'triple_laser') return CONFIG.TRIPLE_COOLDOWN;
  if (weapon === 'rocket') return CONFIG.ROCKET_COOLDOWN;
  return CONFIG.LASER_COOLDOWN;
}

function weaponSpeed(weapon) {
  return weapon === 'rocket' ? CONFIG.ROCKET_SPEED : CONFIG.LASER_SPEED;
}

function weaponSize(weapon) {
  return weapon === 'rocket' ? 14 : 4;
}

// ─── GAME LOGIC ────────────────────────────────────────────────────────────
function movePlayer(game, player, dt) {
  if (!player.alive) return;
  const { TANK_SPEED } = CONFIG;
  const speed = TANK_SPEED * dt;
  let dx = 0, dy = 0;
  if (player.dir === 'N') dy = -speed;
  else if (player.dir === 'S') dy = speed;
  else if (player.dir === 'E') dx = speed;
  else if (player.dir === 'W') dx = -speed;

  const nx = player.x + dx, ny = player.y + dy;
  if (!collidesWithWall(game.map, nx, ny)) {
    player.x = nx;
    player.y = ny;
  }
}

function fireWeapon(game, player) {
  const now = Date.now();

  // All weapons: can only fire once own active projectiles are gone
  const hasActive = game.projectiles.some(p => p.ownerId === player.id);
  if (hasActive) return;
  player.lastFiredAt = now;

  const speed = weaponSpeed(player.weapon);
  const size = weaponSize(player.weapon);
  const { TILE_SIZE } = CONFIG;
  let dirVecs = [];
  if (player.dir === 'N') dirVecs = [[0, -speed]];
  else if (player.dir === 'S') dirVecs = [[0, speed]];
  else if (player.dir === 'E') dirVecs = [[speed, 0]];
  else if (player.dir === 'W') dirVecs = [[-speed, 0]];

  // Triple laser: 3 parallel projectiles across tank width
  let offsets = [0];
  if (player.weapon === 'triple_laser') offsets = [-10, 0, 10];

  for (const offset of offsets) {
    let startX = player.x, startY = player.y;
    const [dvx, dvy] = dirVecs[0];
    if (player.dir === 'N' || player.dir === 'S') startX += offset;
    else startY += offset;

    game.projectiles.push({
      id: game.nextProjectileId++,
      ownerId: player.id,
      ownerTeamIndex: player.teamIndex,
      x: startX,
      y: startY,
      dx: dvx,
      dy: dvy,
      weapon: player.weapon,
      size,
    });
  }
}

function moveProjectiles(game, dt) {
  const { MAP_COLS: cols, MAP_ROWS: rows, TILE_SIZE, TANK_HALF } = CONFIG;
  const tiles = game.map.tiles;
  const now = Date.now();
  const surviving = [];

  for (const proj of game.projectiles) {
    const totalDx = proj.dx * dt;
    const totalDy = proj.dy * dt;
    const dist = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
    // Step in increments no larger than half a tile to prevent skipping
    const stepSize = TILE_SIZE * 0.45;
    const steps = Math.max(1, Math.ceil(dist / stepSize));
    const sx = totalDx / steps;
    const sy = totalDy / steps;

    let removed = false;
    for (let i = 0; i < steps; i++) {
      proj.x += sx;
      proj.y += sy;

      const tc = Math.floor(proj.x / TILE_SIZE);
      const tr = Math.floor(proj.y / TILE_SIZE);
      // Out of bounds or hit rock
      if (tc < 0 || tc >= cols || tr < 0 || tr >= rows ||
          tiles[tr * cols + tc] === TILE_ROCK) {
        removed = true;
        break;
      }

      // Check player hits at each sub-step
      const projHalf = proj.size / 2;
      for (const [, player] of game.players) {
        if (!player.alive) continue;
        if (player.id === proj.ownerId) continue;
        if (game.mode === 'teams' && proj.ownerTeamIndex === player.teamIndex) continue;
        if (player.spawnProtectionUntil > now || player.armorUntil > now) continue;

        if (Math.abs(proj.x - player.x) < projHalf + TANK_HALF &&
            Math.abs(proj.y - player.y) < projHalf + TANK_HALF) {
          killPlayer(game, proj.ownerId, player);
          removed = true;
          break;
        }
      }
      if (removed) break;
    }

    if (!removed) surviving.push(proj);
  }
  game.projectiles = surviving;
}

function killPlayer(game, killerId, victim) {
  victim.alive = false;
  victim.weapon = 'laser';

  // Award score to killer
  const killer = game.players.get(killerId);
  if (killer) {
    killer.score++;
    const ats = game.allTimeScores.get(killerId);
    if (ats) ats.score = killer.score;
  }

  // Track death on victim
  victim.deaths++;
  const victimAts = game.allTimeScores.get(victim.id);
  if (victimAts) victimAts.deaths = victim.deaths;

  // Broadcast kill event
  const killerName = killer ? killer.name : 'Unknown';
  broadcast(game, { type: 'kill', killerId, victimId: victim.id, killerName, victimName: victim.name });

  // Schedule respawn
  victim.respawnTimer = setTimeout(() => {
    if (game.phase !== 'playing') return;
    respawnPlayer(game, victim);
  }, CONFIG.RESPAWN_DELAY);
}

function respawnPlayer(game, player) {
  const spawn = getRandomSpawnPoint(game.map);
  player.x = spawn.x;
  player.y = spawn.y;
  player.alive = true;
  player.weapon = 'laser';
  player.lastFiredAt = 0;
  player.moving = false;
  player.spawnProtectionUntil = Date.now() + CONFIG.SPAWN_PROTECTION;
  player.cloakUntil = 0;
  player.armorUntil = 0;
}

function spawnPowerup(game) {
  if (game.powerups.length >= CONFIG.MAX_POWERUPS) return;
  const { MAP_COLS: cols, MAP_ROWS: rows, TILE_SIZE } = CONFIG;
  const types = ['triple_laser', 'rocket', 'full_armor', 'cloak'];
  const type = types[Math.floor(Math.random() * types.length)];

  // Find random blank tile
  let attempts = 0;
  while (attempts < 100) {
    const c = Math.floor(Math.random() * cols);
    const r = Math.floor(Math.random() * rows);
    const idx = r * cols + c;
    if (game.map.tiles[idx] !== TILE_BLANK) { attempts++; continue; }

    const x = c * TILE_SIZE + TILE_SIZE / 2;
    const y = r * TILE_SIZE + TILE_SIZE / 2;
    // No overlap with existing powerups
    if (game.powerups.some(p => Math.abs(p.x - x) < TILE_SIZE && Math.abs(p.y - y) < TILE_SIZE)) {
      attempts++;
      continue;
    }

    game.powerups.push({
      id: game.nextPowerupId++,
      type, x, y,
      expiresAt: Date.now() + CONFIG.POWERUP_LIFETIME,
    });
    return;
  }
}

function checkPowerupPickups(game) {
  const now = Date.now();
  const { TANK_HALF, TILE_SIZE } = CONFIG;
  const remaining = [];
  for (const pu of game.powerups) {
    if (pu.expiresAt < now) continue; // expired
    let pickedUp = false;
    for (const [, player] of game.players) {
      if (!player.alive) continue;
      if (Math.abs(pu.x - player.x) < TANK_HALF + TILE_SIZE / 2 &&
          Math.abs(pu.y - player.y) < TANK_HALF + TILE_SIZE / 2) {
        // Apply powerup
        if (pu.type === 'triple_laser' || pu.type === 'rocket') {
          player.weapon = pu.type;
        } else if (pu.type === 'full_armor') {
          player.armorUntil = now + CONFIG.ARMOR_DURATION;
        } else if (pu.type === 'cloak') {
          player.cloakUntil = now + CONFIG.CLOAK_DURATION;
        }
        pickedUp = true;
        break;
      }
    }
    if (!pickedUp) remaining.push(pu);
  }
  game.powerups = remaining;
}

function buildSnapshot(game, forPlayer) {
  const now = Date.now();
  const players = [];
  for (const [, p] of game.players) {
    const isSelf = p.id === forPlayer.id;
    const isCloaked = p.cloakUntil > now;
    // Hide cloaked enemies
    if (isCloaked && !isSelf && (game.mode === 'ffa' || p.teamIndex !== forPlayer.teamIndex)) {
      continue;
    }
    players.push({
      id: p.id,
      name: p.name,
      teamIndex: p.teamIndex,
      alive: p.alive,
      x: p.x,
      y: p.y,
      dir: p.dir,
      weapon: p.weapon,
      score: p.score,
      spawnProtected: p.spawnProtectionUntil > now,
      armored: p.armorUntil > now,
      cloaked: isCloaked && isSelf, // tell self they're cloaked
      connected: p.connected,
    });
  }

  return {
    type: 'state',
    players,
    endType: game.endType,
    scoreLimit: game.endType === 'score' ? game.scoreLimit : null,
    timeLeft: game.endType === 'time' ? Math.max(0, game.startedAt + game.timeLimitMs - Date.now()) : null,
    projectiles: game.projectiles.map(pr => ({
      id: pr.id, x: pr.x, y: pr.y, dx: pr.dx, dy: pr.dy, weapon: pr.weapon, size: pr.size,
    })),
    powerups: game.powerups.map(pu => ({
      id: pu.id, type: pu.type, x: pu.x, y: pu.y,
    })),
    scores: buildScores(game),
  };
}

function buildScores(game) {
  // Use allTimeScores so disconnected players are still included
  const source = game.allTimeScores && game.allTimeScores.size > 0
    ? game.allTimeScores
    : new Map([...game.players.entries()].map(([id, p]) => [id, { name: p.name, score: p.score, teamIndex: p.teamIndex }]));

  if (game.mode === 'ffa') {
    const list = [];
    for (const [id, s] of source) list.push({ id, name: s.name, score: s.score, deaths: s.deaths || 0 });
    return list.sort((a, b) => b.score - a.score);
  }
  // Teams mode
  const teamTotals = game.teams.map((t, i) => ({ ...t, index: i, total: 0, players: [] }));
  for (const [id, s] of source) {
    if (s.teamIndex >= 0 && s.teamIndex < teamTotals.length) {
      teamTotals[s.teamIndex].total += s.score;
      teamTotals[s.teamIndex].players.push({ id, name: s.name, score: s.score, deaths: s.deaths || 0 });
    }
  }
  teamTotals.sort((a, b) => b.total - a.total);
  return teamTotals;
}

// ─── GAME TICK ────────────────────────────────────────────────────────────
function checkEndCondition(game) {
  if (game.endType === 'time') {
    if (Date.now() >= game.startedAt + game.timeLimitMs) {
      endGame(game, 'time_limit'); return true;
    }
  } else if (game.endType === 'score') {
    if (game.mode === 'ffa') {
      for (const [, p] of game.players) {
        if (p.score >= game.scoreLimit) { endGame(game, 'score_limit'); return true; }
      }
    } else {
      const teamTotals = new Map();
      for (const [, p] of game.players) {
        if (p.teamIndex >= 0) teamTotals.set(p.teamIndex, (teamTotals.get(p.teamIndex) || 0) + p.score);
      }
      for (const [, total] of teamTotals) {
        if (total >= game.scoreLimit) { endGame(game, 'score_limit'); return true; }
      }
    }
  }
  return false;
}

function gameTick(game) {
  if (game.phase !== 'playing') return;
  const dt = CONFIG.TICK_MS / 1000;

  for (const [, player] of game.players) {
    if (player.connected && player.alive && player.moving) {
      movePlayer(game, player, dt);
    }
  }

  moveProjectiles(game, dt);
  checkPowerupPickups(game);
  if (checkEndCondition(game)) return;

  for (const [, player] of game.players) {
    if (player.connected) {
      send(player, buildSnapshot(game, player));
    }
  }
}

// ─── WEBSOCKET HANDLERS ────────────────────────────────────────────────────
function handleJoin(ws, payload) {
  const { name, gameId } = payload;
  const trimmedName = (typeof name === 'string' ? name.trim() : '');
  if (trimmedName.length < 4 || trimmedName.length > 15 || !/^[\x20-\x7E]+$/.test(trimmedName)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Name must be 4–15 ASCII characters' }));
    return;
  }

  if (gameId) {
    // Join existing game
    const game = games.get(gameId);
    if (!game) {
      ws.send(JSON.stringify({ type: 'error', message: 'Game not found' }));
      return;
    }
    if (game.phase === 'ended') {
      ws.send(JSON.stringify({ type: 'error', message: 'Game has ended' }));
      return;
    }

    // Check for reconnect by name (reconnects bypass password)
    let existingPlayer = null;
    for (const [, p] of game.players) {
      if (p.name === trimmedName) { existingPlayer = p; break; }
    }

    if (!existingPlayer && game.password) {
      // New join — check password
      if (!payload.password) {
        ws.send(JSON.stringify({ type: 'password_required', gameId }));
        return;
      }
      if (payload.password !== game.password) {
        ws.send(JSON.stringify({ type: 'error', message: 'Incorrect password' }));
        return;
      }
    }

    if (existingPlayer) {
      // Reconnect
      if (existingPlayer.disconnectTimer) {
        clearTimeout(existingPlayer.disconnectTimer);
        existingPlayer.disconnectTimer = null;
      }
      wsToPlayer.set(ws, { gameId, playerId: existingPlayer.id });
      existingPlayer.ws = ws;
      existingPlayer.connected = true;
      ws.send(JSON.stringify({ type: 'game_joined', gameId, playerId: existingPlayer.id }));

      if (game.phase === 'playing') {
        // Send sync state
        ws.send(JSON.stringify({
          type: 'sync_state',
          phase: game.phase,
          map: { tiles: Array.from(game.map.tiles), cols: game.map.cols, rows: game.map.rows },
          theme: game.theme,
          snapshot: buildSnapshot(game, existingPlayer),
        }));
      } else {
        broadcastLobbyUpdate(game);
      }
      return;
    }

    if (game.phase === 'playing' && game.allowLateJoin) {
      // Late-join: spawn into running game
      const playerId = randomUUID();
      const player = createPlayer(playerId, ws, trimmedName);
      if (game.mode === 'teams') {
        const teamCounts = game.teams.map((_, i) =>
          [...game.players.values()].filter(p => p.connected && p.teamIndex === i).length);
        const min = Math.min(...teamCounts);
        const candidates = teamCounts.reduce((a, n, i) => n === min ? [...a, i] : a, []);
        player.teamIndex = candidates[Math.floor(Math.random() * candidates.length)];
      }
      const alivePos = [...game.players.values()].filter(p => p.alive).map(p => ({ x: p.x, y: p.y }));
      const spawn = getRandomSpawnPoint(game.map, alivePos);
      player.x = spawn.x; player.y = spawn.y;
      player.alive = true;
      player.spawnProtectionUntil = Date.now() + CONFIG.SPAWN_PROTECTION;
      game.players.set(playerId, player);
      game.allTimeScores.set(playerId, { name: trimmedName, score: 0, deaths: 0, teamIndex: player.teamIndex });
      wsToPlayer.set(ws, { gameId, playerId });
      ws.send(JSON.stringify({ type: 'game_joined', gameId, playerId }));
      ws.send(JSON.stringify({
        type: 'sync_state', phase: 'playing',
        map: { tiles: Array.from(game.map.tiles), cols: game.map.cols, rows: game.map.rows },
        theme: game.theme,
        snapshot: buildSnapshot(game, player),
      }));
      return;
    }

    if (game.phase !== 'lobby') {
      ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress' }));
      return;
    }

    const playerId = randomUUID();
    const player = createPlayer(playerId, ws, trimmedName);
    game.players.set(playerId, player);
    wsToPlayer.set(ws, { gameId, playerId });
    ws.send(JSON.stringify({ type: 'game_joined', gameId, playerId }));
    broadcastLobbyUpdate(game);
  } else {
    // Create new game
    const newGameId = randomUUID().slice(0, 8).toUpperCase();
    const playerId = randomUUID();
    const player = createPlayer(playerId, ws, trimmedName);
    player.isHost = true;

    const game = {
      id: newGameId,
      phase: 'lobby',
      hostId: playerId,
      mode: 'ffa',
      teams: [
        { name: 'Red', color: '#e94560' },
        { name: 'Blue', color: '#4080ff' },
      ],
      players: new Map([[playerId, player]]),
      map: null,
      projectiles: [],
      powerups: [],
      tickInterval: null,
      powerupTimer: null,
      nextProjectileId: 1,
      nextPowerupId: 1,
      allowLateJoin: true,
      rockDensity: CONFIG.ROCK_DENSITY,
      treeDensity: CONFIG.TREE_DENSITY,
      theme: 'forest',
      isPublic: true,
      password: '',
      endType: 'time', // 'unlimited' | 'time' | 'score'
      timeLimitMs: 10 * 60 * 1000,
      scoreLimit: 30,
      startedAt: null,
      allTimeScores: new Map(), // playerId → {name, score, teamIndex}
    };

    games.set(newGameId, game);
    wsToPlayer.set(ws, { gameId: newGameId, playerId });
    ws.send(JSON.stringify({ type: 'game_created', gameId: newGameId, playerId }));
    broadcastLobbyUpdate(game);
  }
}

function createPlayer(id, ws, name) {
  return {
    id, ws, name,
    teamIndex: -1,
    connected: true,
    alive: false,
    x: 0, y: 0,
    dir: 'E',
    moving: false,
    weapon: 'laser',
    lastFiredAt: 0,
    spawnProtectionUntil: 0,
    cloakUntil: 0,
    armorUntil: 0,
    score: 0,
    deaths: 0,
    respawnTimer: null,
    disconnectTimer: null,
    isHost: false,
    rtcPeer: null,
    rtcChannel: null,
  };
}

async function handleRtcOffer(ws, game, player, payload) {
  if (!RTCPeerConnection) return;
  try {
    if (player.rtcPeer) {
      try { player.rtcPeer.close(); } catch {}
      player.rtcPeer = null;
      player.rtcChannel = null;
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    player.rtcPeer = pc;
    pc.ondatachannel = ({ channel }) => {
      channel.onopen = () => { player.rtcChannel = channel; };
      channel.onclose = channel.onerror = () => {
        if (player.rtcChannel === channel) player.rtcChannel = null;
      };
      channel.onmessage = ({ data }) => {
        let msg; try { msg = JSON.parse(data); } catch { return; }
        if (msg.type === 'input') handleInput(player.ws, game, player, msg);
      };
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send(player, { type: 'rtc_ice', candidate });
    };
    await pc.setRemoteDescription(payload.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send(player, { type: 'rtc_answer', answer: pc.localDescription });
  } catch (e) {
    console.error('rtc_offer error:', e.message);
  }
}

function handleRtcIce(ws, game, player, payload) {
  if (player.rtcPeer && payload.candidate) {
    player.rtcPeer.addIceCandidate(payload.candidate).catch(() => {});
  }
}

function handleSetup(ws, game, player, payload) {
  if (player.id !== game.hostId) return;
  if (game.phase !== 'lobby') return;
  if (payload.mode) game.mode = payload.mode;
  if (payload.teams) game.teams = payload.teams;
  if (typeof payload.rockDensity === 'number') game.rockDensity = Math.max(0, Math.min(0.10, payload.rockDensity));
  if (typeof payload.treeDensity === 'number') game.treeDensity = Math.max(0, Math.min(0.20, payload.treeDensity));
  const VALID_THEMES = ['forest','desert','snow','city','industrial','lava','mario'];
  if (typeof payload.theme === 'string' && VALID_THEMES.includes(payload.theme)) game.theme = payload.theme;
  if (typeof payload.isPublic === 'boolean') game.isPublic = payload.isPublic;
  if (typeof payload.password === 'string') game.password = payload.password.slice(0, 30);
  if (['unlimited','time','score'].includes(payload.endType)) game.endType = payload.endType;
  if (typeof payload.timeLimitMs === 'number') game.timeLimitMs = Math.max(60000, Math.min(3600000, payload.timeLimitMs));
  if (typeof payload.scoreLimit === 'number') game.scoreLimit = Math.max(1, Math.min(9999, Math.round(payload.scoreLimit)));
  broadcastLobbyUpdate(game);
}

function handleStartGame(ws, game, player) {
  if (player.id !== game.hostId) return;
  if (game.phase !== 'lobby') return;

  if (game.mode === 'teams') {
    const connectedPlayers = [...game.players.values()].filter(p => p.connected);
    const populatedTeams = game.teams.filter((_, i) => connectedPlayers.some(p => p.teamIndex === i));
    if (populatedTeams.length < 2) {
      send(player, { type: 'error', message: 'Need at least 2 teams with 1 player each to start' });
      return;
    }
  } else {
    if (game.players.size < 1) return;
  }

  game.phase = 'playing';
  game.map = generateMap(game.rockDensity, game.treeDensity);
  game.startedAt = Date.now();
  game.allTimeScores = new Map();

  // For score mode with teams, default scoreLimit = 10 × largest team size
  if (game.endType === 'score' && game.mode === 'teams') {
    const connected = [...game.players.values()].filter(p => p.connected);
    const teamSizes = game.teams.map((_, i) => connected.filter(p => p.teamIndex === i).length);
    const maxTeam = Math.max(...teamSizes, 1);
    if (game.scoreLimit === 30) game.scoreLimit = 10 * maxTeam; // only override default
  }

  let idx = 0;
  const usedSpawns = [];
  for (const [, p] of game.players) {
    if (!p.connected) continue;
    const spawn = getRandomSpawnPoint(game.map, usedSpawns);
    usedSpawns.push(spawn);
    p.x = spawn.x;
    p.y = spawn.y;
    p.alive = true;
    p.moving = false;
    p.weapon = 'laser';
    p.score = 0;
    p.deaths = 0;
    p.lastFiredAt = 0;
    p.spawnProtectionUntil = Date.now() + CONFIG.SPAWN_PROTECTION;
    p.cloakUntil = 0;
    p.armorUntil = 0;
    p.dir = 'E';
    if (game.mode === 'teams') {
      // Use player's chosen team; if unassigned, auto-assign to smallest team
      if (p.teamIndex < 0 || p.teamIndex >= game.teams.length) {
        const counts = game.teams.map((_, ti) =>
          [...game.players.values()].filter(pl => pl.teamIndex === ti).length);
        p.teamIndex = counts.indexOf(Math.min(...counts));
      }
    } else {
      p.teamIndex = -1;
    }
    game.allTimeScores.set(p.id, { name: p.name, score: 0, deaths: 0, teamIndex: p.teamIndex });
  }

  const mapPayload = { tiles: Array.from(game.map.tiles), cols: game.map.cols, rows: game.map.rows };
  const playerList = [...game.players.values()].filter(p => p.connected).map(p => ({
    id: p.id, name: p.name, teamIndex: p.teamIndex, x: p.x, y: p.y, dir: p.dir,
    weapon: p.weapon, score: p.score, alive: p.alive,
  }));

  broadcast(game, { type: 'game_start', map: mapPayload, players: playerList, theme: game.theme });

  game.tickInterval = setInterval(() => gameTick(game), CONFIG.TICK_MS);
  game.powerupTimer = setInterval(() => spawnPowerup(game), CONFIG.POWERUP_INTERVAL);
}

function handleInput(ws, game, player, payload) {
  if (game.phase !== 'playing') return;
  if (!player.alive) return;
  const { dir, firing, moving } = payload;
  if (dir && ['N', 'S', 'E', 'W'].includes(dir)) player.dir = dir;
  if (typeof moving === 'boolean') player.moving = moving;
  if (firing) fireWeapon(game, player);
}

function handleEndGame(ws, game, player) {
  if (player.id !== game.hostId) return;
  endGame(game, 'host_ended');
}

function endGame(game, reason) {
  game.phase = 'ended';

  if (game.tickInterval) { clearInterval(game.tickInterval); game.tickInterval = null; }
  if (game.powerupTimer) { clearInterval(game.powerupTimer); game.powerupTimer = null; }

  for (const [, p] of game.players) {
    if (p.respawnTimer) { clearTimeout(p.respawnTimer); p.respawnTimer = null; }
    if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
  }

  broadcast(game, { type: 'game_over', reason, scores: buildScores(game) });
}

function handlePlayAgain(ws, game, player) {
  if (player.id !== game.hostId) return;
  if (game.phase !== 'ended') return;

  // Reset game to lobby
  game.phase = 'lobby';
  game.projectiles = [];
  game.powerups = [];
  game.nextProjectileId = 1;
  game.nextPowerupId = 1;
  game.allowLateJoin = true;
  game.map = null;

  for (const [, p] of game.players) {
    p.alive = false;
    p.score = 0;
    p.deaths = 0;
    p.weapon = 'laser';
    p.teamIndex = -1;
  }

  broadcastLobbyUpdate(game);
}

function handleDisconnect(ws) {
  const info = wsToPlayer.get(ws);
  if (!info) return;
  wsToPlayer.delete(ws);

  const { gameId, playerId } = info;
  const game = games.get(gameId);
  if (!game) return;

  const player = game.players.get(playerId);
  if (!player) return;

  player.connected = false;
  player.ws = null;
  if (player.rtcPeer) {
    try { player.rtcPeer.close(); } catch {}
    player.rtcPeer = null;
    player.rtcChannel = null;
  }

  // Transfer host if needed
  if (player.id === game.hostId) {
    for (const [, p] of game.players) {
      if (p.connected && p.id !== player.id) {
        game.hostId = p.id;
        p.isHost = true;
        player.isHost = false;
        break;
      }
    }
  }

  if (game.phase === 'lobby') {
    broadcastLobbyUpdate(game);
  }

  // 30s grace period before forced removal
  player.disconnectTimer = setTimeout(() => {
    game.players.delete(playerId);
    if (game.players.size === 0) {
      games.delete(gameId);
    } else if (game.phase === 'lobby') {
      broadcastLobbyUpdate(game);
    }
  }, 30000);
}


function handleChooseTeam(ws, game, player, payload) {
  if (game.phase !== 'lobby') return;
  const { teamIndex } = payload;
  if (typeof teamIndex !== 'number') return;
  if (teamIndex < 0 || teamIndex >= game.teams.length) return;
  player.teamIndex = teamIndex;
  broadcastLobbyUpdate(game);
}

function handleListGames(ws) {
  const list = [];
  for (const [, game] of games) {
    if (!game.isPublic || game.phase === 'ended') continue;
    const connectedCount = [...game.players.values()].filter(p => p.connected).length;
    if (connectedCount === 0) continue;
    const host = game.players.get(game.hostId);
    list.push({
      gameId: game.id,
      hostName: host ? host.name : 'Unknown',
      playerCount: connectedCount,
      mode: game.mode,
      phase: game.phase,
      hasPassword: !!game.password,
    });
  }
  ws.send(JSON.stringify({ type: 'games_list', games: list }));
}

function handleToggleLateJoin(ws, game, player, payload) {
  if (player.id !== game.hostId) return;
  game.allowLateJoin = !!payload.value;
  broadcast(game, { type: 'late_join_changed', value: game.allowLateJoin });
}

function broadcastLobbyUpdate(game) {
  const players = [...game.players.values()].map(p => ({
    id: p.id, name: p.name, connected: p.connected, teamIndex: p.teamIndex,
  }));
  broadcast(game, {
    type: 'lobby_update',
    players,
    hostId: game.hostId,
    mode: game.mode,
    teams: game.teams,
    allowLateJoin: game.allowLateJoin,
    rockDensity: game.rockDensity,
    treeDensity: game.treeDensity,
    theme: game.theme,
    isPublic: game.isPublic,
    hasPassword: !!game.password,
    endType: game.endType,
    timeLimitMs: game.timeLimitMs,
    scoreLimit: game.scoreLimit,
  });
}

function broadcast(game, msg, filter) {
  const data = JSON.stringify(msg);
  for (const [, player] of game.players) {
    if (filter && !filter(player)) continue;
    if (player.connected && player.ws && player.ws.readyState === 1) {
      player.ws.send(data);
    }
  }
}

function send(player, msg) {
  const data = JSON.stringify(msg);
  if (msg.type === 'state' && player.rtcChannel && player.rtcChannel.readyState === 'open') {
    try { player.rtcChannel.send(data); return; } catch {}
  }
  if (player.ws && player.ws.readyState === 1) player.ws.send(data);
}

// ─── EXPRESS + WS SERVER ──────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, ...payload } = msg;

    if (type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

    const info = wsToPlayer.get(ws);
    if (type === 'join') { handleJoin(ws, payload); return; }
    if (type === 'list_games') { handleListGames(ws); return; }

    if (!info) return;
    const { gameId, playerId } = info;
    const game = games.get(gameId);
    if (!game) return;
    const player = game.players.get(playerId);
    if (!player) return;

    switch (type) {
      case 'setup':             handleSetup(ws, game, player, payload); break;
      case 'start_game':        handleStartGame(ws, game, player); break;
      case 'input':             handleInput(ws, game, player, payload); break;
      case 'end_game':          handleEndGame(ws, game, player); break;
      case 'play_again':        handlePlayAgain(ws, game, player); break;
      case 'choose_team':       handleChooseTeam(ws, game, player, payload); break;
      case 'toggle_late_join':  handleToggleLateJoin(ws, game, player, payload); break;
      case 'rtc_offer':         handleRtcOffer(ws, game, player, payload); break;
      case 'rtc_ice':           handleRtcIce(ws, game, player, payload); break;
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

server.listen(CONFIG.PORT, () => {
  console.log(`Netmaze server running on http://localhost:${CONFIG.PORT}`);
});
