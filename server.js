// Точка входа: HTTP-сервер (Express) + реальное время (Socket.IO).
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { RoomManager } from './src/rooms.js';
import { decideBotAction, BOT_NAMES } from './src/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Обнаружение тем карт: папки в корне, где есть подпапка jpg_fronts.
function discoverThemes() {
  try {
    return fs
      .readdirSync(__dirname, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(__dirname, d.name, 'jpg_fronts')))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
const THEMES = discoverThemes();

// Разрешённые эмодзи-реакции (защита от произвольного ввода).
const REACTIONS = ['😎', '🤡', '😱', '🔥', '😂', '😡', '👏', '💩', '🃏', '🤑'];

const app = express();
app.set('trust proxy', 1); // корректная работа за обратным прокси хостинга (Render и т.п.)
app.use(express.static(path.join(__dirname, 'public')));
// Раздаём арты каждой темы по /art/<тема>/...
for (const t of THEMES) {
  app.use('/art/' + encodeURIComponent(t), express.static(path.join(__dirname, t)));
}
console.log('Темы карт:', THEMES.length ? THEMES.join(', ') : '(не найдены)');

const server = http.createServer(app);
const io = new Server(server);
const manager = new RoomManager();

// Рассылка персонализированного состояния каждому игроку комнаты
// (у каждого свои закрытые карты).
function broadcast(room) {
  const pub = room.game.publicState();
  const turnMs = room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : null;
  const turnTotal = room.game.turnSeconds * 1000;
  for (const [playerId, socketId] of room.sockets) {
    const priv = room.game.privateFor(playerId);
    io.to(socketId).emit('state', { code: room.code, you: playerId, pub, priv, turnMs, turnTotal });
  }
  // Громкие объявления Весёлого режима — всем в комнате.
  for (const a of room.game.drainAnnounce()) io.to(room.code).emit('announce', a);
}

// Единая точка после изменения хода: выставить дедлайн (синхронно), разослать
// состояние уже с корректным остатком времени, затем при необходимости — ход бота.
function commit(room) {
  scheduleTurnTimeout(room);
  broadcast(room);
  maybeBotAct(room);
}

function scheduleTurnTimeout(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.turnDeadline = null;
  const g = room.game;
  if (g.phase !== 'playing') return;
  const cur = g.players.find((p) => p.id === g.toActId);
  if (!cur || cur.isBot) return; // у ботов свой быстрый таймер
  const ms = g.turnSeconds * 1000;
  room.turnDeadline = Date.now() + ms;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    room.turnDeadline = null;
    if (g.phase !== 'playing') return;
    const p = g.players.find((x) => x.id === g.toActId);
    if (!p || p.isBot) return;
    const priv = g.privateFor(p.id);
    if (priv.canCheck) g.applyAction(p.id, 'check');
    else g.applyAction(p.id, 'fold');
    g.pushLog(`${p.name} — время вышло ⏱`);
    commit(room);
  }, ms);
}

// Если сейчас ход бота — планируем его автоматический ход с задержкой.
function maybeBotAct(room) {
  const g = room.game;
  if (g.phase !== 'playing' || room.botTimer) return;
  const cur = g.players.find((x) => x.id === g.toActId);
  if (!cur || !cur.isBot) return;

  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (g.phase !== 'playing') return;
    const bot = g.players.find((x) => x.id === g.toActId);
    if (!bot || !bot.isBot) return;

    const decision = decideBotAction(g, bot.id);
    // Пробуем ход; при отклонении — безопасный откат.
    let res = g.applyAction(bot.id, decision.type, decision.amount);
    if (!res.ok) res = g.applyAction(bot.id, 'call');
    if (!res.ok) res = g.applyAction(bot.id, 'check');
    if (!res.ok) res = g.applyAction(bot.id, 'fold');

    commit(room); // следующий ход — бот или живой (с таймером)
  }, 800 + Math.random() * 700);
}

function validateSettings(s = {}) {
  const sb = clampInt(s.smallBlind, 5, 1, 100000);
  const bb = clampInt(s.bigBlind, Math.max(sb * 2, 10), sb + 1, 200000);
  const chips = clampInt(s.startingChips, 1000, bb * 2, 10000000);
  const turnSeconds = clampInt(s.turnSeconds, 60, 10, 300);
  const mode = s.mode === 'fun' ? 'fun' : 'classic';
  return { smallBlind: sb, bigBlind: bb, startingChips: chips, turnSeconds, mode };
}

function clampInt(v, def, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

io.on('connection', (socket) => {
  let currentCode = null;
  let currentPlayerId = null;

  const leaveCurrent = () => {
    if (!currentCode) return;
    const room = manager.getRoom(currentCode);
    if (!room) return;
    // Помечаем отключённым; в лобби/паузе — убираем совсем.
    room.game.setConnected(currentPlayerId, false);
    room.sockets.delete(currentPlayerId);
    if (room.game.phase !== 'playing') {
      room.game.removePlayer(currentPlayerId);
      if (room.hostId === currentPlayerId) {
        room.hostId = room.game.players[0]?.id ?? null;
      }
    }
    socket.leave(currentCode);
    if (!manager.deleteIfEmpty(currentCode)) {
      commit(room); // если ушёл ходящий — перезапустить таймер для следующего
    }
    currentCode = null;
    currentPlayerId = null;
  };

  socket.emit('config', { themes: THEMES });

  socket.on('createRoom', ({ name, playerId, settings } = {}, cb) => {
    const room = manager.createRoom({ ...validateSettings(settings), themes: THEMES });
    joinRoomInternal(room, { name, playerId }, cb);
  });

  socket.on('joinRoom', ({ code, name, playerId } = {}, cb) => {
    const room = manager.getRoom(code);
    if (!room) return cb?.({ ok: false, error: 'Комната не найдена' });
    joinRoomInternal(room, { name, playerId }, cb);
  });

  function joinRoomInternal(room, { name, playerId }, cb) {
    const cleanName = String(name || 'Игрок').trim().slice(0, 16) || 'Игрок';
    const existing = playerId && room.game.players.find((p) => p.id === playerId);

    if (existing) {
      // Переподключение к своему месту.
      existing.connected = true;
      existing.name = cleanName;
    } else {
      if (room.game.players.length >= 9)
        return cb?.({ ok: false, error: 'Стол заполнен (макс. 9)' });
      if (room.game.phase === 'playing')
        return cb?.({ ok: false, error: 'Раздача идёт — дождитесь её конца' });
      playerId = playerId || cryptoId();
      room.game.addPlayer(playerId, cleanName);
    }

    if (!room.hostId) room.hostId = playerId;
    room.sockets.set(playerId, socket.id);
    socket.join(room.code);
    currentCode = room.code;
    currentPlayerId = playerId;

    cb?.({ ok: true, code: room.code, playerId, hostId: room.hostId });
    broadcast(room);
  }

  socket.on('startHand', (cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    if (room.game.phase === 'playing')
      return cb?.({ ok: false, error: 'Раздача уже идёт' });
    const res = room.game.startHand();
    if (!res.ok) return cb?.(res);
    cb?.({ ok: true });
    commit(room);
  });

  socket.on('action', ({ type, amount } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.applyAction(currentPlayerId, type, amount);
    if (!res.ok) return cb?.(res);
    cb?.({ ok: true });
    commit(room);
  });

  socket.on('rebuy', ({ amount } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.rebuy(currentPlayerId, amount);
    if (!res.ok) return cb?.(res);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('addBot', (cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    if (room.game.phase === 'playing')
      return cb?.({ ok: false, error: 'Нельзя добавить бота во время раздачи' });
    if (room.game.players.length >= 9)
      return cb?.({ ok: false, error: 'Стол заполнен (макс. 9)' });
    room.botCounter = (room.botCounter || 0) + 1;
    const id = 'bot_' + room.code + '_' + room.botCounter;
    const name = BOT_NAMES[(room.botCounter - 1) % BOT_NAMES.length];
    room.game.addPlayer(id, name, true);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('removeBot', (cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    if (room.game.phase === 'playing')
      return cb?.({ ok: false, error: 'Нельзя убрать бота во время раздачи' });
    const bots = room.game.players.filter((p) => p.isBot);
    if (bots.length === 0) return cb?.({ ok: false, error: 'Ботов нет' });
    room.game.removePlayer(bots[bots.length - 1].id);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('setCardTheme', ({ theme } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const valid = theme === null || THEMES.includes(theme);
    if (!valid) return cb?.({ ok: false, error: 'Неизвестная тема' });
    const p = room.game.players.find((x) => x.id === currentPlayerId);
    if (p) p.cardTheme = theme; // null = «вперемешку»
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('transferChips', ({ toId, amount, tip } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.transferChips(currentPlayerId, toId, amount, !!tip);
    if (!res.ok) return cb?.(res);
    cb?.({ ok: true });
    broadcast(room);
  });

  let lastReaction = 0;
  socket.on('reaction', ({ emoji } = {}) => {
    const room = manager.getRoom(currentCode);
    if (!room || !REACTIONS.includes(emoji)) return;
    const now = Date.now();
    if (now - lastReaction < 350) return; // антиспам
    lastReaction = now;
    const p = room.game.players.find((x) => x.id === currentPlayerId);
    io.to(room.code).emit('reaction', { fromId: currentPlayerId, name: p?.name || '', emoji });
  });

  let lastChat = 0;
  socket.on('chat', ({ text } = {}) => {
    const room = manager.getRoom(currentCode);
    if (!room) return;
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return;
    const now = Date.now();
    if (now - lastChat < 300) return; // антиспам
    lastChat = now;
    const p = room.game.players.find((x) => x.id === currentPlayerId);
    io.to(room.code).emit('chat', { fromId: currentPlayerId, name: p?.name || 'Игрок', text: clean, ts: now });
  });

  socket.on('placeSideBet', ({ targetId, amount } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.placeSideBet(currentPlayerId, targetId, amount);
    if (!res.ok) return cb?.(res);
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('donateIsrael', (cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.donateIsrael(currentPlayerId);
    if (!res.ok) return cb?.(res);
    cb?.({ ok: true });
    broadcast(room);
  });

  // --- Действия Весёлого режима ---
  const funAction = (fn) => (cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = fn(room.game);
    if (!res.ok) return cb?.(res);
    cb?.(res);
    broadcast(room);
  };

  socket.on('denounce', funAction((g) => g.writeDenunciation()));
  socket.on('investStartup', funAction((g) => g.investStartup(currentPlayerId)));
  socket.on('buyThirdCard', funAction((g) => g.buyThirdCard(currentPlayerId)));
  socket.on('lobbyCountry', funAction((g) => g.lobbyCountry(currentPlayerId)));
  socket.on('openCasino', funAction((g) => g.openCasino(currentPlayerId)));

  socket.on('casinoPlay', ({ game, amount, opts } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.casinoPlay(currentPlayerId, game, amount, opts || {});
    if (!res.ok) return cb?.(res);
    cb?.(res);
    broadcast(room);
  });

  // --- Покерстан: казна, шекели, пособие, Цыганка ---
  socket.on('takeBenefit', funAction((g) => g.takeBenefit(currentPlayerId)));
  socket.on('removeMark', funAction((g) => g.removeMark(currentPlayerId)));
  socket.on('buyPokerstan', funAction((g) => g.buyPokerstan(currentPlayerId)));

  socket.on('buyShekel', ({ count } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.buyShekel(currentPlayerId, count || 1);
    if (!res.ok) return cb?.(res);
    cb?.(res);
    broadcast(room);
  });

  socket.on('transferShekels', ({ toId, count } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.transferShekels(currentPlayerId, toId, count);
    if (!res.ok) return cb?.(res);
    cb?.(res);
    broadcast(room);
  });

  socket.on('castVote', ({ lawId } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.castVote(currentPlayerId, lawId);
    if (!res.ok) return cb?.(res);
    cb?.(res);
    broadcast(room);
  });

  // --- Диктатор ---
  socket.on('castDictatorVote', ({ targetId } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.castDictatorVote(currentPlayerId, targetId);
    if (!res.ok) return cb?.(res);
    cb?.(res);
    broadcast(room);
  });

  socket.on('dictatorTreasury', ({ amount } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.dictatorTreasury(currentPlayerId, amount);
    if (!res.ok) return cb?.(res);
    cb?.(res);
    broadcast(room);
  });

  socket.on('dictatorEnactLaw', ({ lawId } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.dictatorEnactLaw(currentPlayerId, lawId);
    if (!res.ok) return cb?.(res);
    cb?.(res);
    broadcast(room);
  });

  socket.on('dictatorRemoveMark', ({ targetId } = {}, cb) => {
    const room = manager.getRoom(currentCode);
    if (!room) return cb?.({ ok: false, error: 'Нет комнаты' });
    const res = room.game.dictatorRemoveMark(currentPlayerId, targetId);
    if (!res.ok) return cb?.(res);
    cb?.(res);
    broadcast(room);
  });

  socket.on('bribeMVD', funAction((g) => g.bribeMVD(currentPlayerId)));

  socket.on('leaveRoom', (cb) => {
    leaveCurrent();
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    leaveCurrent();
  });
});

function cryptoId() {
  return 'p_' + Math.floor(Math.random() * 1e9).toString(36) + Date.now().toString(36);
}

server.listen(PORT, () => {
  const urls = localUrls(PORT);
  console.log('\n♠♥♦♣  Покер запущен!  ♣♦♥♠\n');
  console.log('Открой в браузере:');
  for (const u of urls) console.log('   ' + u);
  console.log('\nДрузьям в одной сети дай ссылку с твоим IP (не localhost).');
  console.log('Чтобы играть через интернет — прокинь порт наружу (см. README).\n');
});

function localUrls(port) {
  const urls = [`http://localhost:${port}`];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}
