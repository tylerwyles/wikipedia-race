const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e6,
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

const wikiHeaders = { 'User-Agent': 'WikipediaRaceGame/1.0 (educational game; not a bot)' };

async function wikiFetch(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: wikiHeaders, redirect: 'follow' });
      if (res.ok) return res;
      if (i < retries && res.status >= 500) continue;
      return res;
    } catch (e) {
      if (i === retries) throw e;
    }
  }
}

async function getRandomArticle() {
  const res = await wikiFetch('https://en.wikipedia.org/api/rest_v1/page/random/summary');
  const data = await res.json();
  return {
    title: data.title,
    displayTitle: data.displaytitle || data.title,
    description: data.description || data.extract_html?.replace(/<[^>]+>/g, '').slice(0, 120) || '',
  };
}

async function getArticleHtml(title) {
  const res = await wikiFetch(`https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(title)}`);
  if (!res.ok) return null;
  return await res.text();
}

async function getArticleLinks(title) {
  const res = await wikiFetch(
    `https://en.wikipedia.org/api/rest_v1/page/links/${encodeURIComponent(title)}`
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data || []).map((l) => l.title);
}

const HIGHWAYS = [
  'United States','United Kingdom','England','Europe','France','Germany',
  'World War II','English language','Latin','New York City','India','China',
  'London','Wikipedia','Animal','Science','Africa','Australia','Canada','Japan',
];

function calculateScore(clicks, timeMs, won, room, playerNum) {
  const clickScore = Math.max(0, 150000 - clicks * 4000);
  const timeSec = timeMs / 1000;
  const timeScore = Math.max(0, Math.round(200000 - timeSec * 350));
  const winBonus = won ? 100000 : 0;

  let subtotal = clickScore + timeScore + winBonus;

  const otherPlayer = playerNum === 0 ? 1 : 0;
  const deficit = room.matchScores[otherPlayer] - room.matchScores[playerNum];
  let comebackMultiplier = 1.0;
  if (deficit > 0) {
    comebackMultiplier = Math.min(1.8, 1.0 + (deficit / 500000) * 0.8);
  }
  subtotal = Math.round(subtotal * comebackMultiplier);

  let streakBonus = 0;
  const oppStreak = room.roundWins ? room.roundWins[otherPlayer] || 0 : 0;
  if (oppStreak >= 2) {
    streakBonus = Math.min(150000, 50000 * (oppStreak - 1));
  }

  const total = Math.min(1000000, subtotal + streakBonus);

  return {
    clickScore, timeScore, winBonus, comebackMultiplier,
    streakBonus, total, clicks, timeSec: Math.round(timeSec),
  };
}

function computeBadges(gs, room, winnerNum) {
  const badges = [];
  const w = winnerNum;
  const l = w === 0 ? 1 : 0;
  const wClicks = gs.clicks[w];
  const lClicks = gs.clicks[l];
  const elapsed = (Date.now() - gs.startTime) / 1000;

  if (wClicks <= 2) badges.push({ id: 'wormhole', name: 'Wormhole', desc: 'Reached target in 2 or fewer clicks', player: w });
  if (wClicks >= 20) badges.push({ id: 'scenic', name: 'The Scenic Route', desc: 'Won despite 20+ clicks', player: w });
  if (wClicks === 7) badges.push({ id: 'lucky7', name: 'Lucky Number 7', desc: 'Reached target in exactly 7 clicks', player: w });
  if (elapsed < 30) badges.push({ id: 'blitz', name: 'Blitz', desc: 'Finished in under 30 seconds', player: w });
  if (elapsed > 480) badges.push({ id: 'marathon', name: 'Marathon', desc: 'Won a round lasting 8+ minutes', player: w });
  if (Math.abs(wClicks - lClicks) <= 1) badges.push({ id: 'photo', name: 'Photo Finish', desc: 'Click counts within 1 of each other', player: -1 });
  if (wClicks >= 30) badges.push({ id: 'drunk', name: 'The Drunk Walk', desc: 'Visited 30+ articles in one round', player: w });

  const deficit = room.matchScores[l] - room.matchScores[w];
  if (deficit > 100000 && w === winnerNum) {
    badges.push({ id: 'underdog', name: 'Underdog Victory', desc: 'Won while trailing by 100k+ points', player: w });
  }

  const oppStreak = room.roundWins ? room.roundWins[l] || 0 : 0;
  if (oppStreak >= 3) {
    badges.push({ id: 'snapper', name: 'Streak Snapper', desc: 'Broke a 3+ round win streak', player: w });
  }

  const wHistory = gs.history[w];
  const usedHighway = wHistory.some((t) => HIGHWAYS.includes(t.replace(/_/g, ' ')));
  if (!usedHighway && wClicks >= 5) {
    badges.push({ id: 'nohighway', name: 'Highway Avoided', desc: 'Won without using any highway articles', player: w });
  }

  if (wClicks <= 5 && elapsed < 60) badges.push({ id: 'sniper', name: 'Sniper', desc: '5 or fewer clicks in under 60 seconds', player: w });
  if (room.roundNumber === 1 && w === winnerNum) badges.push({ id: 'firstblood', name: 'First Blood', desc: 'Won the first round of the match', player: w });

  return badges;
}

app.get('/api/article', async (req, res) => {
  try {
    const title = req.query.title;
    if (!title) return res.status(400).json({ error: 'Missing title' });

    // First try fetching the article HTML
    let html = await getArticleHtml(title);

    // If not found, check if it's a redirect by fetching the summary
    if (!html) {
      try {
        const summaryRes = await wikiFetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
        );
        if (summaryRes.ok) {
          const summaryData = await summaryRes.json();
          // If the API resolved to a different title (redirect), fetch that instead
          if (summaryData.title && summaryData.title !== title) {
            html = await getArticleHtml(summaryData.title);
            if (html) {
              return res.json({ html, redirectedTo: summaryData.title });
            }
          }
        }
      } catch (_) {
        // Ignore redirect-follow errors, fall through to 404
      }
      return res.status(404).json({ error: 'Article not found' });
    }

    // Check if the article content is too short (blank/stub page)
    const textContent = html.replace(/<[^>]+>/g, '').trim();
    if (textContent.length < 200) {
      return res.json({
        html,
        warning: 'minimal-content',
        message: 'This article has very little content. It may be a stub or disambiguation page.',
      });
    }

    res.json({ html });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

app.get('/api/summary', async (req, res) => {
  try {
    const title = req.query.title;
    if (!title) return res.status(400).json({ error: 'Missing title' });
    const data = await wikiFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (!data.ok) return res.status(404).json({ error: 'Not found' });
    res.json(await data.json());
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

app.get('/api/random', async (_req, res) => {
  try {
    const article = await getRandomArticle();
    res.json(article);
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerNumber = null;

  socket.on('create-room', (data, callback) => {
    const { playerName, gameMode } = typeof data === 'string' ? { playerName: data, gameMode: 'classic' } : data;
    const code = generateRoomCode();
    const room = {
      code,
      players: [{ id: socket.id, name: playerName, ready: false }],
      state: 'waiting',
      gameMode: gameMode || 'classic',
      gameState: null,
      matchScores: [0, 0],
      roundNumber: 0,
      roundWins: [0, 0],
      lastWinner: -1,
    };
    rooms.set(code, room);
    currentRoom = code;
    playerNumber = 0;
    socket.join(code);
    callback({ code, playerNumber: 0, gameMode: room.gameMode });
  });

  socket.on('join-room', (data, callback) => {
    const { code, playerName } = data;
    const room = rooms.get(code.toUpperCase());
    if (!room) return callback({ error: 'Room not found' });
    if (room.players.length >= 2) return callback({ error: 'Room is full' });
    room.players.push({ id: socket.id, name: playerName, ready: false });
    currentRoom = code.toUpperCase();
    playerNumber = 1;
    socket.join(currentRoom);
    callback({ code: currentRoom, playerNumber: 1, gameMode: room.gameMode });
    io.to(currentRoom).emit('room-update', {
      players: room.players.map((p) => ({ name: p.name, ready: p.ready })),
      state: room.state,
      gameMode: room.gameMode,
    });
  });

  socket.on('set-mode', (mode) => {
    if (!currentRoom || playerNumber !== 0) return;
    const room = rooms.get(currentRoom);
    if (!room || room.state !== 'waiting') return;
    room.gameMode = mode;
    io.to(currentRoom).emit('mode-changed', mode);
  });

  socket.on('player-ready', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.players[playerNumber].ready = true;
    io.to(currentRoom).emit('room-update', {
      players: room.players.map((p) => ({ name: p.name, ready: p.ready })),
      state: room.state,
      gameMode: room.gameMode,
    });
    if (room.players.length === 2 && room.players.every((p) => p.ready)) {
      startGame(room);
    }
  });

  async function startGame(room) {
    room.state = 'loading';
    io.to(room.code).emit('game-loading');
    try {
      const [start1, start2, target] = await Promise.all([
        getRandomArticle(), getRandomArticle(), getRandomArticle(),
      ]);
      room.roundNumber++;
      room.state = 'playing';
      room.gameState = {
        starts: [start1, start2],
        target,
        current: [start1.title, start2.title],
        clicks: [0, 0],
        history: [[], []],
        startTime: Date.now(),
        finished: [false, false],
        loadErrors: [0, 0],
      };
      room.players[0].ready = false;
      room.players[1].ready = false;
      io.to(room.code).emit('game-start', {
        starts: [start1, start2],
        target,
        roundNumber: room.roundNumber,
        matchScores: room.matchScores,
        gameMode: room.gameMode,
      });
    } catch (e) {
      room.state = 'waiting';
      io.to(room.code).emit('game-error', 'Failed to fetch articles. Try again.');
    }
  }

  socket.on('navigate', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.state !== 'playing') return;
    const gs = room.gameState;
    if (gs.finished[playerNumber]) return;

    const title = typeof data === 'string' ? data : data.title;
    const doubleStakes = typeof data === 'object' && data.doubleStakes;

    const clickCost = doubleStakes ? 2 : 1;
    gs.clicks[playerNumber] += clickCost;
    gs.history[playerNumber].push(gs.current[playerNumber]);
    gs.current[playerNumber] = title;

    const emitData = {
      player: playerNumber,
      title,
      clicks: gs.clicks[playerNumber],
    };

    if (room.gameMode === 'fog-of-war') {
      socket.emit('player-navigated', emitData);
    } else {
      io.to(currentRoom).emit('player-navigated', emitData);
    }

    const normalizedTitle = title.replace(/_/g, ' ').toLowerCase();
    const normalizedTarget = gs.target.title.replace(/_/g, ' ').toLowerCase();
    if (normalizedTitle === normalizedTarget) {
      gs.finished[playerNumber] = true;
      const elapsed = Date.now() - gs.startTime;

      const otherPlayer = playerNumber === 0 ? 1 : 0;
      const winnerScore = calculateScore(gs.clicks[playerNumber], elapsed, true, room, playerNumber);
      const loserScore = calculateScore(gs.clicks[otherPlayer], elapsed, false, room, otherPlayer);

      const badges = computeBadges(gs, room, playerNumber);

      room.matchScores[playerNumber] += winnerScore.total;
      room.matchScores[otherPlayer] += loserScore.total;

      if (!room.roundWins) room.roundWins = [0, 0];
      room.roundWins[playerNumber]++;
      room.roundWins[otherPlayer] = 0;
      room.lastWinner = playerNumber;

      room.state = 'finished';
      io.to(currentRoom).emit('game-over', {
        winner: playerNumber,
        winnerScore,
        loserScore,
        clicks: gs.clicks,
        elapsed,
        matchScores: room.matchScores,
        history: gs.history,
        badges,
        gameMode: room.gameMode,
      });
    }
  });

  socket.on('request-rematch', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.players[playerNumber].ready = true;
    io.to(currentRoom).emit('room-update', {
      players: room.players.map((p) => ({ name: p.name, ready: p.ready })),
      state: room.state,
      rematch: true,
      gameMode: room.gameMode,
    });
    if (room.players.length === 2 && room.players.every((p) => p.ready)) {
      startGame(room);
    }
  });

  socket.on('rejoin-room', (data, callback) => {
    const { code, playerName } = data;
    const room = rooms.get(code);
    if (!room) return callback({ error: 'Room no longer exists' });

    const idx = room.players.findIndex(p => p.name === playerName && p.disconnected);
    if (idx === -1) return callback({ error: 'Cannot rejoin' });

    clearTimeout(room.players[idx].disconnectTimer);
    room.players[idx].id = socket.id;
    room.players[idx].disconnected = false;
    delete room.players[idx].disconnectTimer;
    currentRoom = code;
    playerNumber = idx;
    socket.join(code);

    callback({
      code,
      playerNumber: idx,
      gameMode: room.gameMode,
      gameState: room.state,
      matchScores: room.matchScores,
      roundNumber: room.roundNumber,
    });

    io.to(code).emit('player-reconnected', { player: idx });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    // Mark player as disconnected, give them 15s to reconnect
    room.players[playerNumber].disconnected = true;
    room.players[playerNumber].disconnectTimer = setTimeout(() => {
      // If still disconnected after 15s, notify other player and clean up
      io.to(currentRoom).emit('player-disconnected');
      rooms.delete(currentRoom);
    }, 15000);

    io.to(currentRoom).emit('player-temporarily-disconnected', { player: playerNumber });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n  Wikipedia Race is running on port ${PORT}!\n`);

  if (!process.env.RAILWAY_ENVIRONMENT && !process.env.RENDER) {
    const nets = require('os').networkInterfaces();
    let localIp = 'localhost';
    for (const iface of Object.values(nets)) {
      for (const cfg of iface) {
        if (cfg.family === 'IPv4' && !cfg.internal) { localIp = cfg.address; break; }
      }
    }
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://${localIp}:${PORT}`);

    try {
      const cfPath = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
      const tunnel = spawn(cfPath, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let tunnelUrl = null;
      const handleOutput = (data) => {
        const match = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !tunnelUrl) { tunnelUrl = match[0]; console.log(`\n  Public:  ${tunnelUrl}\n  Share the Public URL with Player 2!\n`); }
      };
      tunnel.stdout.on('data', handleOutput);
      tunnel.stderr.on('data', handleOutput);
      tunnel.on('error', () => console.log('  Tunnel unavailable — LAN play still works.\n'));
      process.on('exit', () => tunnel.kill());
    } catch (_) {}
  }
});
