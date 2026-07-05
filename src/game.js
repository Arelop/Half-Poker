// Движок одной покерной раздачи + стол с игроками, переживающими раздачи.
// Техасский холдем, без лимита (No-Limit Hold'em).
import { randomInt } from 'node:crypto';
import { makeDeck, shuffle, cardLabel } from './deck.js';
import { evaluateBest, compareScores } from './handEvaluator.js';
import { spinRoulette, spinWheel } from './casino.js';

// Пул законов Покерстана (игрокам показывается только название, не эффект).
const LAWS = [
  { id: 'luxury_tax', name: 'Налог на роскошь' },
  { id: 'communism', name: 'Коммунизм' },
  { id: 'martial', name: 'Военное положение' },
  { id: 'amnesty', name: 'Амнистия' },
  { id: 'oligarchy', name: 'Олигархия' },
  { id: 'nationalization', name: 'Национализация казино' },
  { id: 'printer', name: 'Печатный станок делает Брррр' },
  { id: 'elect_dictator', name: 'Избрать Диктатора' },
];
const VOTE_WINDOW = 5; // сколько конов идёт голосование
const DICTATOR_ELECTION_HANDS = 3; // выборы диктатора
const DICTATOR_RULE_HANDS = 10; // срок правления диктатора
const MVD_BRIBE_SHEKELS = 5; // подкуп МВД для устранения диктатора

// Покерстан: константы экономики.
const TREASURY_SEED = 1000; // начальный бюджет казны в Весёлом режиме
const BENEFIT_DEFAULT = 500; // пособие для лохов (пока не издан иной закон)
const SHEKEL_PRICE = 200; // цена одного золотого шекеля в магазине
const SHEKEL_SHOP_MAX = 10; // всего шекелей в магазине
const GYPSY_MARK_COST = 3; // сколько шекелей берёт Цыганка за снятие метки
const POKERSTAN_PRICE = 1000000; // цена покупки всего Покерстана (победа в игре)

// Титулы лоббиста (флаг + звание) — чистая косметика для лора.
const LOBBY_TITLES = [
  ['🇱🇮', 'Посол Лихтенштейна'],
  ['🇹🇻', 'Почётный гражданин Тувалу'],
  ['🇸🇲', 'Министр финансов Сан-Марино'],
  ['🇦🇩', 'Барон Андорры'],
  ['🇳🇷', 'Тайный советник Науру'],
  ['🇵🇼', 'Консул Палау'],
  ['🇲🇨', 'Герцог Монако'],
  ['🇻🇺', 'Смотритель маяка Вануату'],
  ['🇰🇮', 'Хранитель атоллов Кирибати'],
  ['🇧🇳', 'Эмиссар султана Брунея'],
  ['🇸🇿', 'Регент Эсватини'],
  ['🇬🇩', 'Командор Гренады'],
];

export const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];

export class Game {
  constructor({ smallBlind = 5, bigBlind = 10, startingChips = 1000, themes = [], turnSeconds = 60, mode = 'classic' } = {}) {
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.startingChips = startingChips;
    this.turnSeconds = turnSeconds; // лимit времени на ход
    this.themes = themes; // доступные темы артов карт
    this.mode = mode === 'fun' ? 'fun' : 'classic';
    this.players = []; // порядок = места за столом
    this.buttonIndex = -1;
    this.handNumber = 0;
    this.phase = 'lobby'; // lobby | playing | handover
    this.resetHandState();
    this.log = [];
    // Постоянное состояние Весёлого режима (переживает раздачи):
    this.taxAudit = null; // { targetId, handsLeft }
    this.denounceCooldown = 0; // инспектор отдыхает N конов после проверки
    this.casino = null; // { ownerId, ownerName }
    this.announce = []; // очередь громких объявлений для клиентов
    // Покерстан:
    this.treasury = this.mode === 'fun' ? TREASURY_SEED : 0; // казна
    this.benefitAmount = BENEFIT_DEFAULT; // размер пособия для лохов
    this.shekelShop = SHEKEL_SHOP_MAX; // шекелей осталось в магазине
    this.pokerstanWinner = null; // { id, name } — кто купил Покерстан и победил
    // Политика:
    this.politics = { votingHandsLeft: VOTE_WINDOW, votes: {}, cycle: 1 };
    this.activeLaws = []; // [{ id, name, handsLeft }]
    this.martialNextHand = false; // военное положение на следующий кон
    this.martialThisHand = false;
    this.dictatorVote = null; // { handsLeft, votes } — выборы диктатора
    this.dictator = null; // { id, name, handsLeft } — действующий диктатор
  }

  pushAnnounce(text, emoji = '🎉') {
    this.announce.push({ text, emoji });
  }
  drainAnnounce() {
    const a = this.announce;
    this.announce = [];
    return a;
  }

  resetHandState() {
    this.deck = [];
    this.community = [];
    this.street = null;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.toActId = null;
    this.pots = []; // рассчитываются при вскрытии
    this.results = null; // итог раздачи для UI
    this.sideBets = []; // ставки на победителя (режим хаоса)
  }

  // ---- Управление игроками ----

  addPlayer(id, name, isBot = false) {
    if (this.players.find((p) => p.id === id)) return;
    this.players.push({
      id,
      name,
      isBot,
      cardTheme: null, // null = «вперемешку» (арт каждой карты свой)
      donated: 0, // всего отправлено «в Израиль» (Весёлый режим)
      lobbyTitle: null, // титул лоббиста (косметика)
      lobbyFlag: null, // флаг страны (эмодзи)
      investment: null, // { amount, handsLeft } — вложение в «стартап»
      thirdCardCd: 0, // перезарядка «третьей карты», конов
      shekels: 0, // золотые шекели
      loserMark: false, // метка лоха (нет доступа к казино/выборам)
      chips: this.startingChips,
      connected: true,
      // состояние в раздаче:
      holeCards: [],
      folded: false,
      allIn: false,
      inHand: false,
      streetBet: 0,
      totalBet: 0,
      hasActed: false,
    });
  }

  removePlayer(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) return;
    // Если раздача идёт — помечаем как сфолдил и отключён, но место держим до конца раздачи.
    if (this.phase === 'playing' && p.inHand && !p.folded) {
      p.folded = true;
      if (this.toActId === id) this.advanceAction();
    }
    this.players = this.players.filter((x) => x.id !== id);
    if (this.players.length < 2 && this.phase === 'playing') {
      // Недостаточно игроков — завершаем раздачу победой оставшегося.
      this.endHandByFold();
    }
  }

  setConnected(id, connected) {
    const p = this.players.find((x) => x.id === id);
    if (p) p.connected = connected;
  }

  // Докупка фишек себе (разрешена только между раздачами).
  rebuy(playerId, amount) {
    if (this.phase === 'playing')
      return { ok: false, error: 'Докупить можно только между раздачами' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'Неверная сумма' };
    if (amt > 100000000) return { ok: false, error: 'Слишком много' };
    p.chips += amt;
    this.pushLog(`${p.name} докупил ${amt} фишек`);
    return { ok: true };
  }

  // --- Режим хаоса ---

  // Ставка на победителя раздачи (до ривера). Все ставки — в общий тотализатор.
  placeSideBet(bettorId, targetId, amount) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (this.phase !== 'playing' || this.street === 'river' || this.street === 'showdown')
      return { ok: false, error: 'Ставить можно только до ривера' };
    const bettor = this.players.find((p) => p.id === bettorId);
    const target = this.players.find((p) => p.id === targetId);
    if (!bettor) return { ok: false, error: 'Игрок не найден' };
    if (!target || !target.inHand || target.folded)
      return { ok: false, error: 'Можно ставить только на игрока в раздаче' };
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'Неверная сумма' };
    if (bettor.chips < amt) return { ok: false, error: 'Недостаточно фишек' };
    bettor.chips -= amt;
    this.sideBets.push({ bettorId, targetId, amount: amt });
    this.pushLog(`${bettor.name} ставит ${amt} на победу ${target.name} 🎲`);
    return { ok: true };
  }

  // «Отправить в Израиль»: минус 10% банка из своих фишек (сгорают).
  donateIsrael(playerId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (this.phase !== 'playing') return { ok: false, error: 'Только во время раздачи' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    const amount = Math.floor(p.chips * 0.1);
    if (amount <= 0) return { ok: false, error: 'Мало фишек' };
    p.chips -= amount;
    p.donated += amount;
    this.pushLog(`${p.name} отправил ${amount} ₪ в Израиль 🇮🇱`);
    return { ok: true };
  }

  // Разрешение тотализатора в конце раздачи.
  resolveSideBets() {
    if (!this.sideBets || this.sideBets.length === 0) return;
    const winners = new Set((this.results?.winners || []).map((w) => w.id));
    const pool = this.sideBets.reduce((s, b) => s + b.amount, 0);
    const winning = this.sideBets.filter((b) => winners.has(b.targetId));
    const summary = [];

    if (winning.length === 0) {
      for (const b of this.sideBets) {
        const p = this.players.find((x) => x.id === b.bettorId);
        if (p) p.chips += b.amount;
      }
      this.pushLog(`Тотализатор: никто не угадал — ставки возвращены`);
      summary.push({ refunded: true, pool });
    } else {
      const totalStake = winning.reduce((s, b) => s + b.amount, 0);
      const payouts = winning.map((b) => ({ b, pay: Math.floor((pool * b.amount) / totalStake) }));
      let remainder = pool - payouts.reduce((s, x) => s + x.pay, 0);
      for (const x of payouts) {
        if (remainder > 0) { x.pay += 1; remainder -= 1; }
      }
      for (const { b, pay } of payouts) {
        const bettor = this.players.find((x) => x.id === b.bettorId);
        const target = this.players.find((x) => x.id === b.targetId);
        if (bettor) bettor.chips += pay;
        this.pushLog(`${bettor?.name} угадал (${target?.name}) и забрал ${pay} из тотализатора 🎉`);
        summary.push({ bettor: bettor?.name, target: target?.name, amount: b.amount, pay });
      }
    }
    this.results.sideBets = summary;
    this.sideBets = [];
  }

  topDonorId() {
    let top = null;
    let max = 0;
    for (const p of this.players) {
      if ((p.donated || 0) > max) { max = p.donated; top = p.id; }
    }
    return top;
  }

  // --- Покерстан: казна, пособие, шекели, Цыганка ---

  // Финальная задача: купить Покерстан за 1 000 000$ и победить.
  buyPokerstan(playerId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (this.pokerstanWinner) return { ok: false, error: 'Покерстан уже куплен' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    if (p.chips < POKERSTAN_PRICE)
      return { ok: false, error: `Нужно ${POKERSTAN_PRICE.toLocaleString('ru-RU')}$` };
    p.chips -= POKERSTAN_PRICE;
    this.treasury += POKERSTAN_PRICE;
    this.pokerstanWinner = { id: p.id, name: p.name };
    this.pushLog(`🏆 ${p.name} КУПИЛ ПОКЕРСТАН и победил в игре!`);
    this.pushAnnounce(`${p.name} купил Покерстан за 1 000 000$ и ПОБЕДИЛ! 🏆👑`, '🏆');
    return { ok: true };
  }

  // «Пособие для лохов»: игрок с 0$ забирает из казны. 1/3 шанс метки.
  takeBenefit(playerId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    if (p.chips > 0) return { ok: false, error: 'Пособие только для тех, у кого 0$' };
    if (this.treasury <= 0) return { ok: false, error: 'Казна Покерстана пуста' };
    const amount = Math.min(this.benefitAmount, this.treasury);
    this.treasury -= amount;
    p.chips += amount;
    this.pushLog(`${p.name} получил пособие для лохов: ${amount}$`);
    // 1/3 шанс, что изобьют менты.
    if (randomInt(0, 3) === 0) {
      p.loserMark = true;
      this.pushAnnounce(
        `Так как ${p.name} бедный — его избили и обсосали менты Покерстана. На нём метка лоха: нет выборов и казино. Снять можно у Цыганки за золотые шекели.`,
        '🚨'
      );
      return { ok: true, marked: true };
    }
    return { ok: true, marked: false };
  }

  // Купить золотые шекели в магазине (200$ за штуку, всего 10 в наличии).
  buyShekel(playerId, count = 1) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Неверное число' };
    if (this.shekelShop < n) return { ok: false, error: `В магазине только ${this.shekelShop} шекелей` };
    const cost = n * SHEKEL_PRICE;
    if (p.chips < cost) return { ok: false, error: 'Недостаточно фишек' };
    p.chips -= cost;
    this.shekelShop -= n;
    p.shekels += n;
    this.pushLog(`${p.name} купил ${n} шекел(ь/я) за ${cost}$ 🪙`);
    return { ok: true };
  }

  // Свободный обмен шекелями между игроками.
  transferShekels(fromId, toId, count) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    const from = this.players.find((x) => x.id === fromId);
    const to = this.players.find((x) => x.id === toId);
    if (!from || !to || from === to) return { ok: false, error: 'Выберите игрока' };
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Неверное число' };
    if (from.shekels < n) return { ok: false, error: 'Недостаточно шекелей' };
    from.shekels -= n;
    to.shekels += n;
    this.pushLog(`${from.name} передал ${to.name} ${n} шекел(ь/я) 🪙`);
    return { ok: true };
  }

  // Снять метку лоха у Цыганки за шекели (они возвращаются в магазин).
  removeMark(playerId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    if (!p.loserMark) return { ok: false, error: 'На вас нет метки' };
    if (p.shekels < GYPSY_MARK_COST)
      return { ok: false, error: `Цыганка берёт ${GYPSY_MARK_COST} шекеля` };
    p.shekels -= GYPSY_MARK_COST;
    this.shekelShop = Math.min(SHEKEL_SHOP_MAX, this.shekelShop + GYPSY_MARK_COST);
    p.loserMark = false;
    this.pushLog(`Цыганка сняла метку лоха с ${p.name} за ${GYPSY_MARK_COST} шекеля 🔮`);
    this.pushAnnounce(`${p.name} снял метку лоха у Цыганки. Снова полноправный гражданин!`, '🔮');
    return { ok: true };
  }

  // --- Политика: тайное голосование за законы ---

  isLawActive(id) {
    return this.activeLaws.some((l) => l.id === id);
  }

  // Национализация казино: 10% выигрыша уходит в казну.
  applyNationalization(amount) {
    if (!this.isLawActive('nationalization')) return amount;
    const cut = Math.floor(amount * 0.1);
    this.treasury += cut;
    if (cut > 0) this.pushLog(`Национализация: ${cut} с выигрыша в казну`);
    return amount - cut;
  }

  richestPlayer() {
    let r = null;
    let m = -1;
    for (const p of this.players) {
      if (p.chips > m) { m = p.chips; r = p; }
    }
    return r;
  }

  // Кто может голосовать: не боты, без метки; при Олигархии — только два богатейших.
  eligibleVoterIds() {
    let pool = this.players.filter((p) => !p.isBot && !p.loserMark);
    if (this.isLawActive('oligarchy')) {
      const rich = [...this.players].sort((a, b) => b.chips - a.chips).slice(0, 2).map((p) => p.id);
      pool = pool.filter((p) => rich.includes(p.id));
    }
    return pool.map((p) => p.id);
  }

  castVote(playerId, lawId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (this.politics.votingHandsLeft <= 0) return { ok: false, error: 'Голосование закрыто' };
    if (!LAWS.some((l) => l.id === lawId)) return { ok: false, error: 'Неизвестный закон' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    if (p.loserMark) return { ok: false, error: 'С меткой лоха голосовать нельзя' };
    if (!this.eligibleVoterIds().includes(playerId))
      return { ok: false, error: 'Сейчас голосуют только богатейшие (Олигархия)' };
    this.politics.votes[playerId] = lawId;
    this.pushLog(`${p.name} проголосовал`); // тайно — без выбора
    return { ok: true };
  }

  tallyAndEnact() {
    const counts = {};
    for (const lawId of Object.values(this.politics.votes)) {
      counts[lawId] = (counts[lawId] || 0) + 1;
    }
    const entries = Object.entries(counts);
    let winner;
    if (entries.length === 0) {
      winner = LAWS[randomInt(0, LAWS.length)].id; // никто не голосовал — случайный
    } else {
      const max = Math.max(...entries.map(([, c]) => c));
      const top = entries.filter(([, c]) => c === max).map(([id]) => id);
      winner = top[randomInt(0, top.length)]; // ничья — случайный из лидеров
    }
    this.enactLaw(winner);
  }

  enactLaw(lawId) {
    const law = LAWS.find((l) => l.id === lawId);
    const name = law ? law.name : lawId;
    this.pushLog(`Принят закон: ${name}`);
    this.pushAnnounce(`Принят закон: ${name}`, '📜'); // только название, без эффекта
    switch (lawId) {
      case 'luxury_tax': this.activeLaws.push({ id: 'luxury_tax', name, handsLeft: 10 }); break;
      case 'oligarchy': this.activeLaws.push({ id: 'oligarchy', name, handsLeft: 10 }); break;
      case 'nationalization': this.activeLaws.push({ id: 'nationalization', name, handsLeft: 10 }); break;
      case 'printer': this.activeLaws.push({ id: 'printer', name, handsLeft: 7 }); break;
      case 'martial': this.martialNextHand = true; break;
      case 'amnesty':
        for (const p of this.players) p.loserMark = false;
        break;
      case 'communism': this.applyCommunism(); break;
      case 'elect_dictator': this.startDictatorElection(); break;
    }
  }

  applyCommunism() {
    const total = this.players.reduce((s, p) => s + p.chips, 0);
    const state = Math.floor(total * 0.2);
    this.treasury += state;
    const rest = total - state;
    const n = this.players.length || 1;
    const each = Math.floor(rest / n);
    let rem = rest - each * n;
    for (const p of this.players) {
      p.chips = each;
      if (rem > 0) { p.chips += 1; rem -= 1; }
    }
    this.pushAnnounce('Гордо реет красный флаг 🚩', '🚩');
  }

  // Тик политики в конце каждого кона.
  tickPolitics() {
    if (this.mode !== 'fun') return;
    // Активные законы: применить эффект и отсчитать срок.
    for (const law of this.activeLaws) {
      if (law.id === 'luxury_tax') {
        const rich = this.richestPlayer();
        if (rich) {
          const tax = Math.floor(rich.chips * 0.05);
          if (tax > 0) {
            rich.chips -= tax;
            this.treasury += tax;
            this.pushLog(`Налог на роскошь: ${rich.name} платит ${tax} в казну`);
          }
        }
      } else if (law.id === 'printer') {
        this.treasury += 1000;
        this.pushLog('Печатный станок: +1000 в казну 🖨️');
      }
      law.handsLeft -= 1;
    }
    this.activeLaws = this.activeLaws.filter((l) => l.handsLeft > 0);

    // Выборы диктатора в приоритете — на их время обычное голосование на паузе.
    if (this.dictatorVote) {
      this.dictatorVote.handsLeft -= 1;
      if (this.dictatorVote.handsLeft <= 0) this.tallyDictator();
    } else if (this.politics.votingHandsLeft > 0) {
      this.politics.votingHandsLeft -= 1;
      if (this.politics.votingHandsLeft <= 0) {
        this.tallyAndEnact();
        this.politics.votes = {};
        this.politics.votingHandsLeft = VOTE_WINDOW;
        this.politics.cycle += 1;
      }
    }

    // Срок правления диктатора.
    if (this.dictator) {
      this.dictator.handsLeft -= 1;
      if (this.dictator.handsLeft <= 0) {
        this.pushAnnounce(`Правление диктатора ${this.dictator.name} окончено.`, '👑');
        this.dictator = null;
      }
    }
  }

  // --- Диктатор ---

  startDictatorElection() {
    this.dictatorVote = { handsLeft: DICTATOR_ELECTION_HANDS, votes: {} };
    this.pushAnnounce(`Объявлены выборы диктатора! Голосуйте ${DICTATOR_ELECTION_HANDS} кона.`, '👑');
  }

  castDictatorVote(voterId, targetId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (!this.dictatorVote) return { ok: false, error: 'Выборы диктатора не идут' };
    const voter = this.players.find((x) => x.id === voterId);
    const target = this.players.find((x) => x.id === targetId);
    if (!voter) return { ok: false, error: 'Игрок не найден' };
    if (!target) return { ok: false, error: 'Выберите кандидата' };
    if (voter.loserMark) return { ok: false, error: 'С меткой лоха голосовать нельзя' };
    if (!this.eligibleVoterIds().includes(voterId))
      return { ok: false, error: 'Сейчас голосуют только богатейшие (Олигархия)' };
    this.dictatorVote.votes[voterId] = targetId;
    this.pushLog(`${voter.name} проголосовал на выборах диктатора`);
    return { ok: true };
  }

  tallyDictator() {
    const counts = {};
    for (const targetId of Object.values(this.dictatorVote.votes)) {
      counts[targetId] = (counts[targetId] || 0) + 1;
    }
    const entries = Object.entries(counts);
    let winnerId;
    if (entries.length === 0) {
      winnerId = this.players[randomInt(0, this.players.length)].id; // никто — случайный
    } else {
      const max = Math.max(...entries.map(([, c]) => c));
      const top = entries.filter(([, c]) => c === max).map(([id]) => id);
      winnerId = top[randomInt(0, top.length)];
    }
    this.dictatorVote = null;
    const p = this.players.find((x) => x.id === winnerId);
    if (!p) return;
    this.dictator = { id: p.id, name: p.name, handsLeft: DICTATOR_RULE_HANDS };
    this.pushLog(`${p.name} стал диктатором Покерстана 👑`);
    this.pushAnnounce(`${p.name} стал диктатором Покерстана! Правит ${DICTATOR_RULE_HANDS} конов.`, '👑');
  }

  isDictator(playerId) {
    return this.dictator && this.dictator.id === playerId;
  }

  // Диктатор двигает казну: amount>0 — забрать из казны себе, amount<0 — внести.
  dictatorTreasury(playerId, amount) {
    if (!this.isDictator(playerId)) return { ok: false, error: 'Только диктатор' };
    const p = this.players.find((x) => x.id === playerId);
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt === 0) return { ok: false, error: 'Неверная сумма' };
    if (amt > 0) {
      const take = Math.min(amt, this.treasury);
      if (take <= 0) return { ok: false, error: 'Казна пуста' };
      this.treasury -= take;
      p.chips += take;
      this.pushLog(`👑 Диктатор ${p.name} взял из казны ${take}`);
    } else {
      const dep = Math.min(-amt, p.chips);
      if (dep <= 0) return { ok: false, error: 'Нет фишек' };
      p.chips -= dep;
      this.treasury += dep;
      this.pushLog(`👑 Диктатор ${p.name} внёс в казну ${dep}`);
    }
    return { ok: true };
  }

  // Диктатор принимает любой закон в один клик (кроме новых выборов диктатора).
  dictatorEnactLaw(playerId, lawId) {
    if (!this.isDictator(playerId)) return { ok: false, error: 'Только диктатор' };
    if (lawId === 'elect_dictator') return { ok: false, error: 'Нельзя' };
    if (!LAWS.some((l) => l.id === lawId)) return { ok: false, error: 'Неизвестный закон' };
    this.enactLaw(lawId);
    return { ok: true };
  }

  // Диктатор свободно снимает метку лоха с игрока.
  dictatorRemoveMark(playerId, targetId) {
    if (!this.isDictator(playerId)) return { ok: false, error: 'Только диктатор' };
    const t = this.players.find((x) => x.id === targetId);
    if (!t) return { ok: false, error: 'Игрок не найден' };
    if (!t.loserMark) return { ok: false, error: 'На игроке нет метки' };
    t.loserMark = false;
    this.pushLog(`👑 Диктатор снял метку лоха с ${t.name}`);
    return { ok: true };
  }

  // Подкуп главы МВД (5 шекелей) — устранение диктатора, он теряет всё.
  bribeMVD(playerId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (!this.dictator) return { ok: false, error: 'Диктатора нет' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    if (p.shekels < MVD_BRIBE_SHEKELS)
      return { ok: false, error: `Нужно ${MVD_BRIBE_SHEKELS} шекелей` };
    // Взятка уходит в магазин шекелей.
    p.shekels -= MVD_BRIBE_SHEKELS;
    this.shekelShop = Math.min(SHEKEL_SHOP_MAX, this.shekelShop + MVD_BRIBE_SHEKELS);
    // Устранение диктатора: теряет статус и всё имущество (в казну/магазин).
    const victim = this.players.find((x) => x.id === this.dictator.id);
    const victimName = this.dictator.name;
    if (victim) {
      this.treasury += victim.chips;
      victim.chips = 0;
      this.shekelShop = Math.min(SHEKEL_SHOP_MAX, this.shekelShop + victim.shekels);
      victim.shekels = 0;
      victim.lobbyTitle = null;
      victim.lobbyFlag = null;
    }
    this.dictator = null;
    this.pushLog(`🔪 Диктатор ${victimName} устранён МВД — потерял всё`);
    this.pushAnnounce(`Диктатор ${victimName} погиб в результате «несчастного случая». Он потерял статус и всё имущество.`, '🔪');
    return { ok: true };
  }

  // Военное положение: все идут ва-банк, кон доигрывается автоматически.
  forceMartialAllIn() {
    for (const p of this.inHandPlayers()) {
      if (!p.folded && !p.allIn && p.chips > 0) this.moveChips(p, p.chips);
    }
    const bets = this.players.filter((p) => p.inHand).map((p) => p.streetBet);
    this.currentBet = Math.max(this.currentBet, ...bets);
    this.pushLog('⚔️ Военное положение: все идут ва-банк!');
    this.advanceAction();
  }

  potNow() {
    return this.players.reduce((s, p) => s + p.totalBet, 0);
  }

  // «Написать донос в налоговую»: случайный игрок играет 1–4 раздачи в открытую.
  writeDenunciation() {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (this.taxAudit) return { ok: false, error: 'Проверка уже идёт' };
    if (this.denounceCooldown > 0)
      return { ok: false, error: `Инспектор отдыхает ещё ${this.denounceCooldown} конов` };
    if (this.players.length === 0) return { ok: false, error: 'Нет игроков' };
    const target = this.players[randomInt(0, this.players.length)];
    const hands = randomInt(1, 5); // 1..4
    this.taxAudit = { targetId: target.id, handsLeft: hands };
    this.pushLog(`${target.name} попался на глаза налоговому инспектору 👀`);
    this.pushAnnounce(`${target.name} попался на глаза налоговому инспектору! Играет в открытую ${hands} ${hands === 1 ? 'раздачу' : 'раздачи'}.`, '🕵️');
    return { ok: true };
  }

  // «Инвестировать в очень надёжный стартап»: −50% своих фишек, через 5 раздач 50/50.
  investStartup(playerId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (this.phase !== 'playing') return { ok: false, error: 'Только во время раздачи' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    if (p.investment) return { ok: false, error: 'У вас уже есть вложение' };
    const pay = Math.floor(p.chips * 0.5);
    if (pay <= 0) return { ok: false, error: 'Мало фишек' };
    p.chips -= pay;
    p.investment = { amount: pay, handsLeft: 5 };
    this.pushLog(`${p.name} вложил ${pay} в «очень надёжный стартап» 📈`);
    this.pushAnnounce(`${p.name} инвестировал ${pay} в очень надёжный стартап. Результат через 5 раздач…`, '📈');
    return { ok: true };
  }

  // «Купить третью карту»: −10% своих фишек, только до флопа.
  buyThirdCard(playerId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (this.phase !== 'playing' || this.street !== 'preflop')
      return { ok: false, error: 'Третью карту можно купить только до флопа' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p || !p.inHand || p.folded) return { ok: false, error: 'Вы не в раздаче' };
    if (p.holeCards.length >= 3) return { ok: false, error: 'Третья карта уже куплена' };
    if (p.thirdCardCd > 0)
      return { ok: false, error: `Перезарядка: ещё ${p.thirdCardCd} конов` };
    const cost = Math.floor(p.chips * 0.1);
    if (cost > p.chips) return { ok: false, error: 'Недостаточно фишек' };
    if (this.deck.length === 0) return { ok: false, error: 'Колода пуста' };
    p.chips -= cost; // плата «сгорает»
    p.thirdCardCd = 6; // КД 6 конов
    const card = this.deck.pop();
    if (this.themes.length) card.art = this.themes[randomInt(0, this.themes.length)];
    p.holeCards.push(card);
    this.pushLog(`${p.name} купил третью карту за ${cost} 🃏`);
    return { ok: true };
  }

  // «Лоббировать интересы неизвестной страны»: −10% своих фишек, флаг+титул, один раз.
  lobbyCountry(playerId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (this.phase !== 'playing') return { ok: false, error: 'Только во время раздачи' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    if (p.lobbyTitle) return { ok: false, error: 'Вы уже лоббист' };
    const cost = Math.floor(p.chips * 0.1);
    if (cost > p.chips) return { ok: false, error: 'Недостаточно фишек' };
    const [flag, title] = LOBBY_TITLES[randomInt(0, LOBBY_TITLES.length)];
    p.chips -= cost;
    p.lobbyTitle = title;
    p.lobbyFlag = flag;
    this.pushLog(`${p.name} теперь ${title} ${flag}`);
    this.pushAnnounce(`${p.name} — ${title} ${flag}`, flag);
    return { ok: true };
  }

  // «Открыть казино»: −1000, владелец получает 5% с проигрышей.
  openCasino(playerId) {
    if (this.mode !== 'fun') return { ok: false, error: 'Только в Весёлом режиме' };
    if (this.casino) return { ok: false, error: 'Казино уже открыто' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    if (p.loserMark) return { ok: false, error: 'С меткой лоха казино недоступно' };
    if (p.chips < 2500) return { ok: false, error: 'Нужно 2500 фишек' };
    p.chips -= 2500;
    this.casino = { ownerId: p.id, ownerName: p.name };
    this.pushLog(`${p.name} открыл казино 🎰`);
    this.pushAnnounce(`${p.name} открыл на столе казино! Рулетка, колесо удачи 🎰`, '🎰');
    return { ok: true };
  }

  // Игра в казино. game: 'roulette' | 'wheel'.
  casinoPlay(playerId, game, amount, opts = {}) {
    if (!this.casino) return { ok: false, error: 'Казино не открыто' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return { ok: false, error: 'Игрок не найден' };
    if (p.loserMark) return { ok: false, error: 'С меткой лоха казино недоступно' };
    const bet = Math.floor(Number(amount));
    if (!Number.isFinite(bet) || bet <= 0) return { ok: false, error: 'Неверная ставка' };
    if (bet > p.chips) return { ok: false, error: 'Недостаточно фишек' };

    p.chips -= bet;
    let res;
    if (game === 'roulette') {
      res = spinRoulette(bet, opts.betType, opts.number);
    } else if (game === 'wheel') {
      res = spinWheel(bet);
    } else {
      p.chips += bet; // откат
      return { ok: false, error: 'Неизвестная игра' };
    }

    const payout = Math.max(0, Math.floor(res.payout));
    p.chips += payout;
    const lost = bet - payout;
    let ownerCut = 0;
    let toTreasury = 0;
    if (lost > 0) {
      const owner = this.players.find((x) => x.id === this.casino.ownerId);
      ownerCut = Math.floor(lost * 0.05); // 5% владельцу казино (всегда)
      if (owner) owner.chips += ownerCut;
      // В казну — только при законе «Национализация казино», и только его доля (10%).
      if (this.isLawActive('nationalization')) {
        toTreasury = Math.floor(lost * 0.1);
        this.treasury += toTreasury;
      }
      // Остальное сгорает (доход дома).
    }
    this.pushLog(`🎰 ${p.name}: ${res.text}`);
    return { ok: true, result: res, payout, net: payout - bet, ownerCut };
  }

  // Тик эффектов Весёлого режима в конце каждой раздачи.
  tickFunEffects() {
    // Перезарядки отсчитываются в начале тика.
    if (this.denounceCooldown > 0) this.denounceCooldown -= 1;
    for (const p of this.players) {
      if (p.thirdCardCd > 0) p.thirdCardCd -= 1;
    }

    // Налоговая проверка: по окончании инспектор уходит на отдых 10 конов.
    if (this.taxAudit) {
      this.taxAudit.handsLeft -= 1;
      if (this.taxAudit.handsLeft <= 0) {
        const t = this.players.find((x) => x.id === this.taxAudit.targetId);
        if (t) this.pushLog(`${t.name} закрыл вопросы с налоговой`);
        this.taxAudit = null;
        this.denounceCooldown = 10;
      }
    }

    // Вложения в стартап.
    for (const p of this.players) {
      if (!p.investment) continue;
      p.investment.handsLeft -= 1;
      if (p.investment.handsLeft <= 0) {
        const amount = p.investment.amount;
        p.investment = null;
        if (randomInt(0, 2) === 1) {
          p.chips += amount * 2;
          this.pushLog(`📈 Стартап ${p.name} взлетел! +${amount * 2}`);
          this.pushAnnounce(`Стартап ${p.name} взлетел! Деньги удвоены: +${amount * 2}`, '🚀');
        } else {
          // Провал инвестиции будит инспектора — можно сразу писать донос.
          this.denounceCooldown = 0;
          this.pushLog(`📉 Стартап ${p.name} лопнул — деньги сгорели`);
          this.pushAnnounce(`${p.name}: основатель сел в тюрьму. Вам шьют пособничество. Напишите донос в налоговую…`, '🚔');
        }
      }
    }
  }

  // Перевод фишек другому игроку (разрешён только между раздачами).
  transferChips(fromId, toId, amount, isTip = false) {
    if (this.phase === 'playing')
      return { ok: false, error: 'Передавать фишки можно только между раздачами' };
    const from = this.players.find((p) => p.id === fromId);
    const to = this.players.find((p) => p.id === toId);
    if (!from || !to || from === to) return { ok: false, error: 'Выберите игрока' };
    const amt = Math.floor(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'Неверная сумма' };
    if (from.chips < amt) return { ok: false, error: 'Недостаточно фишек' };
    from.chips -= amt;
    to.chips += amt;
    this.pushLog(
      isTip
        ? `${from.name} типанул ${to.name}: ${amt} 💰`
        : `${from.name} передал ${to.name}: ${amt} фишек`
    );
    return { ok: true };
  }

  eligiblePlayers() {
    // Те, кто может участвовать в новой раздаче (есть фишки).
    return this.players.filter((p) => p.chips > 0);
  }

  // ---- Старт раздачи ----

  startHand() {
    const eligible = this.eligiblePlayers();
    if (eligible.length < 2) {
      this.phase = 'lobby';
      return { ok: false, error: 'Нужно минимум 2 игрока с фишками' };
    }

    this.handNumber += 1;
    this.phase = 'playing';
    this.resetHandState();
    this.deck = shuffle(makeDeck());
    // Каждой карте — случайный арт из доступных тем (колода «вперемешку»).
    if (this.themes.length) {
      for (const c of this.deck) c.art = this.themes[randomInt(0, this.themes.length)];
    }

    for (const p of this.players) {
      p.holeCards = [];
      p.folded = p.chips <= 0; // без фишек — вне раздачи
      p.allIn = false;
      p.inHand = p.chips > 0;
      p.streetBet = 0;
      p.totalBet = 0;
      p.hasActed = false;
    }

    // Двигаем баттон на следующего игрока с фишками.
    this.buttonIndex = this.nextOccupiedSeat(this.buttonIndex, (p) => p.chips > 0);

    // Раздаём по 2 карты.
    for (let n = 0; n < 2; n++) {
      for (const p of this.inHandPlayers()) {
        p.holeCards.push(this.deck.pop());
      }
    }

    this.street = 'preflop';
    this.postBlinds();
    this.log = [];
    this.pushLog(`Раздача #${this.handNumber} началась`);

    // Военное положение: этот кон все идут ва-банк.
    this.martialThisHand = this.martialNextHand;
    this.martialNextHand = false;
    if (this.martialThisHand) {
      this.pushAnnounce('Военное положение: все обязаны идти ва-банк! ⚔️', '⚔️');
      this.forceMartialAllIn();
    }
    return { ok: true };
  }

  postBlinds() {
    const active = this.inHandPlayers();
    const heads = active.length === 2;

    let sbSeat;
    let bbSeat;
    if (heads) {
      sbSeat = this.buttonIndex; // в хедз-апе баттон = малый блайнд
      bbSeat = this.nextOccupiedSeat(this.buttonIndex, (p) => p.inHand);
    } else {
      sbSeat = this.nextOccupiedSeat(this.buttonIndex, (p) => p.inHand);
      bbSeat = this.nextOccupiedSeat(sbSeat, (p) => p.inHand);
    }

    const sb = this.players[sbSeat];
    const bb = this.players[bbSeat];
    this.postBlind(sb, this.smallBlind);
    this.postBlind(bb, this.bigBlind);
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    // Первый ход: хедз-ап — баттон/SB; иначе — слева от BB.
    const firstSeat = heads
      ? sbSeat
      : this.nextOccupiedSeat(bbSeat, (p) => p.inHand && !p.allIn);
    this.toActId = this.players[firstSeat]?.id ?? null;
    // Блайнды ещё не «действовали» — у них есть опция.
    sb.hasActed = false;
    bb.hasActed = false;
  }

  postBlind(player, amount) {
    const pay = Math.min(amount, player.chips);
    player.chips -= pay;
    player.streetBet += pay;
    player.totalBet += pay;
    if (player.chips === 0) player.allIn = true;
  }

  // ---- Помощники по местам ----

  inHandPlayers() {
    return this.players.filter((p) => p.inHand);
  }

  activePlayers() {
    // В раздаче и не сфолдили.
    return this.players.filter((p) => p.inHand && !p.folded);
  }

  canActPlayers() {
    return this.players.filter((p) => p.inHand && !p.folded && !p.allIn);
  }

  // Следующее занятое место по кругу, удовлетворяющее предикату.
  nextOccupiedSeat(fromIndex, pred) {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromIndex + step + n) % n;
      if (pred(this.players[idx])) return idx;
    }
    return fromIndex;
  }

  playerIndex(id) {
    return this.players.findIndex((p) => p.id === id);
  }

  needsToAct(p) {
    return p.inHand && !p.folded && !p.allIn && (!p.hasActed || p.streetBet < this.currentBet);
  }

  // ---- Применение хода игрока ----

  applyAction(playerId, action, amount = 0) {
    if (this.phase !== 'playing') return { ok: false, error: 'Раздача не идёт' };
    if (playerId !== this.toActId) return { ok: false, error: 'Сейчас не ваш ход' };
    const p = this.players.find((x) => x.id === playerId);
    if (!p || !p.inHand || p.folded || p.allIn)
      return { ok: false, error: 'Вы не можете ходить' };

    const toCall = this.currentBet - p.streetBet;

    switch (action) {
      case 'fold': {
        p.folded = true;
        p.hasActed = true;
        this.pushLog(`${p.name} сбросил`);
        break;
      }
      case 'check': {
        if (toCall > 0) return { ok: false, error: 'Нельзя чекнуть — есть ставка' };
        p.hasActed = true;
        this.pushLog(`${p.name} чек`);
        break;
      }
      case 'call': {
        if (toCall <= 0) return { ok: false, error: 'Нечего коллировать (используйте чек)' };
        const pay = Math.min(toCall, p.chips);
        this.moveChips(p, pay);
        p.hasActed = true;
        this.pushLog(`${p.name} колл ${pay}`);
        break;
      }
      case 'raise':
      case 'bet': {
        // amount = «до какой суммы» поднять ставку на этой улице.
        const raiseTo = Math.floor(amount);
        const res = this.doRaise(p, raiseTo);
        if (!res.ok) return res;
        break;
      }
      case 'allin': {
        if (p.chips <= toCall) {
          // Олл-ин, которого хватает только на колл (или даже меньше) — это колл.
          const pay = this.moveChips(p, p.chips);
          p.hasActed = true;
          this.pushLog(`${p.name} колл ${pay} (олл-ин)`);
        } else {
          const raiseTo = p.streetBet + p.chips;
          const res = this.doRaise(p, raiseTo, true);
          if (!res.ok) return res;
        }
        break;
      }
      default:
        return { ok: false, error: 'Неизвестное действие' };
    }

    this.advanceAction();
    return { ok: true };
  }

  moveChips(player, amount) {
    const pay = Math.min(amount, player.chips);
    player.chips -= pay;
    player.streetBet += pay;
    player.totalBet += pay;
    if (player.chips === 0) player.allIn = true;
    return pay;
  }

  doRaise(p, raiseTo, isAllInShove = false) {
    const maxTo = p.streetBet + p.chips;
    if (raiseTo > maxTo) return { ok: false, error: 'Недостаточно фишек' };
    if (raiseTo <= this.currentBet)
      return { ok: false, error: 'Ставка должна превышать текущую' };

    const isAllIn = raiseTo === maxTo;
    const minLegalTo = this.currentBet + this.minRaise;
    if (!isAllIn && raiseTo < minLegalTo) {
      return { ok: false, error: `Минимальная ставка до ${minLegalTo}` };
    }

    const raiseAmount = raiseTo - this.currentBet;
    const pay = raiseTo - p.streetBet;
    this.moveChips(p, pay);

    const wasOpen = this.currentBet === 0;
    // Полноценный рейз (>= мин-рейз) заново открывает торговлю.
    if (raiseAmount >= this.minRaise) {
      this.minRaise = raiseAmount;
      for (const other of this.canActPlayers()) {
        if (other.id !== p.id) other.hasActed = false;
      }
    }
    this.currentBet = Math.max(this.currentBet, raiseTo);
    p.hasActed = true;

    const verb = wasOpen ? 'бет' : 'рейз до';
    this.pushLog(`${p.name} ${verb} ${raiseTo}${p.allIn ? ' (олл-ин)' : ''}`);
    return { ok: true };
  }

  // ---- Продвижение хода / улиц ----

  advanceAction() {
    // Остался один не сбросивший — раздача окончена.
    if (this.activePlayers().length <= 1) {
      this.endHandByFold();
      return;
    }

    // Круг торговли завершён?
    const pending = this.canActPlayers().filter((p) => this.needsToAct(p));
    if (pending.length === 0) {
      this.advanceStreet();
      return;
    }

    // Следующий ходящий по кругу от текущего.
    const fromIdx = this.toActId != null ? this.playerIndex(this.toActId) : this.buttonIndex;
    const nextIdx = this.nextOccupiedSeat(fromIdx, (p) => this.needsToAct(p));
    this.toActId = this.players[nextIdx].id;
  }

  advanceStreet() {
    // Собираем ставки улицы (они уже в totalBet), обнуляем streetBet.
    for (const p of this.players) {
      p.streetBet = 0;
      p.hasActed = false;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    // Если торговать больше некому (<=1 может ставить) — доводим борд до ривера.
    const runOut = this.canActPlayers().length <= 1;

    const order = ['preflop', 'flop', 'turn', 'river'];
    const idx = order.indexOf(this.street);

    const dealNext = () => {
      this.street = order[idx + 1] ?? 'showdown';
      if (this.street === 'flop') {
        this.deck.pop(); // burn
        this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      } else if (this.street === 'turn' || this.street === 'river') {
        this.deck.pop();
        this.community.push(this.deck.pop());
      }
    };

    dealNext();

    if (this.street === 'showdown') {
      this.showdown();
      return;
    }

    if (runOut) {
      // Никто не может ставить — сдаём оставшиеся улицы и вскрываемся.
      while (this.street !== 'showdown') {
        const i = order.indexOf(this.street);
        this.street = order[i + 1] ?? 'showdown';
        if (this.street === 'flop') {
          this.deck.pop();
          this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        } else if (this.street === 'turn' || this.street === 'river') {
          this.deck.pop();
          this.community.push(this.deck.pop());
        }
      }
      this.showdown();
      return;
    }

    // Постфлоп первым ходит ближайший активный слева от баттона.
    const firstIdx = this.nextOccupiedSeat(this.buttonIndex, (p) => this.needsToAct(p));
    this.toActId = this.players[firstIdx]?.id ?? null;
    this.pushLog(`— ${this.streetLabel()} —`);
  }

  streetLabel() {
    return { flop: 'Флоп', turn: 'Тёрн', river: 'Ривер' }[this.street] ?? this.street;
  }

  // ---- Завершение раздачи ----

  endHandByFold() {
    const winners = this.activePlayers();
    const totalPot = this.players.reduce((s, p) => s + p.totalBet, 0);
    if (winners.length === 1) {
      const net = this.applyNationalization(totalPot);
      winners[0].chips += net;
      this.pushLog(`${winners[0].name} забирает банк ${net} (все сбросили)`);
      this.results = {
        winners: [{ id: winners[0].id, name: winners[0].name, amount: totalPot }],
        showdown: false,
        pots: [],
      };
    } else {
      // Крайний случай (никого не осталось) — банк остаётся, ничего не делаем.
      this.results = { winners: [], showdown: false, pots: [] };
    }
    this.finishHand();
  }

  showdown() {
    this.street = 'showdown';
    const contenders = this.activePlayers();
    // Оценка комбинаций всех претендентов.
    const evals = {};
    for (const p of contenders) {
      evals[p.id] = evaluateBest([...p.holeCards, ...this.community]);
    }

    const pots = this.buildPots();
    const awards = {}; // id -> сумма выигрыша
    const potResults = [];

    for (const pot of pots) {
      const eligible = pot.eligible.filter((id) => contenders.find((c) => c.id === id));
      if (eligible.length === 0) continue;
      // Лучшая комбинация среди имеющих право на этот банк.
      let best = null;
      let winnersIds = [];
      for (const id of eligible) {
        const cmp = best ? compareScores(evals[id].score, best) : 1;
        if (cmp > 0) {
          best = evals[id].score;
          winnersIds = [id];
        } else if (cmp === 0) {
          winnersIds.push(id);
        }
      }
      // Делим банк; остаток по одному, начиная слева от баттона.
      const share = Math.floor(pot.amount / winnersIds.length);
      let remainder = pot.amount - share * winnersIds.length;
      const ordered = this.orderFromButton(winnersIds);
      for (const id of ordered) {
        let amt = share;
        if (remainder > 0) {
          amt += 1;
          remainder -= 1;
        }
        awards[id] = (awards[id] || 0) + amt;
      }
      potResults.push({
        amount: pot.amount,
        winners: winnersIds.map((id) => this.players.find((p) => p.id === id).name),
      });
    }

    // Начисляем (с учётом национализации казино, если закон активен).
    for (const [id, amt] of Object.entries(awards)) {
      const p = this.players.find((x) => x.id === id);
      p.chips += this.applyNationalization(amt);
    }

    const winnersList = Object.entries(awards).map(([id, amount]) => {
      const p = this.players.find((x) => x.id === id);
      return { id, name: p.name, amount, hand: evals[id].name };
    });
    winnersList.sort((a, b) => b.amount - a.amount);

    for (const w of winnersList) {
      this.pushLog(`${w.name} выигрывает ${w.amount} — ${w.hand}`);
    }

    this.results = {
      winners: winnersList,
      showdown: true,
      pots: potResults,
      // Раскрываем карты дошедших до вскрытия.
      revealed: contenders.map((p) => ({
        id: p.id,
        name: p.name,
        holeCards: p.holeCards,
        hand: evals[p.id].name,
        bestCards: evals[p.id].cards,
      })),
    };
    this.finishHand();
  }

  // Построение основного и побочных банков из totalBet всех игроков.
  buildPots() {
    const contribs = this.players
      .filter((p) => p.totalBet > 0)
      .map((p) => ({ id: p.id, total: p.totalBet, folded: p.folded }));
    const levels = [...new Set(contribs.map((c) => c.total))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      const eligible = [];
      for (const c of contribs) {
        const layer = Math.max(0, Math.min(c.total, level) - prev);
        amount += layer;
        if (c.total >= level && !c.folded) eligible.push(c.id);
      }
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    return pots;
  }

  // Порядок игроков, начиная с первого места слева от баттона.
  orderFromButton(ids) {
    const set = new Set(ids);
    const ordered = [];
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (this.buttonIndex + step) % n;
      const id = this.players[idx]?.id;
      if (set.has(id)) ordered.push(id);
    }
    return ordered.length ? ordered : ids;
  }

  finishHand() {
    this.resolveSideBets(); // тотализатор Весёлого режима
    this.tickFunEffects(); // проверки/стартапы отсчитывают раздачи
    this.tickPolitics(); // законы и голосование
    this.phase = 'handover';
    this.toActId = null;
  }

  // ---- Сериализация состояния ----

  publicState() {
    const eligibleIds = this.mode === 'fun' ? this.eligibleVoterIds() : [];
    return {
      phase: this.phase,
      handNumber: this.handNumber,
      street: this.street,
      community: this.community.map(cardLabel),
      communityRaw: this.community,
      pot: this.players.reduce((s, p) => s + p.totalBet, 0),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      bigBlind: this.bigBlind,
      smallBlind: this.smallBlind,
      startingChips: this.startingChips,
      mode: this.mode,
      buttonId: this.players[this.buttonIndex]?.id ?? null,
      toActId: this.toActId,
      results: this.results,
      log: this.log.slice(-30),
      sideBets: (this.sideBets || []).map((b) => ({
        bettorId: b.bettorId,
        targetId: b.targetId,
        bettor: this.players.find((p) => p.id === b.bettorId)?.name,
        target: this.players.find((p) => p.id === b.targetId)?.name,
        amount: b.amount,
      })),
      topDonorId: this.topDonorId(),
      taxAudit: this.taxAudit ? { targetId: this.taxAudit.targetId, handsLeft: this.taxAudit.handsLeft } : null,
      denounceCooldown: this.denounceCooldown || 0,
      casino: this.casino ? { ownerId: this.casino.ownerId, ownerName: this.casino.ownerName } : null,
      treasury: this.treasury || 0,
      benefitAmount: this.benefitAmount,
      shekelShop: this.shekelShop,
      shekelPrice: SHEKEL_PRICE,
      pokerstanPrice: POKERSTAN_PRICE,
      pokerstanWinner: this.pokerstanWinner,
      politics: {
        handsLeft: this.politics.votingHandsLeft,
        open: this.politics.votingHandsLeft > 0,
        cycle: this.politics.cycle,
        laws: LAWS,
        votedCount: Object.keys(this.politics.votes).length,
        eligibleCount: this.eligibleVoterIds().length,
        oligarchy: this.isLawActive('oligarchy'),
      },
      activeLaws: this.activeLaws.map((l) => ({ name: l.name, handsLeft: l.handsLeft })),
      dictator: this.dictator ? { id: this.dictator.id, name: this.dictator.name, handsLeft: this.dictator.handsLeft } : null,
      dictatorElection: this.dictatorVote
        ? {
            handsLeft: this.dictatorVote.handsLeft,
            votedCount: Object.keys(this.dictatorVote.votes).length,
            eligibleCount: eligibleIds.length,
          }
        : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: !!p.isBot,
        cardTheme: p.cardTheme || null,
        donated: p.donated || 0,
        lobbyTitle: p.lobbyTitle || null,
        lobbyFlag: p.lobbyFlag || null,
        investHandsLeft: p.investment ? p.investment.handsLeft : null,
        thirdCardCd: p.thirdCardCd || 0,
        shekels: p.shekels || 0,
        loserMark: !!p.loserMark,
        hasVoted: !!this.politics.votes[p.id],
        hasVotedDictator: !!(this.dictatorVote && this.dictatorVote.votes[p.id]),
        eligibleVoter: eligibleIds.includes(p.id),
        // Карты «под проверкой налоговой» — открыты всем.
        auditCards: this.taxAudit && this.taxAudit.targetId === p.id && p.inHand && !p.folded ? p.holeCards : null,
        chips: p.chips,
        connected: p.connected,
        folded: p.folded,
        allIn: p.allIn,
        inHand: p.inHand,
        streetBet: p.streetBet,
        totalBet: p.totalBet,
        hasCards: p.inHand && !p.folded && p.holeCards.length > 0,
      })),
    };
  }

  // Приватная часть для конкретного игрока (его карты + подсказки по ходу).
  privateFor(playerId) {
    const p = this.players.find((x) => x.id === playerId);
    if (!p) return null;
    const toCall = Math.max(0, this.currentBet - p.streetBet);
    return {
      holeCards: p.holeCards.map(cardLabel),
      holeCardsRaw: p.holeCards,
      yourTurn: this.toActId === playerId && this.phase === 'playing',
      toCall: Math.min(toCall, p.chips),
      canCheck: toCall === 0,
      minRaiseTo: Math.min(this.currentBet + this.minRaise, p.streetBet + p.chips),
      maxRaiseTo: p.streetBet + p.chips,
      chips: p.chips,
      streetBet: p.streetBet,
    };
  }

  pushLog(msg) {
    this.log.push(msg);
  }
}
