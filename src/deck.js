// Колода из 52 карт и перемешивание.
import { randomInt } from 'node:crypto';

export const SUITS = ['c', 'd', 'h', 's']; // трефы, бубны, червы, пики
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export const RANK_LABELS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};
export const SUIT_LABELS = { c: '♣', d: '♦', h: '♥', s: '♠' };

export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

// Тасование Фишера–Йетса на криптостойком генераторе — без предсказуемых раздач.
export function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function cardLabel(card) {
  return `${RANK_LABELS[card.rank]}${SUIT_LABELS[card.suit]}`;
}
