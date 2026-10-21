const socket = io();
let selfId = sessionStorage.getItem('selfId');
const roomCode = sessionStorage.getItem('code');

if (!selfId || !roomCode) {
  location.href = 'index.html';
}

let myReady = false;
let myAnswered = false;
let timerInterval = null;
let lastQuestion = null;

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderLobby(room) {
  document.getElementById('roomCode').textContent = room.code;
  document.getElementById('lobbyTheme').textContent = room.themeName;
  document.getElementById('lobbyRound').textContent = room.roundName || '';
  document.getElementById('playerCount').textContent = `(${room.players.length}/6)`;

  const list = document.getElementById('playersList');
  list.innerHTML = '';
  room.players.forEach(p => {
    const el = document.createElement('div');
    el.className = 'player-chip' + (p.ready ? ' ready' : '');
    const isMe = p.id === selfId;
    el.innerHTML = `<span>${esc(p.name)}${isMe ? ' (вы)' : ''}</span>
                    <span class="status">${p.ready ? 'готов' : 'ждём'}</span>`;
    list.appendChild(el);
    if (isMe) myReady = p.ready;
  });

  const btn = document.getElementById('btnReady');
  btn.textContent = myReady ? 'Не готов' : 'Я готов';

  const hint = document.getElementById('lobbyHint');
  if (room.players.length < 2) hint.textContent = 'Нужно минимум 2 игрока';
  else if (room.players.every(p => p.ready)) hint.textContent = 'Старт!';
  else hint.textContent = 'Ждём готовности всех';
}

document.getElementById('btnReady').onclick = () => socket.emit('toggleReady');

document.getElementById('btnCopy').onclick = () => {
  navigator.clipboard.writeText(roomCode);
  const b = document.getElementById('btnCopy');
  b.textContent = 'Скопировано';
  setTimeout(() => b.textContent = 'Скопировать', 1500);
};

// При подключении — пытаемся переподключиться к комнате
socket.on('connect', () => {
  const savedId = sessionStorage.getItem('selfId');
  if (!savedId || !roomCode) return;
  socket.emit('rejoin', { code: roomCode, oldId: savedId }, (res) => {
    if (res.error) {
      sessionStorage.clear();
      location.href = 'index.html';
      return;
    }
    selfId = res.selfId;
    sessionStorage.setItem('selfId', selfId);
    if (res.room.state === 'lobby') renderLobby(res.room);
  });
});

socket.on('gameStarted', () => {});

socket.on('question', (data) => {
  myAnswered = false;
  lastQuestion = data;
  showScreen('screen-question');

  document.getElementById('qProgress').textContent =
    `Вопрос ${data.index + 1} / ${data.total} • ${data.roundName}`;
  document.getElementById('questionText').textContent = data.text;

  const box = document.getElementById('answersBox');
  box.innerHTML = '';
  data.answers.forEach((ans, i) => {
    const btn = document.createElement('button');
    btn.className = 'answer-btn';
    btn.textContent = ans;
    btn.onclick = () => submitAnswer(i, btn);
    box.appendChild(btn);
  });

  document.getElementById('answerStatus').textContent = 'Выберите ответ';
  startTimer(data.duration);
  renderScoreboardFromPlayers('scoreboardQ', data.players || []);
});

function submitAnswer(index, btn) {
  if (myAnswered) return;
  myAnswered = true;
  document.querySelectorAll('#answersBox .answer-btn').forEach(b => b.disabled = true);
  btn.classList.add('selected');
  document.getElementById('answerStatus').textContent = 'Ответ принят. Ждём остальных…';
  socket.emit('answer', { index });
}

function startTimer(duration) {
  if (timerInterval) clearInterval(timerInterval);
  const el = document.getElementById('timer');
  const fill = document.getElementById('progressFill');
  const total = duration / 1000;
  let remaining = total;

  const tick = () => {
    el.textContent = Math.ceil(remaining);
    fill.style.width = ((remaining / total) * 100) + '%';
    if (remaining <= 5) el.classList.add('warn');
    else el.classList.remove('warn');
  };
  tick();

  timerInterval = setInterval(() => {
    remaining -= 0.1;
    if (remaining <= 0) {
      remaining = 0;
      tick();
      clearInterval(timerInterval);
      timerInterval = null;
    } else tick();
  }, 100);
}

socket.on('answerCount', ({ count, total }) => {
  if (myAnswered) {
    document.getElementById('answerStatus').textContent = `Ответили: ${count} / ${total}`;
  }
});

socket.on('reveal', (data) => {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  showScreen('screen-reveal');

  if (lastQuestion) {
    document.getElementById('questionTextR').textContent = lastQuestion.text;
    document.getElementById('qProgressR').textContent =
      `Вопрос ${lastQuestion.index + 1} / ${lastQuestion.total} • ${lastQuestion.roundName}`;
  }

  const box = document.getElementById('answersBoxR');
  box.innerHTML = '';
  const myAns = data.answersByPlayer[selfId];
  if (lastQuestion) {
    lastQuestion.answers.forEach((ans, i) => {
      const btn = document.createElement('button');
      btn.className = 'answer-btn';
      if (i === data.correct) btn.classList.add('correct');
      if (myAns === i && i !== data.correct) btn.classList.add('wrong');
      btn.textContent = ans;
      btn.disabled = true;
      box.appendChild(btn);
    });
  }

  const expBox = document.getElementById('explanationBox');
  const expText = document.getElementById('explanationText');
  if (data.explanation) {
    expText.textContent = data.explanation;
    expBox.style.display = 'block';
  } else {
    expBox.style.display = 'none';
  }
  renderScoreboardFromPlayers('scoreboardR', data.players);
  document.getElementById('btnNext').disabled = false;
  document.getElementById('nextHint').textContent = 'Нажмите «Далее», когда готовы';
});

document.getElementById('btnNext').onclick = () => {
  document.getElementById('btnNext').disabled = true;
  document.getElementById('nextHint').textContent = 'Ждём остальных…';
  socket.emit('next');
};

socket.on('nextCount', ({ count, total }) => {
  if (document.getElementById('screen-reveal').classList.contains('active')) {
    document.getElementById('nextHint').textContent = `Готовы: ${count} / ${total}`;
  }
});

socket.on('gameEnded', (data) => {
  showScreen('screen-results');
  const top = data.players[0];
  const winners = data.players.filter(p => p.score === top.score);
  const wb = document.getElementById('winnerBox');
  if (winners.length > 1) {
    wb.textContent = `🤝 Ничья: ${winners.map(w => w.name).join(', ')}`;
  } else {
    wb.textContent = `🏆 Победитель: ${top.name}`;
  }

  const list = document.getElementById('finalList');
  list.innerHTML = '';
  data.players.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'final-item';
    el.innerHTML = `<span>${i + 1}. ${esc(p.name)}${p.id === selfId ? ' (вы)' : ''}</span>
                    <span class="score">${p.score}</span>`;
    list.appendChild(el);
  });
});

socket.on('roomUpdate', (room) => {
  if (room.state === 'lobby') renderLobby(room);
});

function renderScoreboardFromPlayers(targetId, players) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.innerHTML = '';
  players.forEach(p => {
    const item = document.createElement('div');
    item.className = 'score-item' + (p.id === selfId ? ' you' : '');
    item.innerHTML = `<div class="name">${esc(p.name)}</div>
                      <div class="val">${p.score}</div>`;
    el.appendChild(item);
  });
}
