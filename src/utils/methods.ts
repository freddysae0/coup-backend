import action from '../actions';
import {state} from './state';
import WebSocket from 'ws';
import {Req} from './types';
export const isGameStarted = (req: any, ws: WebSocket) => {
  if (!req.room) return;
  if (!state.game[req.room]) {
    ws.send(JSON.stringify({type: 'isGameStarted', data: false}));
    return;
  }

  if (
    state.game[req.room].players.some(
      (player: any) => player.id == req.player.id,
    ) &&
    state.game[req.room].isGameStarted == true
  ) {
    state.sendGameState(req.room);
  }
};

export const createRoom = (req: any, ws: WebSocket) => {
  if (!req.room) return;
  if (!state.game[req.room]) {
    state.game[req.room] = req.game;
    state.game[req.room].openDiscussions = [];
    state.game[req.room].players[0].isHost = true;
  }

  const playerIsInGame = state.game[req.room].players.some(
    (player: any) => player.id == req.game.players[0].id,
  );
  if (!playerIsInGame && state.game[req.room].isGameStarted) return;
  if (!state.clients[req.room]) state.clients[req.room] = [];
  state.saveClientIfDoesntExist(req.room, ws);
  if (!playerIsInGame && !state.game[req.room].isGameStarted) {
    req.game.players[0].isHost = false;

    if (state.game[req.room].players.length < 12) {
      state.game[req.room].players.push(req.game.players[0]);
    }
  }

  state.sendGameState(req.room);
};

export const updatePlayerName = (req: any, ws: WebSocket) => {
  if (!req.room) return;
  if (!state.clients[req.room]) return;
  if (!state.game[req.room]) return;
  const room = req.room;
  state.game[room].players.forEach((player: any, index: number) => {
    if (player.id == req.player.id) {
      state.game[room].players[index].name = req.player.name;
    }
  });
  state.saveClientIfDoesntExist(room, ws);

  state.sendGameState(req.room);
};

export const startGame = (req: any) => {
  if (!req.room) return;
  if (!state.game[req.room]) return;
  /* Repartir cartas */
  state.sendGameState(req.room);
  state.dealCards(state.game[req.room].deck, state.game[req.room].players);
  state.dealCoins(state.game[req.room].players, 2);

  state.game[req.room].isGameStarted = true;
  state.game[req.room].turn = state.nextLiteralTurn(req.room);
  state.sendGameStarts(req.room);
  state.sendGameState(req.room);
};

export const playTurn = (req: Req) => {
  if (!req.room) return;
  if (!state.game[req.room]) return;
  console.log('req', req);

  const turnFinished = action(
    req.room,
    req.action,
    req.step,
    req.player,
    req.resolve || false,
    state.game,
    req.playerWhomBeBlessed,
    req.playerWhomBeCoursed,
    req.target ? req.target : undefined,
  );
  if (turnFinished) state.nextTurn(req.room);

  state.sendGameState(req.room);
};
