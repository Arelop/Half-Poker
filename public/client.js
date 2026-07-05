/* global io */
const socket = io();

// Стабильный идентификатор игрока для переподключения после обновления страницы.
let playerId = localStorage.getItem('pokerPlayerId') || null;
let myName = localStorage.getItem('pokerName') || '';

let state = { pub: null, priv: null, you: null, code: null, hostId: null };
let raiseMode = false;

// Темы артов карт (приходят с сервера) и личный выбор игрока.
let themes = [];
let myCardTheme = localStorage.getItem('pokerCardTheme') || null;
if (myCardTheme === '') myCardTheme = null;

const $ = (id) => document.getElementById(id);

// ---------- Лобби ----------
const nameInput = $('nameInput');
nameInput.value = myName;

function readName() {
  const n = nameInput.value.trim().slice(0, 16);
  if (n) { myName = n; localStorage.setItem('pokerName', n); }
  return n || 'Игрок';
}

let selectedMode = 'classic';
document.querySelectorAll('.mode-opt').forEach((b) => {
  b.onclick = () => {
    selectedMode = b.dataset.mode;
    document.querySelectorAll('.mode-opt').forEach((x) => x.classList.toggle('selected', x === b));
  };
});

$('createBtn').onclick = () => {
  const settings = {
    smallBlind: Number($('sbInput').value),
    bigBlind: Number($('bbInput').value),
    startingChips: Number($('chipsInput').value),
    turnSeconds: Number($('turnInput').value),
    mode: selectedMode,
  };
  socket.emit('createRoom', { name: readName(), playerId, settings }, onJoined);
};

$('joinBtn').onclick = () => {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length < 4) return showLobbyError('Введите код из 4 символов');
  socket.emit('joinRoom', { code, name: readName(), playerId }, onJoined);
};

$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('createBtn').click(); });

// Автовход по ссылке ?room=CODE
const params = new URLSearchParams(location.search);
if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase();

function onJoined(res) {
  if (!res || !res.ok) return showLobbyError(res?.error || 'Не удалось войти');
  playerId = res.playerId;
  localStorage.setItem('pokerPlayerId', playerId);
  state.code = res.code;
  state.hostId = res.hostId;
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('codeCopy').textContent = res.code;
  history.replaceState(null, '', `?room=${res.code}`);
  // Сообщаем серверу выбранную тему карт (чтобы соперники видели рубашку).
  if (myCardTheme) socket.emit('setCardTheme', { theme: myCardTheme }, () => {});
}

function showLobbyError(msg) { $('lobbyError').textContent = msg; }

$('codeCopy').onclick = () => {
  const url = `${location.origin}?room=${state.code}`;
  navigator.clipboard?.writeText(url).then(() => {
    const el = $('codeCopy');
    const orig = el.textContent;
    el.textContent = 'Ссылка ✓';
    setTimeout(() => (el.textContent = orig), 1200);
  });
};

$('leaveBtn').onclick = () => {
  socket.emit('leaveRoom', () => {
    history.replaceState(null, '', location.pathname);
    location.reload();
  });
};

$('dealBtn').onclick = () => socket.emit('startHand', (res) => {
  if (res && !res.ok) flashHint(res.error);
});

$('addBotBtn').onclick = () => socket.emit('addBot', (res) => {
  if (res && !res.ok) flashHint(res.error);
});
$('removeBotBtn').onclick = () => socket.emit('removeBot', (res) => {
  if (res && !res.ok) flashHint(res.error);
});

// ---------- Действия ----------
$('foldBtn').onclick = () => sendAction('fold');
$('checkBtn').onclick = () => sendAction('check');
$('callBtn').onclick = () => sendAction('call');
$('raiseBtn').onclick = () => { raiseMode = true; render(); };
$('confirmRaiseBtn').onclick = () => {
  const to = Number($('betSlider').value);
  const type = to >= state.priv.maxRaiseTo ? 'allin' : 'raise';
  sendAction(type, to);
  raiseMode = false;
};

function sendAction(type, amount) {
  socket.emit('action', { type, amount }, (res) => {
    if (res && !res.ok) flashHint(res.error);
  });
  raiseMode = false;
}

$('betSlider').addEventListener('input', () => { $('betAmount').textContent = $('betSlider').value; });

document.querySelectorAll('.chip-btn').forEach((b) => {
  b.onclick = () => {
    const p = state.priv, pub = state.pub;
    if (!p) return;
    const pot = pub.pot;
    let to;
    if (b.dataset.preset === 'min') to = p.minRaiseTo;
    else if (b.dataset.preset === 'half') to = pub.currentBet + Math.round(pot / 2);
    else if (b.dataset.preset === 'pot') to = pub.currentBet + pot;
    else to = p.maxRaiseTo;
    to = Math.max(p.minRaiseTo, Math.min(p.maxRaiseTo, to));
    $('betSlider').value = to;
    $('betAmount').textContent = to;
  };
});

// ---------- Кнопка звука ----------
const soundBtn = $('soundBtn');
function refreshSoundIcon() { soundBtn.textContent = SFX.isMuted() ? '🔇' : '🔊'; }
soundBtn.onclick = () => { SFX.toggle(); refreshSoundIcon(); if (!SFX.isMuted()) SFX.ui(); };
refreshSoundIcon();

// ---------- Темы артов карт ----------
socket.on('config', (cfg) => {
  themes = cfg?.themes || [];
  buildThemePicker();
});

const THEME_LABELS = {
  battle_mages: 'Боевые маги',
  gangsters: 'Гангстеры',
  pirates: 'Пираты',
  cyberpunk: 'Киберпанк',
  imperial_russia: 'Имперская Россия',
  wild_west: 'Дикий Запад',
};
function themeLabel(t) {
  return THEME_LABELS[t] || t.replace(/_/g, ' ');
}

function buildThemePicker() {
  const grid = $('themeGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const opts = [{ key: null, label: 'Вперемешку' }, ...themes.map((t) => ({ key: t, label: themeLabel(t) }))];
  opts.forEach((o) => {
    const b = document.createElement('button');
    b.className = 'theme-opt';
    b.dataset.theme = o.key || '';
    const thumb = o.key
      ? `<img src="${backUrl(o.key)}" class="theme-thumb" alt="">`
      : `<div class="theme-thumb mixed">🎲</div>`;
    b.innerHTML = thumb + `<span>${o.label}</span>`;
    b.onclick = () => chooseTheme(o.key);
    grid.appendChild(b);
  });
  highlightTheme();
}
function highlightTheme() {
  document.querySelectorAll('#themeGrid .theme-opt').forEach((b) => {
    b.classList.toggle('selected', (b.dataset.theme || null) === (myCardTheme || null));
  });
}
function chooseTheme(theme) {
  myCardTheme = theme;
  localStorage.setItem('pokerCardTheme', theme || '');
  socket.emit('setCardTheme', { theme }, () => {});
  highlightTheme();
  SFX.chip(1);
  render(); // мгновенно обновить свои карты
}

if ($('artBtn')) $('artBtn').onclick = () => { buildThemePicker(); $('themeOverlay').classList.remove('hidden'); };
if ($('themeClose')) $('themeClose').onclick = () => $('themeOverlay').classList.add('hidden');
if ($('themeOverlay')) $('themeOverlay').addEventListener('click', (e) => {
  if (e.target === $('themeOverlay')) $('themeOverlay').classList.add('hidden');
});

// ---------- Передача фишек / чаевые ----------
let transferMode = 'transfer';
let transferTarget = null;

function openTransfer(mode) {
  transferMode = mode;
  transferTarget = null;
  $('transferError').textContent = '';
  $('transferTitle').textContent = mode === 'tip' ? 'Типануть 🪙' : 'Передать фишки 💸';

  // Получатели — все, кроме себя.
  const list = $('transferPlayers');
  list.innerHTML = '';
  (state.pub?.players || []).filter((p) => p.id !== state.you).forEach((p) => {
    const b = document.createElement('button');
    b.className = 'player-pick';
    b.innerHTML = `${p.isBot ? '🤖 ' : ''}${escapeHtml(p.name)}<span class="pp-chips">${p.chips} фишек</span>`;
    b.onclick = () => {
      transferTarget = p.id;
      [...list.children].forEach((c) => c.classList.remove('selected'));
      b.classList.add('selected');
    };
    list.appendChild(b);
  });

  // Пресеты сумм.
  const presets = mode === 'tip' ? [5, 10, 25, 50] : [50, 100, 250, 500];
  const pr = $('transferPresets');
  pr.innerHTML = '';
  presets.forEach((amt) => {
    const b = document.createElement('button');
    b.className = 'chip-btn';
    b.textContent = amt;
    b.onclick = () => { $('transferAmount').value = amt; };
    pr.appendChild(b);
  });

  $('transferAmount').value = mode === 'tip' ? 10 : '';
  $('transferOverlay').classList.remove('hidden');
}

function closeTransfer() { $('transferOverlay').classList.add('hidden'); }

$('transferBtn').onclick = () => openTransfer('transfer');
$('tipBtn').onclick = () => openTransfer('tip');
$('transferCancel').onclick = closeTransfer;
$('transferOverlay').addEventListener('click', (e) => {
  if (e.target === $('transferOverlay')) closeTransfer();
});
$('transferSend').onclick = () => {
  const amount = Math.floor(Number($('transferAmount').value));
  if (!transferTarget) return ($('transferError').textContent = 'Выбери игрока');
  if (!(amount > 0)) return ($('transferError').textContent = 'Введи сумму больше 0');
  socket.emit('transferChips', { toId: transferTarget, amount, tip: transferMode === 'tip' }, (res) => {
    if (res && !res.ok) { $('transferError').textContent = res.error; return; }
    SFX.chip(3);
    closeTransfer();
  });
};

// ---------- Докупка фишек (ребай) ----------
$('rebuyBtn').onclick = () => {
  const amount = state.pub?.startingChips || 1000;
  socket.emit('rebuy', { amount }, (res) => {
    if (res && !res.ok) flashHint(res.error);
    else SFX.chip(3);
  });
};

// ---------- Реакции-эмодзи ----------
const REACTION_EMOJIS = ['😎', '🤡', '😱', '🔥', '😂', '😡', '👏', '💩', '🃏', '🤑'];
function buildReactionsBar() {
  const bar = $('reactionsBar');
  if (!bar) return;
  bar.innerHTML = '';
  REACTION_EMOJIS.forEach((e) => {
    const b = document.createElement('button');
    b.className = 'react-btn';
    b.textContent = e;
    b.onclick = () => { socket.emit('reaction', { emoji: e }); bar.classList.add('hidden'); };
    bar.appendChild(b);
  });
}
buildReactionsBar();
// Смайлики — в отдельном выкидном меню.
$('emojiBtn').onclick = () => $('reactionsBar').classList.toggle('hidden');
// Выдвижное меню весёлого режима.
$('chaosToggle').onclick = () => { chaosOpen = !chaosOpen; renderChaos(); };

// Громкие объявления Весёлого режима (центральный тост)
let announceTimer;
socket.on('announce', (a) => {
  const el = $('announceToast');
  if (!el) return;
  el.innerHTML = `<span class="ann-emoji">${a.emoji || '🎉'}</span> ${escapeHtml(a.text)}`;
  el.classList.remove('hidden', 'ann-in');
  void el.offsetWidth;
  el.classList.add('ann-in');
  SFX.pop();
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => el.classList.add('hidden'), 4500);
});

socket.on('reaction', ({ fromId, emoji }) => { spawnFloatingEmoji(fromId, emoji); SFX.pop(); });
function spawnFloatingEmoji(fromId, emoji) {
  const seat = [...document.querySelectorAll('.seat')].find((s) => s.dataset.id === fromId);
  const rect = seat
    ? seat.getBoundingClientRect()
    : { left: innerWidth / 2, top: innerHeight / 2, width: 0 };
  const el = document.createElement('div');
  el.className = 'float-emoji';
  el.textContent = emoji;
  el.style.left = rect.left + rect.width / 2 + 'px';
  el.style.top = rect.top + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

// ---------- Чат ----------
let chatOpen = false;
const chatMessages = [];
$('chatBtn').onclick = () => {
  chatOpen = !chatOpen;
  $('chatPanel').classList.toggle('hidden', !chatOpen);
  if (chatOpen) { $('chatDot').classList.add('hidden'); renderChat(); $('chatInput').focus(); }
};
$('chatCloseBtn').onclick = () => { chatOpen = false; $('chatPanel').classList.add('hidden'); };
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('chatInput').value.trim();
  if (!t) return;
  socket.emit('chat', { text: t });
  $('chatInput').value = '';
});
socket.on('chat', (msg) => {
  chatMessages.push(msg);
  if (chatMessages.length > 100) chatMessages.shift();
  if (chatOpen) renderChat();
  else { $('chatDot').classList.remove('hidden'); SFX.pop(); }
});
function renderChat() {
  const box = $('chatMessages');
  box.innerHTML = chatMessages
    .map((m) => `<div class="chat-msg${m.fromId === state.you ? ' mine' : ''}"><b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}</div>`)
    .join('');
  box.scrollTop = box.scrollHeight;
}

// ---------- Режим хаоса ----------
function canSideBet(pub) {
  return pub.phase === 'playing' && ['preflop', 'flop', 'turn'].includes(pub.street);
}
let chaosOpen = window.innerWidth > 700; // выдвижное меню: на десктопе открыто, на телефоне спрятано
function renderChaos() {
  const pub = state.pub;
  const menu = $('chaosMenu');
  if (!menu) return;
  const fun = pub.mode === 'fun';
  $('chaosToggle').classList.toggle('hidden', !fun);
  if (!fun) { menu.classList.add('hidden'); menu.classList.remove('open'); return; }
  menu.classList.remove('hidden');
  menu.classList.toggle('open', chaosOpen);
  $('chaosToggle').classList.toggle('open', chaosOpen);
  $('chaosToggle').textContent = chaosOpen ? '✕' : '🎉';

  $('rebuyBtn').style.display = 'none'; // в весёлом режиме докупки нет

  const playing = pub.phase === 'playing';
  const me = pub.players.find((p) => p.id === state.you) || {};

  // Ставка на победителя — до ривера.
  $('sideBetBtn').disabled = !canSideBet(pub);

  // Донат в Израиль — когда есть свои фишки (сумма скрыта).
  const myChips = me.chips || 0;
  $('donateBtn').disabled = !(playing && Math.floor(myChips * 0.1) > 0);
  $('donateLabel').textContent = 'В Израиль';

  // Донос — во время раздачи, если проверки нет и инспектор не отдыхает.
  const cd = pub.denounceCooldown || 0;
  $('denounceBtn').disabled = !(playing && !pub.taxAudit && cd === 0);
  $('denounceLabel').textContent = pub.taxAudit
    ? 'Проверка идёт…'
    : cd > 0 ? `Инспектор отдыхает: ${cd}` : 'Донос в налоговую';

  // Инвестиция в стартап — если вложения ещё нет (сумма скрыта, от своих фишек).
  $('investBtn').disabled = !(playing && Math.floor(myChips * 0.5) > 0 && me.investHandsLeft == null);
  $('investLabel').textContent = me.investHandsLeft != null
    ? `Стартап: итог через ${me.investHandsLeft}`
    : 'Инвестировать в стартап';

  // Лоббирование — один раз (сумма скрыта, текст полный).
  $('lobbyBtn').disabled = !(playing && !me.lobbyTitle);
  $('lobbyLabel').textContent = me.lobbyTitle
    ? `${me.lobbyFlag} ${me.lobbyTitle}`
    : 'Лоббировать интересы неизвестной страны';

  // Казино — стоимость показываем (2500). С меткой лоха недоступно.
  const marked = !!me.loserMark;
  if (pub.casino) {
    $('casinoBtn').disabled = marked;
    $('casinoLabel').textContent = marked ? '🎰 Казино (метка лоха)' : `🎰 Казино (${pub.casino.ownerName})`;
  } else {
    $('casinoBtn').disabled = marked || (me.chips || 0) < 2500;
    $('casinoLabel').textContent = 'Открыть казино −2500';
  }

  // --- Покерстан ---
  $('treasuryVal').textContent = pub.treasury || 0;
  $('myShekels').textContent = me.shekels || 0;
  $('shopStock').textContent = pub.shekelShop != null ? pub.shekelShop : 0;

  // Финальная задача — купить Покерстан.
  const price = pub.pokerstanPrice || 1000000;
  if (pub.pokerstanWinner) {
    $('buyPokerstanBtn').disabled = true;
    $('buyPokerstanLabel').textContent = `🏆 Победитель: ${pub.pokerstanWinner.name}`;
    const vb = $('victoryBanner');
    vb.innerHTML = `🏆 ${escapeHtml(pub.pokerstanWinner.name)} купил ПОКЕРСТАН и победил! 🏆`;
    vb.classList.remove('hidden');
  } else {
    $('buyPokerstanBtn').disabled = (me.chips || 0) < price;
    $('buyPokerstanLabel').textContent = `Купить Покерстан ($${price.toLocaleString('ru-RU')})`;
    $('victoryBanner').classList.add('hidden');
  }

  // Пособие для лохов — если у тебя 0$ и в казне есть деньги.
  $('benefitBtn').disabled = !((me.chips || 0) === 0 && (pub.treasury || 0) > 0);

  // Магазин шекелей — всегда доступен.
  $('shekelShopBtn').disabled = false;

  // Цыганка — только если есть метка.
  $('gypsyBtn').style.display = marked ? '' : 'none';

  // Живое обновление открытого магазина шекелей.
  if (!$('shekelOverlay').classList.contains('hidden')) {
    $('shekelStock2').textContent = pub.shekelShop || 0;
    $('shekelMine2').textContent = me.shekels || 0;
  }

  // --- Политика ---
  const pol = pub.politics || {};
  if (pol.cycle !== lastVoteCycle) { myVote = null; lastVoteCycle = pol.cycle; }
  const canVote = pol.open && me.eligibleVoter && !marked;
  $('voteBtn').disabled = !canVote;
  $('voteLabel').textContent = !pol.open
    ? 'Голосование закрыто'
    : marked ? 'Голосование (метка лоха)'
    : !me.eligibleVoter ? 'Голосуют богатейшие'
    : `Голосование (${pol.handsLeft} к.)${me.hasVoted ? ' ✓' : ''}`;
  const al = $('activeLaws');
  const alLaws = (pub.activeLaws || []).slice();
  if (pub.dictator) alLaws.unshift({ name: `👑 Диктатор ${pub.dictator.name}`, handsLeft: pub.dictator.handsLeft });
  al.innerHTML = alLaws.length
    ? '<div class="al-title">Действуют:</div>' +
      alLaws.map((l) => `<div class="al-row">${escapeHtml(l.name)} <span>${l.handsLeft}к.</span></div>`).join('')
    : '';

  // --- Диктатор ---
  const elec = pub.dictatorElection;
  if (elec) {
    $('voteBtn').disabled = !(me.eligibleVoter && !marked);
    $('voteLabel').textContent = `👑 Выборы диктатора (${elec.handsLeft} к.)${me.hasVotedDictator ? ' ✓' : ''}`;
  }
  $('dictatorBtn').style.display = pub.dictator && pub.dictator.id === state.you ? '' : 'none';
  $('bribeBtn').style.display = pub.dictator ? '' : 'none';
  if (pub.dictator) $('bribeBtn').disabled = (me.shekels || 0) < 5;
  if (!$('dictatorOverlay').classList.contains('hidden')) $('dictTreasury').textContent = pub.treasury || 0;

  if (!$('voteOverlay').classList.contains('hidden')) renderVoteModal();

  // Список текущих ставок.
  const list = $('sideBetList');
  const bets = pub.sideBets || [];
  list.innerHTML = bets.length
    ? '<div class="sbl-title">Ставки:</div>' +
      bets.map((b) => `<div class="sbl-row">${escapeHtml(b.bettor || '?')} → <b>${escapeHtml(b.target || '?')}</b>: ${b.amount}</div>`).join('')
    : '<div class="sbl-empty">Ставок пока нет</div>';
}

// Модалка ставки на победителя
let sideBetTarget = null;
$('sideBetBtn').onclick = () => {
  const pub = state.pub;
  if (!canSideBet(pub)) return flashHint('Ставить можно только до ривера');
  sideBetTarget = null;
  $('sideBetError').textContent = '';
  const list = $('sideBetPlayers');
  list.innerHTML = '';
  pub.players.filter((p) => p.inHand && !p.folded).forEach((p) => {
    const b = document.createElement('button');
    b.className = 'player-pick';
    b.innerHTML = `${p.isBot ? '🤖 ' : ''}${escapeHtml(p.name)}<span class="pp-chips">${p.chips} фишек</span>`;
    b.onclick = () => {
      sideBetTarget = p.id;
      [...list.children].forEach((c) => c.classList.remove('selected'));
      b.classList.add('selected');
    };
    list.appendChild(b);
  });
  const pr = $('sideBetPresets');
  pr.innerHTML = '';
  [25, 50, 100, 250].forEach((amt) => {
    const b = document.createElement('button');
    b.className = 'chip-btn';
    b.textContent = amt;
    b.onclick = () => { $('sideBetAmount').value = amt; };
    pr.appendChild(b);
  });
  $('sideBetAmount').value = '';
  $('sideBetOverlay').classList.remove('hidden');
};
$('sideBetCancel').onclick = () => $('sideBetOverlay').classList.add('hidden');
$('sideBetOverlay').addEventListener('click', (e) => {
  if (e.target === $('sideBetOverlay')) $('sideBetOverlay').classList.add('hidden');
});
$('sideBetSend').onclick = () => {
  const amount = Math.floor(Number($('sideBetAmount').value));
  if (!sideBetTarget) return ($('sideBetError').textContent = 'Выбери, на кого ставишь');
  if (!(amount > 0)) return ($('sideBetError').textContent = 'Введи сумму больше 0');
  socket.emit('placeSideBet', { targetId: sideBetTarget, amount }, (res) => {
    if (res && !res.ok) { $('sideBetError').textContent = res.error; return; }
    SFX.chip(2);
    $('sideBetOverlay').classList.add('hidden');
  });
};

// Модалка доната «в Израиль»
$('donateBtn').onclick = () => {
  const me = state.pub.players.find((p) => p.id === state.you) || {};
  const amt = Math.floor((me.chips || 0) * 0.1);
  if (amt <= 0) return flashHint('Мало фишек');
  $('donateSub').textContent = 'Ты потеряешь 10% своих фишек. Точно?';
  $('donateOverlay').classList.remove('hidden');
};
$('donateCancel').onclick = () => $('donateOverlay').classList.add('hidden');
$('donateOverlay').addEventListener('click', (e) => {
  if (e.target === $('donateOverlay')) $('donateOverlay').classList.add('hidden');
});
$('donateConfirm').onclick = () => {
  socket.emit('donateIsrael', (res) => {
    if (res && !res.ok) flashHint(res.error);
    else SFX.chip(4);
    $('donateOverlay').classList.add('hidden');
  });
};

// Прочие действия Весёлого режима
$('denounceBtn').onclick = () => socket.emit('denounce', (r) => { if (r && !r.ok) flashHint(r.error); });
$('investBtn').onclick = () => socket.emit('investStartup', (r) => { if (r && !r.ok) flashHint(r.error); else SFX.chip(3); });
$('lobbyBtn').onclick = () => socket.emit('lobbyCountry', (r) => { if (r && !r.ok) flashHint(r.error); else SFX.chip(2); });
$('casinoBtn').onclick = () => {
  if (state.pub.casino) openCasinoModal();
  else socket.emit('openCasino', (r) => { if (r && !r.ok) flashHint(r.error); else SFX.win(); });
};

// ---------- Казино ----------
let casinoGame = 'roulette';
let rouletteBetType = 'red';
function openCasinoModal() {
  $('casinoResult').textContent = '';
  $('casinoError').textContent = '';
  const pr = $('casinoPresets');
  pr.innerHTML = '';
  [25, 50, 100, 250].forEach((amt) => {
    const b = document.createElement('button');
    b.className = 'chip-btn';
    b.textContent = amt;
    b.onclick = () => { $('casinoBet').value = amt; };
    pr.appendChild(b);
  });
  $('casinoOverlay').classList.remove('hidden');
}
document.querySelectorAll('.casino-tab').forEach((t) => {
  t.onclick = () => {
    casinoGame = t.dataset.game;
    document.querySelectorAll('.casino-tab').forEach((x) => x.classList.toggle('selected', x === t));
    $('rouletteOpts').classList.toggle('hidden', casinoGame !== 'roulette');
  };
});
document.querySelectorAll('.bet-type').forEach((t) => {
  t.onclick = () => {
    rouletteBetType = t.dataset.bt;
    document.querySelectorAll('.bet-type').forEach((x) => x.classList.toggle('selected', x === t));
    $('rouletteNumber').classList.toggle('hidden', rouletteBetType !== 'number');
  };
});
$('casinoClose').onclick = () => $('casinoOverlay').classList.add('hidden');
$('casinoSpin').onclick = () => {
  const amount = Math.floor(Number($('casinoBet').value));
  if (!(amount > 0)) return ($('casinoError').textContent = 'Введи ставку');
  $('casinoError').textContent = '';
  const opts = {};
  if (casinoGame === 'roulette') {
    opts.betType = rouletteBetType;
    if (rouletteBetType === 'number') opts.number = Math.floor(Number($('rouletteNumber').value));
  }
  socket.emit('casinoPlay', { game: casinoGame, amount, opts }, (res) => {
    if (res && !res.ok) { $('casinoError').textContent = res.error; return; }
    const r = res.result;
    const net = res.net;
    $('casinoResult').innerHTML = `<div class="cr-text">${escapeHtml(r.text)}</div><div class="cr-net ${net >= 0 ? 'win' : 'lose'}">${net >= 0 ? '+' + net : net}</div>`;
    if (net > 0) SFX.win(); else SFX.pop();
  });
};

// ---------- Покерстан: пособие, шекели, Цыганка ----------
$('buyPokerstanBtn').onclick = () => socket.emit('buyPokerstan', (r) => { if (r && !r.ok) flashHint(r.error); else SFX.win(); });
$('benefitBtn').onclick = () => socket.emit('takeBenefit', (r) => { if (r && !r.ok) flashHint(r.error); else SFX.chip(3); });
$('gypsyBtn').onclick = () => socket.emit('removeMark', (r) => { if (r && !r.ok) flashHint(r.error); else SFX.win(); });

let shekelTarget = null;
function openShekelShop() {
  const pub = state.pub;
  const me = pub.players.find((p) => p.id === state.you) || {};
  $('shekelStock2').textContent = pub.shekelShop || 0;
  $('shekelMine2').textContent = me.shekels || 0;
  $('shekelError').textContent = '';
  shekelTarget = null;
  const list = $('shekelPlayers');
  list.innerHTML = '';
  pub.players.filter((p) => p.id !== state.you).forEach((p) => {
    const b = document.createElement('button');
    b.className = 'player-pick';
    b.innerHTML = `${p.isBot ? '🤖 ' : ''}${escapeHtml(p.name)}<span class="pp-chips">🪙 ${p.shekels || 0}</span>`;
    b.onclick = () => {
      shekelTarget = p.id;
      [...list.children].forEach((c) => c.classList.remove('selected'));
      b.classList.add('selected');
    };
    list.appendChild(b);
  });
  $('shekelOverlay').classList.remove('hidden');
}
$('shekelShopBtn').onclick = openShekelShop;
$('shekelClose').onclick = () => $('shekelOverlay').classList.add('hidden');
$('shekelOverlay').addEventListener('click', (e) => {
  if (e.target === $('shekelOverlay')) $('shekelOverlay').classList.add('hidden');
});
$('shekelBuyBtn').onclick = () => {
  const count = Math.floor(Number($('shekelBuyCount').value));
  if (!(count > 0)) return ($('shekelError').textContent = 'Сколько покупаем?');
  socket.emit('buyShekel', { count }, (r) => {
    if (r && !r.ok) { $('shekelError').textContent = r.error; return; }
    SFX.chip(3);
  });
};
$('shekelSendBtn').onclick = () => {
  const count = Math.floor(Number($('shekelSendCount').value));
  if (!shekelTarget) return ($('shekelError').textContent = 'Выбери игрока');
  if (!(count > 0)) return ($('shekelError').textContent = 'Сколько передаём?');
  socket.emit('transferShekels', { toId: shekelTarget, count }, (r) => {
    if (r && !r.ok) { $('shekelError').textContent = r.error; return; }
    SFX.chip(2);
  });
};

// ---------- Голосование за закон / выборы диктатора ----------
let myVote = null;
let myDictVote = null;
let lastVoteCycle = null;
function renderVoteModal() {
  const pub = state.pub;
  const box = $('voteLaws');
  box.innerHTML = '';
  const elec = pub.dictatorElection;

  if (elec) {
    // Выборы диктатора — голосуем за человека.
    document.querySelector('#voteOverlay h3').textContent = '👑 Выборы диктатора';
    $('voteStatus').textContent = `Тайно. Проголосовали: ${elec.votedCount}/${elec.eligibleCount}. Осталось ${elec.handsLeft} конов.`;
    pub.players.forEach((pl) => {
      const b = document.createElement('button');
      b.className = 'vote-law' + (myDictVote === pl.id ? ' selected' : '');
      b.textContent = (pl.isBot ? '🤖 ' : '') + pl.name;
      b.onclick = () => socket.emit('castDictatorVote', { targetId: pl.id }, (r) => {
        if (r && !r.ok) { $('voteError').textContent = r.error; return; }
        myDictVote = pl.id;
        $('voteError').textContent = '';
        SFX.ui();
        renderVoteModal();
      });
      box.appendChild(b);
    });
    return;
  }

  const pol = pub.politics || {};
  document.querySelector('#voteOverlay h3').textContent = '🗳️ Голосование за закон';
  $('voteStatus').textContent = pol.open
    ? `Тайно. Проголосовали: ${pol.votedCount}/${pol.eligibleCount}. Осталось ${pol.handsLeft} конов.`
    : 'Голосование закрыто.';
  (pol.laws || []).forEach((l) => {
    const b = document.createElement('button');
    b.className = 'vote-law' + (myVote === l.id ? ' selected' : '');
    b.textContent = l.name;
    b.disabled = !pol.open;
    b.onclick = () => socket.emit('castVote', { lawId: l.id }, (r) => {
      if (r && !r.ok) { $('voteError').textContent = r.error; return; }
      myVote = l.id;
      $('voteError').textContent = '';
      SFX.ui();
      renderVoteModal();
    });
    box.appendChild(b);
  });
}
$('voteBtn').onclick = () => { $('voteError').textContent = ''; renderVoteModal(); $('voteOverlay').classList.remove('hidden'); };
$('voteClose').onclick = () => $('voteOverlay').classList.add('hidden');
$('voteOverlay').addEventListener('click', (e) => { if (e.target === $('voteOverlay')) $('voteOverlay').classList.add('hidden'); });

// ---------- Меню диктатора и подкуп МВД ----------
function openDictatorMenu() {
  const pub = state.pub;
  $('dictTreasury').textContent = pub.treasury || 0;
  $('dictAmount').value = '';
  $('dictError').textContent = '';
  const lawBox = $('dictLaws');
  lawBox.innerHTML = '';
  (pub.politics?.laws || []).filter((l) => l.id !== 'elect_dictator').forEach((l) => {
    const b = document.createElement('button');
    b.className = 'vote-law';
    b.textContent = l.name;
    b.onclick = () => socket.emit('dictatorEnactLaw', { lawId: l.id }, (r) => {
      if (r && !r.ok) { $('dictError').textContent = r.error; return; }
      SFX.pop();
    });
    lawBox.appendChild(b);
  });
  const mk = $('dictMarked');
  mk.innerHTML = '';
  const marked = pub.players.filter((p) => p.loserMark);
  if (marked.length === 0) mk.innerHTML = '<div class="sbl-empty">Меченых нет</div>';
  else marked.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'player-pick';
    b.textContent = p.name;
    b.onclick = () => socket.emit('dictatorRemoveMark', { targetId: p.id }, (r) => {
      if (r && !r.ok) { $('dictError').textContent = r.error; return; }
      SFX.ui();
      openDictatorMenu();
    });
    mk.appendChild(b);
  });
  $('dictatorOverlay').classList.remove('hidden');
}
$('dictatorBtn').onclick = openDictatorMenu;
$('dictClose').onclick = () => $('dictatorOverlay').classList.add('hidden');
$('dictatorOverlay').addEventListener('click', (e) => { if (e.target === $('dictatorOverlay')) $('dictatorOverlay').classList.add('hidden'); });
$('dictTake').onclick = () => {
  const a = Math.floor(Number($('dictAmount').value));
  if (!(a > 0)) return ($('dictError').textContent = 'Введи сумму');
  socket.emit('dictatorTreasury', { amount: a }, (r) => { if (r && !r.ok) { $('dictError').textContent = r.error; return; } SFX.chip(3); });
};
$('dictDeposit').onclick = () => {
  const a = Math.floor(Number($('dictAmount').value));
  if (!(a > 0)) return ($('dictError').textContent = 'Введи сумму');
  socket.emit('dictatorTreasury', { amount: -a }, (r) => { if (r && !r.ok) { $('dictError').textContent = r.error; return; } SFX.chip(2); });
};
$('bribeBtn').onclick = () => socket.emit('bribeMVD', (r) => { if (r && !r.ok) flashHint(r.error); else SFX.allin(); });

// ---------- Увеличение карты по клику ----------
function openCardZoom(card) {
  if (document.querySelector('.zoom-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'zoom-overlay';
  const big = card.cloneNode(true);
  big.classList.remove('small');
  overlay.appendChild(big);
  const hint = document.createElement('div');
  hint.className = 'zoom-hint';
  hint.textContent = 'Нажми, чтобы закрыть';
  overlay.appendChild(hint);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
  SFX.ui();
}
document.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card || card.closest('.zoom-overlay') || card.classList.contains('back')) return;
  openCardZoom(card);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelector('.zoom-overlay')?.remove();
});

// ---------- Озвучка по изменениям состояния ----------
let sndPrev = null;
function classifyLine(line) {
  if (/олл-ин/i.test(line)) return SFX.allin();
  if (/выигрывает|забирает банк/i.test(line)) return; // победа звучит по смене фазы
  if (/передал|типанул/i.test(line)) return SFX.chip(3); // перевод фишек
  if (/^—/.test(line) || /началась/i.test(line)) return; // служебные строки
  if (/чек/i.test(line)) return SFX.check();
  if (/колл/i.test(line)) return SFX.call();
  if (/\bбет\b|рейз/i.test(line)) return SFX.raise();
  if (/сбросил/i.test(line)) return SFX.fold();
}
function playSounds(pub, priv) {
  const cur = {
    logLen: (pub.log || []).length,
    community: (pub.community || []).length,
    yourTurn: !!priv?.yourTurn,
    phase: pub.phase,
    handNumber: pub.handNumber,
  };
  if (!sndPrev) { sndPrev = cur; return; } // база при первом состоянии (без залпа)

  if (cur.handNumber !== sndPrev.handNumber && pub.phase === 'playing') SFX.deal(2);
  if (cur.community > sndPrev.community) SFX.deal(cur.community - sndPrev.community);

  const newLines = (pub.log || []).slice(sndPrev.logLen);
  if (newLines.length && newLines.length <= 2) newLines.forEach(classifyLine);

  if (cur.yourTurn && !sndPrev.yourTurn) SFX.turn();

  if (cur.phase === 'handover' && sndPrev.phase !== 'handover' && pub.results) {
    const youWon = (pub.results.winners || []).some((w) => w.id === state.you);
    if (youWon) SFX.win();
    else if (pub.results.winners?.length) SFX.lose();
  }
  sndPrev = cur;
}

// ---------- Таймер хода ----------
let turnClock = null; // { endAt (performance.now), total, activeId }
function setTurnClock(data) {
  if (data.turnMs != null && data.pub.phase === 'playing') {
    turnClock = { endAt: performance.now() + data.turnMs, total: data.turnTotal, activeId: data.pub.toActId };
  } else {
    turnClock = null;
  }
}
function timerLoop() {
  requestAnimationFrame(timerLoop);
  const bar = $('turnBar');
  if (!turnClock) { if (bar) bar.classList.add('hidden'); return; }
  const remaining = Math.max(0, turnClock.endAt - performance.now());
  const frac = turnClock.total ? remaining / turnClock.total : 0;
  const secs = Math.ceil(remaining / 1000);
  const danger = secs <= 5;

  const badge = document.querySelector('.turn-badge');
  if (badge) {
    const color = danger ? 'var(--red)' : 'var(--gold)';
    badge.style.background = `conic-gradient(${color} ${frac * 360}deg, rgba(0,0,0,.45) 0deg)`;
    const s = badge.querySelector('span');
    if (s) s.textContent = secs;
  }
  // Полоса на своих контролах.
  if (bar) {
    const mine = turnClock.activeId === state.you;
    bar.classList.toggle('hidden', !mine);
    if (mine) {
      const fill = $('turnBarFill');
      fill.style.width = frac * 100 + '%';
      fill.style.background = danger ? 'var(--red)' : 'var(--gold)';
    }
  }
}
requestAnimationFrame(timerLoop);

// ---------- Получение состояния ----------
socket.on('state', (data) => {
  state.pub = data.pub;
  state.priv = data.priv;
  state.you = data.you;
  state.code = data.code;
  setTurnClock(data);
  playSounds(data.pub, data.priv);
  render();
});

socket.on('connect', () => {
  // Переподключение: если уже были в комнате — заходим снова автоматически.
  if (state.code && playerId) {
    socket.emit('joinRoom', { code: state.code, name: myName, playerId }, () => {});
  }
});

// ---------- Отрисовка карт ----------
const SUIT_FILE = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
function rankSym(r) { return RANK_SYM[r] || String(r); }
function frontUrl(theme, card) {
  return `/art/${encodeURIComponent(theme)}/jpg_fronts/${rankSym(card.rank)}_${SUIT_FILE[card.suit]}.jpg`;
}
function backUrl(theme) { return `/art/${encodeURIComponent(theme)}/jpg_backs/card_back.jpg`; }
function defaultTheme() { return themes[0] || null; }

function addImg(cardDiv, url) {
  const img = document.createElement('img');
  img.className = 'card-img';
  img.src = url;
  img.alt = '';
  img.onerror = () => img.remove(); // откат к масти/индексу, если картинка не загрузилась
  cardDiv.appendChild(img);
}

// card === null -> рубашка (opts.backTheme). Иначе объект {rank,suit,art};
// opts.art переопределяет тему фронта.
function cardEl(card, cls = '', opts = {}) {
  const d = document.createElement('div');
  d.className = 'card ' + cls;
  if (card === null) {
    d.classList.add('back');
    const theme = opts.backTheme || defaultTheme();
    if (theme) addImg(d, backUrl(theme));
    return d;
  }
  const suit = card.suit;
  if (suit === 'h' || suit === 'd') d.classList.add('red');
  d.innerHTML = `<span class="c-corner">${rankSym(card.rank)}<br>${SUIT_SYM[suit]}</span><span class="c-pip">${SUIT_SYM[suit]}</span>`;
  const art = opts.art || card.art;
  if (art) addImg(d, frontUrl(art, card));
  return d;
}

function render() {
  const pub = state.pub;
  if (!pub) return;

  $('streetLabel').textContent = streetName(pub.street, pub.phase);
  $('handNum').textContent = pub.handNumber ? `Раздача #${pub.handNumber}` : '';

  // Общие карты (арт у каждой свой — «вперемешку»)
  const comm = $('community');
  comm.innerHTML = '';
  (pub.communityRaw || []).forEach((c) => comm.appendChild(cardEl(c)));

  // Банк
  $('potDisplay').textContent = pub.pot ? `Банк: ${pub.pot}` : '';

  renderSeats();
  renderResult();
  renderControls();
  renderLog();
  renderChaos();
}

function renderSeats() {
  const pub = state.pub;
  const seats = $('seats');
  seats.innerHTML = '';
  const players = pub.players;
  const n = players.length;
  const youIdx = players.findIndex((p) => p.id === state.you);
  const revealed = {};
  if (pub.results?.revealed) pub.results.revealed.forEach((r) => (revealed[r.id] = r));
  const winnerIds = new Set((pub.results?.winners || []).map((w) => w.id));

  players.forEach((p, i) => {
    // Смещаем так, чтобы «ты» был внизу по центру.
    const d = (i - youIdx + n) % n;
    const theta = Math.PI / 2 + (d * 2 * Math.PI) / n;
    // Кресла разведены по овалу; соперники компактные, поэтому не наслаиваются.
    const x = 50 + 47 * Math.cos(theta);
    const y = 50 + 36 * Math.sin(theta);

    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.dataset.id = p.id;
    if (p.id === state.you) seat.classList.add('you');
    if (p.folded) seat.classList.add('folded');
    if (pub.toActId === p.id) seat.classList.add('active');
    if (!p.connected) seat.classList.add('disconnected');
    seat.style.left = x + '%';
    seat.style.top = y + '%';

    // Карты игрока
    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'seat-cards';
    if (p.id === state.you && state.priv?.holeCardsRaw?.length) {
      // Свои карты — крупные, в личной теме (или «вперемешку», если не выбрана).
      state.priv.holeCardsRaw.forEach((c) =>
        cardsWrap.appendChild(cardEl(c, 'mine', { art: myCardTheme || undefined })));
    } else if (revealed[p.id]) {
      // Вскрытые карты — в теме их владельца.
      revealed[p.id].holeCards.forEach((c) =>
        cardsWrap.appendChild(cardEl(c, 'small', { art: p.cardTheme || undefined })));
    } else if (p.auditCards) {
      // Карты «под проверкой налоговой» — открыты всем.
      p.auditCards.forEach((c) =>
        cardsWrap.appendChild(cardEl(c, 'small', { art: p.cardTheme || undefined })));
    } else if (p.hasCards) {
      // Закрытые карты — рубашка в теме владельца.
      const bt = p.cardTheme || defaultTheme();
      cardsWrap.appendChild(cardEl(null, 'small', { backTheme: bt }));
      cardsWrap.appendChild(cardEl(null, 'small', { backTheme: bt }));
    }
    seat.appendChild(cardsWrap);

    const box = document.createElement('div');
    box.className = 'seat-box';
    box.innerHTML = `
      <div class="seat-name">${p.isBot ? '🤖 ' : ''}${escapeHtml(p.name)}${winnerIds.has(p.id) ? ' 🏆' : ''}</div>
      <div class="seat-chips">${p.chips} фишек</div>
      <div class="seat-status ${p.allIn ? 'allin' : ''}">${seatStatus(p, pub)}</div>
    `;
    if (p.streetBet > 0) {
      const bet = document.createElement('div');
      bet.className = 'seat-bet';
      bet.textContent = p.streetBet;
      box.appendChild(bet);
    }
    if (pub.buttonId === p.id) {
      const btn = document.createElement('div');
      btn.className = 'dealer-btn';
      btn.textContent = 'D';
      box.appendChild(btn);
    }
    // Звезда Давида у самого щедрого «донатера» (Весёлый режим).
    if (pub.mode === 'fun' && pub.topDonorId === p.id) {
      const star = document.createElement('div');
      star.className = 'david-star';
      star.textContent = '✡️';
      star.title = `Больше всех отправил в Израиль: ${p.donated}`;
      box.appendChild(star);
    }
    // Значки Весёлого режима.
    if (pub.mode === 'fun') {
      const addBadge = (cls, emoji, title) => {
        const el = document.createElement('div');
        el.className = 'fun-badge ' + cls;
        el.textContent = emoji;
        el.title = title;
        box.appendChild(el);
      };
      if (pub.taxAudit && pub.taxAudit.targetId === p.id) addBadge('audit', '🕵️', 'Под проверкой налоговой — карты открыты');
      if (p.investHandsLeft != null) addBadge('invest', '📈', `Стартап: итог через ${p.investHandsLeft} разд.`);
      if (pub.casino && pub.casino.ownerId === p.id) addBadge('casino', '🎰', 'Владелец казино');
      if (pub.pokerstanWinner && pub.pokerstanWinner.id === p.id) {
        addBadge('crown', '🏆', 'Победитель — купил Покерстан');
      }
      if (pub.dictator && pub.dictator.id === p.id) {
        addBadge('crown', '👑', 'Диктатор Покерстана');
        const dt = document.createElement('div');
        dt.className = 'seat-lobby dict-tag';
        dt.textContent = '👑 Диктатор Покерстана';
        box.appendChild(dt);
      }
      if (p.shekels > 0) {
        const sh = document.createElement('div');
        sh.className = 'fun-badge shekel';
        sh.textContent = `🪙${p.shekels}`;
        sh.title = `${p.shekels} золотых шекелей`;
        box.appendChild(sh);
      }
      if (p.loserMark) {
        seat.classList.add('marked');
        const tag = document.createElement('div');
        tag.className = 'seat-lobby mark-tag';
        tag.textContent = '🚫 Гражданин Покерстана 2 сорта';
        box.appendChild(tag);
      }
      if (p.lobbyTitle) {
        const lob = document.createElement('div');
        lob.className = 'seat-lobby';
        lob.textContent = `${p.lobbyFlag} ${p.lobbyTitle}`;
        box.appendChild(lob);
      }
    }
    // Бейдж-таймер на активном игроке.
    if (pub.toActId === p.id && turnClock) {
      const badge = document.createElement('div');
      badge.className = 'turn-badge';
      badge.innerHTML = '<span></span>';
      box.appendChild(badge);
    }
    seat.appendChild(box);
    seats.appendChild(seat);
  });
}

function seatStatus(p, pub) {
  if (!p.inHand) return 'ждёт';
  if (p.folded) return 'пас';
  if (p.allIn) return 'олл-ин';
  if (pub.toActId === p.id) return 'ходит…';
  return '';
}

function renderResult() {
  const banner = $('resultBanner');
  const r = state.pub.results;
  if (r && (state.pub.phase === 'handover')) {
    let text = '';
    if (r.showdown && r.winners.length) {
      text = r.winners.map((w) => `${w.name}: +${w.amount}${w.hand ? ' (' + w.hand + ')' : ''}`).join('<br>');
    } else if (r.winners.length) {
      text = `${r.winners[0].name} забирает банк +${r.winners[0].amount}`;
    }
    banner.innerHTML = text;
    banner.classList.toggle('hidden', !text);
  } else {
    banner.classList.add('hidden');
  }
}

function renderControls() {
  const pub = state.pub, priv = state.priv;
  const controls = $('controls');
  const host = $('hostControls');

  const playing = pub.phase === 'playing';
  const myTurn = priv?.yourTurn;

  // Кнопка «Раздать», когда раздача не идёт.
  if (!playing) {
    host.classList.remove('hidden');
    controls.classList.add('hidden');
    const eligible = pub.players.filter((p) => p.chips > 0).length;
    const canDeal = eligible >= 2;
    $('dealBtn').disabled = !canDeal;
    $('dealBtn').textContent = pub.phase === 'handover' ? 'Следующая раздача' : 'Раздать';
    $('waitHint').textContent = canDeal ? '' : 'Нужно минимум 2 игрока с фишками. Позови друзей по коду стола!';
    return;
  }

  host.classList.add('hidden');

  if (!myTurn) {
    controls.classList.add('hidden');
    return;
  }
  controls.classList.remove('hidden');

  // Пас доступен всегда на своём ходу.
  $('foldBtn').classList.remove('hidden');

  // Чек / Колл
  if (priv.canCheck) {
    $('checkBtn').classList.remove('hidden');
    $('callBtn').classList.add('hidden');
  } else {
    $('checkBtn').classList.add('hidden');
    $('callBtn').classList.remove('hidden');
    $('callBtn').textContent = priv.toCall >= priv.chips ? `Колл олл-ин ${priv.chips}` : `Колл ${priv.toCall}`;
  }

  // Рейз возможен, если хватает фишек превысить текущую ставку.
  const canRaise = priv.maxRaiseTo > pub.currentBet && priv.chips > priv.toCall;
  const betRow = $('betRow');
  if (!canRaise) {
    $('raiseBtn').classList.add('hidden');
    $('confirmRaiseBtn').classList.add('hidden');
    betRow.classList.add('hidden');
    raiseMode = false;
    return;
  }

  $('raiseBtn').textContent = pub.currentBet === 0 ? 'Ставка' : 'Рейз';

  if (raiseMode) {
    betRow.classList.remove('hidden');
    $('raiseBtn').classList.add('hidden');
    $('confirmRaiseBtn').classList.remove('hidden');
    const slider = $('betSlider');
    slider.min = priv.minRaiseTo;
    slider.max = priv.maxRaiseTo;
    if (!slider.value || Number(slider.value) < priv.minRaiseTo || Number(slider.value) > priv.maxRaiseTo) {
      slider.value = priv.minRaiseTo;
    }
    $('betAmount').textContent = slider.value;
  } else {
    betRow.classList.add('hidden');
    $('raiseBtn').classList.remove('hidden');
    $('confirmRaiseBtn').classList.add('hidden');
  }
}

function renderLog() {
  const log = $('log');
  log.innerHTML = (state.pub.log || []).map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
}

// ---------- Утилиты ----------
const SUIT_SYM = { c: '♣', d: '♦', h: '♥', s: '♠' };
const RANK_SYM = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
function cardLabelFromRaw(c) {
  const r = RANK_SYM[c.rank] || String(c.rank);
  return r + SUIT_SYM[c.suit];
}

function streetName(street, phase) {
  if (phase === 'lobby') return 'Ожидание';
  if (phase === 'handover') return 'Итог раздачи';
  return { preflop: 'Префлоп', flop: 'Флоп', turn: 'Тёрн', river: 'Ривер', showdown: 'Вскрытие' }[street] || '—';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let hintTimer;
function flashHint(msg) {
  const el = $('waitHint');
  el.textContent = msg;
  el.style.color = 'var(--red)';
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.textContent = ''; el.style.color = ''; }, 2500);
}
