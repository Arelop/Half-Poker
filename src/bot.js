// Простой ИИ-бот для тестирования: оценивает силу руки и принимает
// разумное (но с элементом случайности) решение.
import { evaluateBest } from './handEvaluator.js';

export const BOT_NAMES = [
  'Бот Джокер', 'Бот Шарк', 'Бот Ва-банк', 'Бот Покерфейс', 'Бот Блеф',
  'Бот Ривер', 'Бот Флоп', 'Бот Туз', 'Бот Ноль-эмоций',
];

// Оценка силы руки в диапазоне 0..1.
function handStrength(game, p) {
  if (game.community.length === 0) {
    // Префлоп — по двум картам.
    const [a, b] = p.holeCards;
    const hi = Math.max(a.rank, b.rank);
    const lo = Math.min(a.rank, b.rank);
    let s = (hi + lo) / 40; // база
    if (a.rank === b.rank) s += 0.35; // карман
    if (a.suit === b.suit) s += 0.06; // одномастные
    const gap = hi - lo;
    if (gap === 1) s += 0.05; // коннекторы
    if (hi >= 13) s += 0.05; // старшие карты
    return Math.max(0, Math.min(1, s));
  }
  // Постфлоп — по лучшей комбинации из 7 карт.
  const { score } = evaluateBest([...p.holeCards, ...game.community]);
  const byCategory = {
    0: 0.16, 1: 0.34, 2: 0.52, 3: 0.62, 4: 0.72, 5: 0.8, 6: 0.9, 7: 0.96, 8: 0.99,
  };
  let s = byCategory[score[0]] ?? 0.16;
  // Небольшая поправка на старшинство пары/карты.
  if (score[0] <= 1) s += ((score[1] ?? 0) - 8) / 200;
  return Math.max(0, Math.min(1, s));
}

// Возвращает { type, amount } — ход бота.
export function decideBotAction(game, playerId) {
  const p = game.players.find((x) => x.id === playerId);
  if (!p) return { type: 'fold' };

  const toCall = Math.max(0, game.currentBet - p.streetBet);
  const pot = game.players.reduce((s, x) => s + x.totalBet, 0);
  const strength = handStrength(game, p);
  const r = Math.random();

  const minRaiseTo = game.currentBet + game.minRaise;
  const maxRaiseTo = p.streetBet + p.chips;

  const makeRaise = (fraction) => {
    let to = game.currentBet + Math.max(game.bigBlind, Math.round(pot * fraction));
    to = Math.max(minRaiseTo, Math.min(maxRaiseTo, to));
    if (to >= maxRaiseTo) return { type: 'allin' };
    return { type: 'raise', amount: to };
  };

  const canRaise = maxRaiseTo > game.currentBet && p.chips > toCall;

  // Никто не ставил — можно чекнуть.
  if (toCall === 0) {
    if (canRaise && strength > 0.62 && r < 0.55) return makeRaise(0.6);
    if (canRaise && strength > 0.8 && r < 0.85) return makeRaise(0.9);
    return { type: 'check' };
  }

  // Есть ставка. Считаем шансы банка.
  const potOdds = toCall / (pot + toCall);

  // Сильная рука — иногда рейзим.
  if (canRaise && strength > 0.78 && r < 0.45) return makeRaise(0.75);

  // Достаточно сильная относительно шансов банка — коллируем.
  if (strength >= potOdds + 0.08) return { type: 'call' };

  // Слабая рука: маленькую ставку иногда всё равно коллируем, крупную — пас.
  if (toCall <= game.bigBlind * 1.5 && r < 0.6) return { type: 'call' };
  return { type: 'fold' };
}
