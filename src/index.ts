import express from 'express';
import {WebSocket} from 'ws';
import action from './actions';
type Room = string;
const app = express();
const game: Record<Room, any> = {};
const turns: Record<Room, any> = {}; // It will whom turn is it
const clients: Record<Room, WebSocket[]> = {};

const saveClientIfDoesntExist = (room: string, ws: WebSocket) => {
  if (!clients[room]) clients[room] = [];
  if (clients[room].some(client => client === ws)) {
    return;
  }

  clients[room].push(ws);
};
const parse = (msg: string) => JSON.parse(msg);
const get = (room: string) => JSON.stringify(game[room]);
const set = (room: string, content: any) => {
  JSON.stringify((game[room] = content));
};

const sendGameStarts = (room: string) => {
  if (!clients[room]) return; // Si no hay clientes en la sala, no hacer nada
  clients[room].forEach(client => {
    client.send(JSON.stringify({type: 'startGame'}));
  });
};
const sendGameState = (room: string) => {
  if (!clients[room]) return; // Si no hay clientes en la sala, no hacer nada
  clients[room].forEach(client => {
    client.send(JSON.stringify({type: 'status', data: game[room]}));
  });
};

function shuffleDeck(deck: Array<any>) {
  return deck.sort(() => Math.random() - 0.5);
}

function dealCards(deck: Array<any>, players: Array<any>) {
  shuffleDeck(deck); // Copia y mezcla el mazo

  players.forEach(player => {
    player.cards = deck.splice(0, 2); // Asigna 2 cartas a cada jugador
  });

  return {updatedDeck: deck, updatedPlayers: players};
}
export function swapCardWithDeck(deck: Array<any>, card: any, player: any) {
  if (deck.length == 0) {
    return {updatedDeck: deck, updatedPlayer: player};
  }

  const cardIndex = player.cards.findIndex((c: any) => c.name == card.name);
  const newCard = deck.splice(0, 1)[0];
  player.cards[cardIndex] = newCard;
  deck.push(card);

  shuffleDeck(deck);

  return {updatedDeck: deck, updatedPlayer: player};
}

function dealCoins(players: Array<any>, coins: number = 2) {
  players.forEach(player => {
    player.coins = coins;
  });
  return players;
}

function getTurn(room: string) {
  return game[room].turn;
}
function nextLiteralTurn(room: string) {
  const players = game[room].players;
  const turnOf = turns[room];

  if (!turnOf) {
    turns[room] = players[0];
    return players[0];
  }

  const index = players.findIndex((player: any) => player.id == turnOf.id);
  let nextPlayer = players[index + 1];
  if (!nextPlayer) {
    nextPlayer = players[0];
  }

  turns[room] = nextPlayer;
  game[room].turn = nextPlayer;

  return nextPlayer;
}

export function nextTurn(room: string) {
  nextLiteralTurn(room);
  let turn = getTurn(room);

  while (!turn.cards.length) {
    nextLiteralTurn(room);
    turn = getTurn(room);
  }
}

// const createRoom = (room: string): object => JSON.pa rse(msg);
// const joinRoom = (room: string): object => JSON.parse(msg);

type Req = {
  type:
    | 'get'
    | 'isGameStarted'
    | 'createRoom'
    | 'updatePlayerName'
    | 'playTurn'
    | 'startGame';
  room?: string;
  content?: any;
  game?: any;
  player?: any;
  action?: string;
  target?: any;
  discussionId?: string;
};
// Initialize WebSocket server
const wss = new WebSocket.Server({port: 8000});

wss.on('connection', ws => {
  console.log('A new client connected.');
  ws.on('message', message => {
    const req: Req = parse(message.toString());
    console.log(req);
    switch (req.type) {
      case 'isGameStarted':
        if (!req.room) return;
        if (!game[req.room]) {
          ws.send(JSON.stringify({type: 'isGameStarted', data: false}));
          return;
        }

        if (
          game[req.room].players.some(
            (player: any) => player.id == req.player.id,
          ) &&
          game[req.room].isGameStarted == true
        ) {
          sendGameState(req.room);
        }

        break;
      case 'createRoom':
        if (!req.room) return;
        if (!game[req.room]) {
          game[req.room] = req.game;
          game[req.room].players[0].isHost = true;
        }
        const playerIsInGame = game[req.room].players.some(
          (player: any) => player.id == req.game.players[0].id,
        );
        if (!playerIsInGame && game[req.room].isGameStarted) return;
        if (!clients[req.room]) clients[req.room] = [];
        saveClientIfDoesntExist(req.room, ws);
        if (!playerIsInGame && !game[req.room].isGameStarted) {
          req.game.players[0].isHost = false;
          game[req.room].players.push(req.game.players[0]);
        }

        sendGameState(req.room);
        break;
      case 'updatePlayerName':
        if (!req.room) return;
        if (!clients[req.room]) return;
        if (!game[req.room]) return;
        const room = req.room;
        game[room].players.forEach((player: any, index: number) => {
          if (player.id == req.player.id) {
            game[room].players[index].name = req.player.name;
          }
        });
        saveClientIfDoesntExist(room, ws);

        sendGameState(req.room);
        break;
      case 'startGame':
        if (!req.room) return;
        if (!game[req.room]) return;
        /* Repartir cartas */
        sendGameState(req.room);
        dealCards(game[req.room].deck, game[req.room].players);
        dealCoins(game[req.room].players, 2);

        game[req.room].isGameStarted = true;
        game[req.room].turn = nextLiteralTurn(req.room);
        sendGameStarts(req.room);
        sendGameState(req.room);
        break;
      case 'playTurn':
        if (!req.room) return;
        if (!game[req.room]) return;

        const turnFinished = action(
          req.room,
          req.player,
          req.action,
          req.target ? req.target : undefined,
          game,
          req.discussionId,
        );
        if (turnFinished) nextTurn(req.room);

        sendGameState(req.room);
        break;

      default:
        break;
    }
    console.log('Received message:', req);
    /* 
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    }); */
  });

  ws.on('close', () => {
    console.log('A client disconnected.');
  });
});

const port = 5678;
app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`);
});
