const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const THEMES = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/themes', (req, res) => {
  res.json(THEMES.map(t => ({ id: t.id, name: t.name, roundsCount: t.rounds.length })));
});

const rooms = new Map();
const GRACE_MS = 10000; // сколько ждём переподключения после перезагрузки страницы

function makeCode() {
  let code;
  do {
    code = String(Math.floor(100 + Math.random() * 900)); // 100..999
  } while (rooms.has(code));
  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    themeName: room.themeName,
    state: room.state,
    players: room.players.map(p => ({
      id: p.id, name: p.name, ready: p.ready, score: p.score
    }))
  };
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({ name, themeId }, cb) => {
    const theme = THEMES.find(t => t.id === themeId);
    if (!theme) return cb({ error: 'Тема не найдена' });

    const round = theme.rounds[Math.floor(Math.random() * theme.rounds.length)];
    const code = makeCode();

    const room = {
      code,
      themeId: theme.id,
      themeName: theme.name,
      round,
      qIndex: 0,
      state: 'lobby',
      players: [{
        id: socket.id,
        name: (name || '').trim() || 'Игрок 1',
        ready: false,
        score: 0
      }],
      answers: new Map(),
      nextVotes: new Set(),
      timer: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.code = code;
    cb({ ok: true, room: publicRoom(room), selfId: socket.id });
  });

  // Возвращаемся в комнату после перезагрузки страницы
  socket.on('rejoin', ({ code, oldId }, cb) => {
    code = String(code || '').trim();
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Комната не найдена' });

    const player = room.players.find(p => p.id === oldId);
    if (!player) return cb({ error: 'Вы не в этой комнате' });

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    player.id = socket.id;
    socket.join(code);
    socket.data.code = code;
    cb({ ok: true, room: publicRoom(room), selfId: socket.id });
    io.to(code).emit('roomUpdate', publicRoom(room));
  });

  socket.on('joinRoom', ({ name, code }, cb) => {
    code = String(code || '').trim();
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Комната не найдена' });
    if (room.state !== 'lobby') return cb({ error: 'Игра уже началась' });
    if (room.players.length >= 6) return cb({ error: 'Комната полна (макс. 6)' });

    room.players.push({
      id: socket.id,
      name: (name || '').trim() || `Игрок ${room.players.length + 1}`,
      ready: false,
      score: 0
    });
    socket.join(code);
    socket.data.code = code;
    cb({ ok: true, room: publicRoom(room), selfId: socket.id });
    io.to(code).emit('roomUpdate', publicRoom(room));
  });

  socket.on('toggleReady', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p) return;
    p.ready = !p.ready;
    io.to(room.code).emit('roomUpdate', publicRoom(room));

    if (room.players.length >= 2 && room.players.every(p => p.ready)) {
      startGame(room);
    }
  });

  socket.on('answer', ({ index }) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.state !== 'question') return;
    if (room.answers.has(socket.id)) return;

    room.answers.set(socket.id, index);
    socket.emit('answerAccepted');
    io.to(room.code).emit('answerCount', {
      count: room.answers.size,
      total: room.players.length
    });

    if (room.answers.size >= room.players.length) {
      revealAnswer(room);
    }
  });

  socket.on('next', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.state !== 'reveal') return;
    room.nextVotes.add(socket.id);
    io.to(room.code).emit('nextCount', {
      count: room.nextVotes.size,
      total: room.players.length
    });
    if (room.nextVotes.size >= room.players.length) {
      nextQuestion(room);
    }
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // Не удаляем сразу — даём шанс вернуться (перезагрузка страницы)
    player.disconnectTimer = setTimeout(() => {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        if (room.timer) clearTimeout(room.timer);
        rooms.delete(room.code);
        return;
      }
      io.to(room.code).emit('roomUpdate', publicRoom(room));
    }, GRACE_MS);

    io.to(room.code).emit('roomUpdate', publicRoom(room));
  });
});

function startGame(room) {
  room.state = 'question';
  room.qIndex = 0;
  room.answers = new Map();
  room.nextVotes = new Set();
  io.to(room.code).emit('gameStarted', { themeName: room.themeName, roundName: room.round.name });
  sendQuestion(room);
}

function sendQuestion(room) {
  room.state = 'question';
  room.answers = new Map();
  room.nextVotes = new Set();

  const q = room.round.questions[room.qIndex];
  if (!q) return endGame(room);

  io.to(room.code).emit('question', {
    index: room.qIndex,
    total: room.round.questions.length,
    text: q.q,
    answers: q.a,
    duration: 40000,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
        explanation: q.e || ''
  });

  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => revealAnswer(room), 40000);
}

function revealAnswer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (room.state !== 'question') return;
  room.state = 'reveal';

  const q = room.round.questions[room.qIndex];

  room.players.forEach(p => {
    if (room.answers.get(p.id) === q.correct) p.score += 1;
  });

  const answersByPlayer = {};
  room.players.forEach(p => {
    answersByPlayer[p.id] = room.answers.has(p.id) ? room.answers.get(p.id) : null;
  });

  io.to(room.code).emit('reveal', {
    correct: q.correct,
    answersByPlayer,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
  });

  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => nextQuestion(room), 10000);
}

function nextQuestion(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.qIndex++;
  if (room.qIndex >= room.round.questions.length) return endGame(room);
  sendQuestion(room);
}

function endGame(room) {
  room.state = 'results';
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  io.to(room.code).emit('gameEnded', {
    players: sorted.map(p => ({ id: p.id, name: p.name, score: p.score }))
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚢  Квиз запущен:  http://localhost:${PORT}\n`);
});
