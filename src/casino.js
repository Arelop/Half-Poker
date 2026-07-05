// Мини-казино Весёлого режима: рулетка и колесо удачи.
// Все функции возвращают { payout, text } — payout это сколько ВОЗВРАЩАЕТСЯ игроку
// (0 = проигрыш ставки; bet = возврат; >bet = выигрыш).
import { randomInt } from 'node:crypto';

// Красные числа европейской рулетки.
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export function rouletteColor(n) {
  if (n === 0) return 'green';
  return RED.has(n) ? 'red' : 'black';
}

// Рулетка. bet — сумма, betType: 'red' | 'black' | 'number', number — 0..36.
export function spinRoulette(bet, betType, number) {
  const n = randomInt(0, 37); // 0..36
  const color = rouletteColor(n);
  const label = `${n} ${color === 'red' ? '🔴' : color === 'black' ? '⚫' : '🟢'}`;
  let payout = 0;
  if (betType === 'number') {
    if (Number(number) === n) payout = bet * 36; // 35:1
  } else if (betType === 'red' || betType === 'black') {
    if (color === betType) payout = bet * 2; // 1:1
  }
  const won = payout > 0;
  return { payout, text: `Выпало ${label}. ${won ? `Выигрыш ${payout}!` : 'Мимо.'}`, result: n, color };
}

// Колесо удачи: сектора с множителями (payout = bet * множитель).
const WHEEL = [
  { m: 0, w: 20, label: '💀 0x' },
  { m: 0.5, w: 22, label: '📉 0.5x' },
  { m: 1, w: 18, label: '↔️ 1x' },
  { m: 1.5, w: 15, label: '🙂 1.5x' },
  { m: 2, w: 12, label: '🎉 2x' },
  { m: 3, w: 8, label: '🔥 3x' },
  { m: 5, w: 4, label: '💎 5x' },
  { m: 10, w: 1, label: '🌈 10x' },
];

export function spinWheel(bet) {
  const total = WHEEL.reduce((s, x) => s + x.w, 0);
  let r = randomInt(0, total);
  let seg = WHEEL[WHEEL.length - 1];
  for (const s of WHEEL) {
    if (r < s.w) { seg = s; break; }
    r -= s.w;
  }
  const payout = Math.floor(bet * seg.m);
  const net = payout - bet;
  const msg = net > 0 ? `Выигрыш +${net}!` : net === 0 ? 'При своих.' : `Проигрыш ${-net}.`;
  return { payout, text: `${seg.label} — ${msg}`, multiplier: seg.m };
}
