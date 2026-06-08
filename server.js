import { createServer } from 'http';
import { readFileSync } from 'fs';
import { Server } from 'socket.io';
import { createId } from '@paralleldrive/cuid2';

// ─── Static file serving ─────────────────────────────────────────
const httpServer = createServer((req, res) => {
  let path = req.url === '/' ? '/index.html' : req.url;
  try {
    const file = readFileSync('.' + path);
    const ext = path.split('.').pop();
    const mime = {
      html: 'text/html',
      js: 'application/javascript',
      css: 'text/css',
      ico: 'image/x-icon',
      svg: 'image/svg+xml',
    }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// ─── Constants ───────────────────────────────────────────────────
const BOARD_SIZE = 9;
const WALL_MAX   = 10;
const RECONNECT_TIMEOUT_MS = 60_000;

// ─── In-memory state ─────────────────────────────────────────────
// rooms: Map<roomCode, room>
const rooms = new Map();

// tokens: Map<token, { roomCode, playerIndex }>
const tokens = new Map();

// queue: Map<socketId, queueEntry>
const queues = {
  casual: [], // [{ socketId, username, joinedAt }]
  ranked: [], // [{ socketId, username, joinedAt, elo }]
};

// socketToRoom: Map<socketId, roomCode>
const socketToRoom = new Map();

// ─── ID generators ───────────────────────────────────────────────
function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? makeRoomCode() : code;
}

function makeToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// ─── Game state factory ──────────────────────────────────────────
function makeGameState(matchType = 'private') {
  return {
    players: {
      P1: { row: 0, col: 4 },
      P2: { row: 8, col: 4 },
    },
    walls: { horizontal: {}, vertical: {} },
    wallCounts: { P1: WALL_MAX, P2: WALL_MAX },
    currentTurn: 'P1',
    gameOver: false,
    winner: null,
    matchType,
  };
}

// ─── Room factory ────────────────────────────────────────────────
function makeRoom(code, matchType = 'private') {
  return {
    code,
    matchType,
    players: [null, null],   // [{ socketId, username, ready, token }, ...]
    spectators: [],           // [{ socketId, username }]
    gameState: null,
    disconnectTimers: [null, null],
  };
}

// ─── Wall / path logic (mirrors client) ──────────────────────────
function isMovementBlocked(walls, fromRow, fromCol, toRow, toCol) {
  const { horizontal, vertical } = walls;
  const dr = toRow - fromRow, dc = toCol - fromCol;
  if (dr === 1 && dc === 0)
    return !!(horizontal[`${fromRow},${fromCol}`] || horizontal[`${fromRow},${fromCol - 1}`]);
  if (dr === -1 && dc === 0)
    return !!(horizontal[`${toRow},${fromCol}`] || horizontal[`${toRow},${fromCol - 1}`]);
  if (dr === 0 && dc === 1)
    return !!(vertical[`${fromRow},${fromCol}`] || vertical[`${fromRow - 1},${fromCol}`]);
  if (dr === 0 && dc === -1)
    return !!(vertical[`${fromRow},${toCol}`] || vertical[`${fromRow - 1},${toCol}`]);
  return false;
}

function hasPath(walls, startRow, startCol, goalRow) {
  const visited = new Set();
  const queue = [{ r: startRow, c: startCol }];
  visited.add(`${startRow},${startCol}`);
  while (queue.length) {
    const { r, c } = queue.shift();
    if (r === goalRow) return true;
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
      const key = `${nr},${nc}`;
      if (visited.has(key)) continue;
      if (isMovementBlocked(walls, r, c, nr, nc)) continue;
      visited.add(key);
      queue.push({ r: nr, c: nc });
    }
  }
  return false;
}

function canPlaceWall(gs, type, row, col) {
  if (row < 0 || row > 7 || col < 0 || col > 7) return false;
  const key = `${row},${col}`;
  const { horizontal, vertical } = gs.walls;

  if (type === 'horizontal') {
    if (horizontal[key]) return false;
    if (horizontal[`${row},${col - 1}`] || horizontal[`${row},${col + 1}`]) return false;
    if (vertical[key]) return false;
  } else {
    if (vertical[key]) return false;
    if (vertical[`${row - 1},${col}`] || vertical[`${row + 1},${col}`]) return false;
    if (horizontal[key]) return false;
  }

  const tempH = { ...horizontal };
  const tempV = { ...vertical };
  if (type === 'horizontal') tempH[key] = 'check';
  else tempV[key] = 'check';
  const tempWalls = { horizontal: tempH, vertical: tempV };

  return (
    hasPath(tempWalls, gs.players.P1.row, gs.players.P1.col, 8) &&
    hasPath(tempWalls, gs.players.P2.row, gs.players.P2.col, 0)
  );
}

// ─── Room helpers ────────────────────────────────────────────────
function roomPublicState(room) {
  return {
    code: room.code,
    players: room.players.map(p =>
      p ? { username: p.username, ready: p.ready } : null
    ),
    spectators: room.spectators.map(s => s.username),
  };
}

function broadcastRoomUpdate(room) {
  io.to(room.code).emit('roomUpdated', roomPublicState(room));
}

function playerIndexForSocket(room, socketId) {
  return room.players.findIndex(p => p && p.socketId === socketId);
}

// ─── Matchmaking ─────────────────────────────────────────────────
const DEFAULT_ELO = 1200;

function tryMatch(mode) {
  const q = queues[mode];
  if (q.length < 2) return;

  if (mode === 'ranked') {
    // Sort by elo, find the first pair within expanding range
    q.sort((a, b) => a.elo - b.elo);
    const now = Date.now();
    for (let i = 0; i < q.length - 1; i++) {
      const a = q[i];
      const elapsed = (now - a.joinedAt) / 1000;
      const range = 100 + Math.floor(elapsed / 10) * 100;
      const b = q[i + 1];
      if (Math.abs(a.elo - b.elo) <= range) {
        q.splice(i + 1, 1);
        q.splice(i, 1);
        createMatchGame(a, b, 'ranked');
        return;
      }
    }
    return;
  }

  // Casual — match oldest two waiting players
  const [a, b] = q.splice(0, 2);
  createMatchGame(a, b, 'casual');
}

function createMatchGame(entryA, entryB, matchType) {
  const code = makeRoomCode();
  const room = makeRoom(code, matchType);
  const tokenA = makeToken();
  const tokenB = makeToken();

  room.players[0] = { socketId: entryA.socketId, username: entryA.username, ready: true, token: tokenA };
  room.players[1] = { socketId: entryB.socketId, username: entryB.username, ready: true, token: tokenB };
  room.gameState  = makeGameState(matchType);

  rooms.set(code, room);
  tokens.set(tokenA, { roomCode: code, playerIndex: 0 });
  tokens.set(tokenB, { roomCode: code, playerIndex: 1 });
  socketToRoom.set(entryA.socketId, code);
  socketToRoom.set(entryB.socketId, code);

  const sockA = io.sockets.sockets.get(entryA.socketId);
  const sockB = io.sockets.sockets.get(entryB.socketId);

  if (sockA) { sockA.join(code); sockA.emit('matchFound', { roomCode: code, playerIndex: 0, gameState: room.gameState }); }
  if (sockB) { sockB.join(code); sockB.emit('matchFound', { roomCode: code, playerIndex: 1, gameState: room.gameState }); }
}

// ─── Socket handlers ─────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── createRoom ──────────────────────────────────────────────────
  socket.on('createRoom', ({ username }) => {
    if (!username) return;
    const code  = makeRoomCode();
    const token = makeToken();
    const room  = makeRoom(code, 'private');

    room.players[0] = { socketId: socket.id, username, ready: false, token };
    rooms.set(code, room);
    tokens.set(token, { roomCode: code, playerIndex: 0 });
    socketToRoom.set(socket.id, code);
    socket.join(code);

    socket.emit('roomCreated', { roomCode: code, playerIndex: 0, token });
    broadcastRoomUpdate(room);
  });

  // ── joinRoom ────────────────────────────────────────────────────
  socket.on('joinRoom', ({ code, username }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) { socket.emit('error', { message: 'Room not found.' }); return; }

    let playerIndex = -1;
    // Fill empty player slot first
    if (!room.players[0]) { playerIndex = 0; }
    else if (!room.players[1]) { playerIndex = 1; }

    const token = makeToken();

    if (playerIndex >= 0) {
      room.players[playerIndex] = { socketId: socket.id, username, ready: false, token };
      tokens.set(token, { roomCode: code, playerIndex });
    } else {
      // Spectator
      room.spectators.push({ socketId: socket.id, username });
    }

    socketToRoom.set(socket.id, code);
    socket.join(code);
    socket.emit('roomJoined', { roomCode: code, playerIndex, token: playerIndex >= 0 ? token : null });
    broadcastRoomUpdate(room);
  });

  // ── attemptReconnect ────────────────────────────────────────────
  socket.on('attemptReconnect', ({ token }) => {
    const sess = tokens.get(token);
    if (!sess) { socket.emit('reconnectFailed'); return; }

    const room = rooms.get(sess.roomCode);
    if (!room) { tokens.delete(token); socket.emit('reconnectFailed'); return; }

    const pi = sess.playerIndex;
    const player = room.players[pi];
    if (!player) { socket.emit('reconnectFailed'); return; }

    // Clear any pending disconnect timer
    if (room.disconnectTimers[pi]) {
      clearTimeout(room.disconnectTimers[pi]);
      room.disconnectTimers[pi] = null;
    }

    // Update socket id
    player.socketId = socket.id;
    socketToRoom.set(socket.id, sess.roomCode);
    socket.join(sess.roomCode);

    socket.emit('reconnectSuccess', {
      roomCode: sess.roomCode,
      playerIndex: pi,
      gameState: room.gameState || null,
    });
    broadcastRoomUpdate(room);

    if (room.gameState) {
      io.to(sess.roomCode).emit('playerReconnected', { username: player.username });
    }
  });

  // ── playerReady ─────────────────────────────────────────────────
  socket.on('playerReady', ({ ready }) => {
    const code = socketToRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return;

    const pi = playerIndexForSocket(room, socket.id);
    if (pi < 0) return;
    room.players[pi].ready = !!ready;
    broadcastRoomUpdate(room);

    // Start if both players present and ready
    const [p1, p2] = room.players;
    if (p1 && p2 && p1.ready && p2.ready && !room.gameState) {
      room.gameState = makeGameState(room.matchType);
      io.to(code).emit('startGame', { gameState: room.gameState });
    }
  });

  // ── playerMove ──────────────────────────────────────────────────
  socket.on('playerMove', ({ row, col }) => {
    const code = socketToRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.gameOver) return;

    const pi = playerIndexForSocket(room, socket.id);
    const playerKey = pi === 0 ? 'P1' : pi === 1 ? 'P2' : null;
    if (!playerKey || gs.currentTurn !== playerKey) return;

    const pos = gs.players[playerKey];
    const dr = row - pos.row, dc = col - pos.col;
    // Must be exactly one step orthogonal
    if (Math.abs(dr) + Math.abs(dc) !== 1) return;
    if (isMovementBlocked(gs.walls, pos.row, pos.col, row, col)) return;

    // Check not occupied by other player
    const otherKey = playerKey === 'P1' ? 'P2' : 'P1';
    if (gs.players[otherKey].row === row && gs.players[otherKey].col === col) return;

    gs.players[playerKey] = { row, col };

    // Check win: P1 reaches row 8, P2 reaches row 0
    if ((playerKey === 'P1' && row === 8) || (playerKey === 'P2' && row === 0)) {
      gs.gameOver = true;
      gs.winner   = playerKey;
    } else {
      gs.currentTurn = otherKey;
    }

    io.to(code).emit('gameStateUpdated', gs);
  });

  // ── placeWall ───────────────────────────────────────────────────
  socket.on('placeWall', ({ type, row, col }) => {
    const code = socketToRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    if (gs.gameOver) return;

    const pi = playerIndexForSocket(room, socket.id);
    const playerKey = pi === 0 ? 'P1' : pi === 1 ? 'P2' : null;
    if (!playerKey || gs.currentTurn !== playerKey) return;
    if (gs.wallCounts[playerKey] <= 0) return;

    if (!canPlaceWall(gs, type, row, col)) {
      socket.emit('error', { message: 'Invalid wall placement.' });
      return;
    }

    const key = `${row},${col}`;
    if (type === 'horizontal') gs.walls.horizontal[key] = playerKey;
    else                       gs.walls.vertical[key]   = playerKey;

    gs.wallCounts[playerKey]--;
    gs.currentTurn = playerKey === 'P1' ? 'P2' : 'P1';

    io.to(code).emit('gameStateUpdated', gs);
  });

  // ── chatMessage ─────────────────────────────────────────────────
  socket.on('chatMessage', ({ message }) => {
    const code = socketToRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || !message) return;

    const pi = playerIndexForSocket(room, socket.id);
    let sender;
    if (pi >= 0) {
      sender = room.players[pi].username;
    } else {
      const spec = room.spectators.find(s => s.socketId === socket.id);
      sender = spec ? spec.username : 'Unknown';
    }

    const safe = String(message).slice(0, 200);
    io.to(code).emit('chatMessage', { sender, message: safe, timestamp: Date.now() });
  });

  // ── joinQueue ───────────────────────────────────────────────────
  socket.on('joinQueue', ({ username, mode }) => {
    if (!username) return;
    const queueMode = mode === 'ranked' ? 'ranked' : 'casual';

    // Remove from any existing queue first
    removeFromQueues(socket.id);

    const entry = {
      socketId: socket.id,
      username,
      joinedAt: Date.now(),
      elo: DEFAULT_ELO,
    };
    queues[queueMode].push(entry);
    socket.emit('queueJoined');

    tryMatch(queueMode);

    // Schedule periodic re-checks for ranked (expanding range)
    if (queueMode === 'ranked') {
      scheduleRankedCheck(socket.id);
    }
  });

  // ── leaveQueue ──────────────────────────────────────────────────
  socket.on('leaveQueue', () => {
    removeFromQueues(socket.id);
  });

  // ── leaveRoom ───────────────────────────────────────────────────
  socket.on('leaveRoom', () => {
    handleLeave(socket);
  });

  // ── disconnect ──────────────────────────────────────────────────
  socket.on('disconnect', () => {
    removeFromQueues(socket.id);

    const code = socketToRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return;

    const pi = playerIndexForSocket(room, socket.id);
    if (pi >= 0) {
      const username = room.players[pi].username;
      io.to(code).emit('systemMessage', { message: `${username} disconnected. Waiting 60 seconds...` });

      // Give them 60 s to reconnect before clearing their slot
      room.disconnectTimers[pi] = setTimeout(() => {
        room.players[pi] = null;
        socketToRoom.delete(socket.id);
        broadcastRoomUpdate(room);
        io.to(code).emit('systemMessage', { message: `${username} left the game.` });
        maybeCleanRoom(code);
      }, RECONNECT_TIMEOUT_MS);
    } else {
      // Spectator
      room.spectators = room.spectators.filter(s => s.socketId !== socket.id);
      socketToRoom.delete(socket.id);
      broadcastRoomUpdate(room);
    }
  });
});

// ─── Helpers ─────────────────────────────────────────────────────
function removeFromQueues(socketId) {
  queues.casual = queues.casual.filter(e => e.socketId !== socketId);
  queues.ranked = queues.ranked.filter(e => e.socketId !== socketId);
}

function scheduleRankedCheck(socketId) {
  // Re-run tryMatch every 10 s while the player is still in queue
  const interval = setInterval(() => {
    const stillInQueue = queues.ranked.some(e => e.socketId === socketId);
    if (!stillInQueue) { clearInterval(interval); return; }
    tryMatch('ranked');
  }, 10_000);
}

function handleLeave(socket) {
  const code = socketToRoom.get(socket.id);
  const room = rooms.get(code);
  if (!room) return;

  const pi = playerIndexForSocket(room, socket.id);
  if (pi >= 0) {
    if (room.disconnectTimers[pi]) clearTimeout(room.disconnectTimers[pi]);
    const token = room.players[pi].token;
    if (token) tokens.delete(token);
    room.players[pi] = null;
  } else {
    room.spectators = room.spectators.filter(s => s.socketId !== socket.id);
  }

  socketToRoom.delete(socket.id);
  socket.leave(code);
  broadcastRoomUpdate(room);
  maybeCleanRoom(code);
}

function maybeCleanRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  const everyone = [
    ...room.players.filter(Boolean),
    ...room.spectators,
  ];
  if (everyone.length === 0) rooms.delete(code);
}

// ─── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Barricade server running on http://localhost:${PORT}`);
});
