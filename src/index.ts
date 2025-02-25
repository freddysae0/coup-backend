import express from 'express';
import {wss} from './ws';
import {
  createRoom,
  isGameStarted,
  playTurn,
  startGame,
  updatePlayerName,
} from './utils/methods';
import {Req} from './utils/types';
export const app = express();
// Initialize WebSocket server

// const createRoom = (room: string): object => JSON.pa rse(msg);
// const joinRoom = (room: string): object => JSON.parse(msg);

const parse = (msg: string) => JSON.parse(msg);

wss.on('connection', ws => {
  console.log('A new client connected.');
  ws.on('message', message => {
    const req: Req = parse(message.toString());
    console.log('Received message:', req);
    if (req.type == 'isGameStarted') isGameStarted(req, ws);
    if (req.type == 'createRoom') createRoom(req, ws);
    if (req.type == 'updatePlayerName') updatePlayerName(req, ws);
    if (req.type == 'startGame') startGame(req);
    if (req.type == 'playTurn') playTurn(req);
  });

  ws.on('close', () => {
    console.log('A client disconnected.');
  });
});

const port = 5678;
app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`);
});
