import {Game, GameDic, Player, Room} from './types';
import WebSocket from 'ws';
export class State {
  game: Record<Room, Game> = {};
  turns: Record<Room, Player> = {}; // It will whom turn is it
  clients: Record<Room, WebSocket[]> = {};
  getGameState = (room: Room) => this.game[room];
  getTurn = (room: Room) => this.game[room].turn;

  saveClientIfDoesntExist = (room: string, ws: WebSocket) => {
    if (!this.clients[room]) this.clients[room] = [];
    if (this.clients[room].some(client => client === ws)) {
      return;
    }

    this.clients[room].push(ws);
  };
  get = (room: string) => JSON.stringify(this.game[room]);
  set = (room: string, content: any) => {
    JSON.stringify((this.game[room] = content));
  };

  sendGameStarts = (room: string) => {
    if (!this.clients[room]) return; // Si no hay clientes en la sala, no hacer nada
    this.clients[room].forEach(client => {
      client.send(JSON.stringify({type: 'startGame'}));
    });
  };
  sendGameState = (room: string) => {
    if (!this.clients[room]) return; // Si no hay clientes en la sala, no hacer nada
    this.clients[room].forEach(client => {
      client.send(JSON.stringify({type: 'status', data: this.game[room]}));
    });
  };

  shuffleDeck = (deck: Array<any>) => {
    return deck.sort(() => Math.random() - 0.5);
  };

  dealCards = (deck: Array<any>, players: Array<any>) => {
    this.shuffleDeck(deck); // Copia y mezcla el mazo

    players.forEach(player => {
      player.cards = deck.splice(0, 2); // Asigna 2 cartas a cada jugador
    });

    return {updatedDeck: deck, updatedPlayers: players};
  };
  swapCardWithDeck = (deck: Array<any>, card: any, player: any) => {
    if (deck.length == 0) {
      return {updatedDeck: deck, updatedPlayer: player};
    }

    const cardIndex = player.cards.findIndex((c: any) => c.name == card.name);
    const newCard = deck.splice(0, 1)[0];
    player.cards[cardIndex] = newCard;
    deck.push(card);

    this.shuffleDeck(deck);

    return {updatedDeck: deck, updatedPlayer: player};
  };

  dealCoins(players: Array<any>, coins: number = 2) {
    players.forEach(player => {
      player.coins = coins;
    });
    return players;
  }

  nextLiteralTurn(room: string) {
    const players = this.game[room].players;
    const turnOf = this.turns[room];

    if (!turnOf) {
      this.turns[room] = players[0];
      return players[0];
    }

    const index = players.findIndex((player: any) => player.id == turnOf.id);
    let nextPlayer = players[index + 1];
    if (!nextPlayer) {
      nextPlayer = players[0];
    }

    this.turns[room] = nextPlayer;
    this.game[room].turn = nextPlayer;

    return nextPlayer;
  }

  nextTurn(room: string) {
    this.nextLiteralTurn(room);
    let turn = this.getTurn(room);

    while (!turn.cards.length) {
      this.nextLiteralTurn(room);
      turn = this.getTurn(room);
    }
  }
}

export const state = new State();
