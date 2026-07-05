// Оценщик покерных комбинаций для Техасского холдема.
// Карта: { rank: 2..14, suit: 'c'|'d'|'h'|'s' }  (14 = туз)
// Возвращает сравнимый вектор: [категория, тайбрейк1, тайбрейк2, ...]
// Категории (больше = сильнее):
// 8 стрит-флеш, 7 каре, 6 фулл-хаус, 5 флеш, 4 стрит,
// 3 сет, 2 две пары, 1 пара, 0 старшая карта.

export const CATEGORY_NAMES = {
  8: 'Стрит-флеш',
  7: 'Каре',
  6: 'Фулл-хаус',
  5: 'Флеш',
  4: 'Стрит',
  3: 'Сет',
  2: 'Две пары',
  1: 'Пара',
  0: 'Старшая карта',
};

// Оценка ровно 5 карт -> вектор для сравнения.
function evaluate5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);

  const isFlush = suits.every((s) => s === suits[0]);

  // Уникальные ранги по убыванию для проверки стрита.
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    // Стрит с тузом снизу: A,5,4,3,2 -> старшая 5.
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;
  }
  const isStraight = straightHigh > 0;

  // Подсчёт по рангам: [{rank, count}], сортировка по count, затем по rank.
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, count]) => ({ rank: Number(r), count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (isStraight && isFlush) return [8, straightHigh];
  if (groups[0].count === 4) return [7, groups[0].rank, groups[1].rank];
  if (groups[0].count === 3 && groups[1].count === 2)
    return [6, groups[0].rank, groups[1].rank];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (groups[0].count === 3)
    return [3, groups[0].rank, groups[1].rank, groups[2].rank];
  if (groups[0].count === 2 && groups[1].count === 2)
    return [2, groups[0].rank, groups[1].rank, groups[2].rank];
  if (groups[0].count === 2)
    return [1, groups[0].rank, groups[1].rank, groups[2].rank, groups[3].rank];
  return [0, ...ranks];
}

// Сравнение двух векторов: >0 если a сильнее, <0 если b, 0 если равны.
export function compareScores(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function combinations(arr, k) {
  const result = [];
  const combo = [];
  function helper(start) {
    if (combo.length === k) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1);
      combo.pop();
    }
  }
  helper(0);
  return result;
}

// Лучшая 5-карточная комбинация из 5..7 карт.
// Возвращает { score, cards, name }.
export function evaluateBest(cards) {
  if (cards.length < 5) throw new Error('Нужно минимум 5 карт');
  let best = null;
  let bestCards = null;
  for (const combo of combinations(cards, 5)) {
    const score = evaluate5(combo);
    if (!best || compareScores(score, best) > 0) {
      best = score;
      bestCards = combo;
    }
  }
  return { score: best, cards: bestCards, name: CATEGORY_NAMES[best[0]] };
}

export { evaluate5 };
