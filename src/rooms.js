// Менеджер игровых комнат: код комнаты -> стол (Game) + сокеты игроков.
import { randomInt } from 'node:crypto';
import { Game } from './game.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O, 1/I

export class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> room
  }

  makeCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(settings = {}) {
    const code = this.makeCode();
    const room = {
      code,
      game: new Game(settings),
      hostId: null,
      sockets: new Map(), // playerId -> socketId
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  deleteIfEmpty(code) {
    const room = this.rooms.get(code);
    if (room && room.sockets.size === 0) {
      this.rooms.delete(code);
      return true;
    }
    return false;
  }
}
