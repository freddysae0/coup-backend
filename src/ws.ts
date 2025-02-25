import WebSocket from 'ws';

export const wss = new WebSocket.Server({port: 8000});
