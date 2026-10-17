import http from 'http';
import {AddressInfo} from 'net';
import express from 'express';
import WebSocket, {WebSocketServer} from 'ws';
import {CoupGame} from './game/engine';
import {
  ACTIONS,
  ActionType,
  GameError,
  PhaseKind,
  Role,
  ROLES,
} from './game/types';
import {viewFor} from './game/view';

export type ServerOptions = {
  port?: number;
  /** Time players have to challenge/block before auto-passing. 0 disables. */
  responseTimeoutMs?: number;
  /** A player disconnected this long during a game forfeits. 0 disables. */
  disconnectGraceMs?: number;
  /** Empty rooms are deleted after this long. */
  emptyRoomTtlMs?: number;
  heartbeatMs?: number;
  log?: (...args: unknown[]) => void;
};

type ClientMessage =
  | {type: 'join'; room: string; playerId: string; name?: string}
  | {type: 'rename'; name: string}
  | {type: 'start'}
  | {type: 'action'; action: ActionType; targetId?: string}
  | {type: 'challenge'; windowId?: number}
  | {type: 'pass'; windowId?: number}
  | {type: 'block'; role: Role; windowId?: number}
  | {type: 'loseCard'; index: number}
  | {type: 'exchange'; keep: number[]}
  | {type: 'leave'}
  | {type: 'restart'}
  | {type: 'ping'};

type Session = {room?: string; playerId?: string; alive: boolean};

type RoomEntry = {
  game: CoupGame;
  sockets: Map<string, Set<WebSocket>>;
  responseTimer?: NodeJS.Timeout;
  windowKey?: string;
  deadline: number | null;
  disconnectTimers: Map<string, NodeJS.Timeout>;
  emptyTimer?: NodeJS.Timeout;
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isResponseWindow = (kind: PhaseKind) =>
  kind === 'challengeAction' ||
  kind === 'blockAction' ||
  kind === 'challengeBlock';

export function createCoupServer(opts: ServerOptions = {}) {
  const responseTimeoutMs = opts.responseTimeoutMs ?? 30_000;
  const disconnectGraceMs = opts.disconnectGraceMs ?? 120_000;
  const emptyRoomTtlMs = opts.emptyRoomTtlMs ?? 10 * 60_000;
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const log = opts.log ?? (() => {});

  const rooms = new Map<string, RoomEntry>();
  let closed = false;
  // Timers never keep the process alive on their own.
  const later = (fn: () => void, ms: number) => setTimeout(fn, ms).unref();
  const sessions = new Map<WebSocket, Session>();

  const app = express();
  app.get('/', (_req, res) => {
    res.json({ok: true, service: 'coup-backend', rooms: rooms.size});
  });
  app.get('/health', (_req, res) => {
    res.json({ok: true});
  });

  const server = http.createServer(app);
  // Accept upgrades on any path ("/", "/ws", ...) so reverse proxies just work.
  const wss = new WebSocketServer({server, maxPayload: 16 * 1024});

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const broadcast = (entry: RoomEntry) => {
    entry.sockets.forEach((set, playerId) => {
      const view = viewFor(entry.game, playerId, entry.deadline);
      set.forEach(ws =>
        send(ws, {
          type: 'state',
          state: view,
          serverTime: Date.now(),
          responseTimeoutMs,
        }),
      );
    });
  };

  /** Starts/stops the auto-pass timer depending on the current phase. */
  const syncResponseTimer = (entry: RoomEntry) => {
    const kind = entry.game.phase.kind;
    if (!isResponseWindow(kind) || responseTimeoutMs <= 0) {
      if (entry.responseTimer) clearTimeout(entry.responseTimer);
      entry.responseTimer = undefined;
      entry.deadline = null;
      return;
    }
    // A new window (or a new sub-window) restarts the countdown; a mere pass
    // inside the same window keeps it.
    const windowKey = `${kind}:${entry.game.pending?.block ? 'b' : 'a'}`;
    if (entry.responseTimer) {
      if (entry.windowKey === windowKey) return;
      clearTimeout(entry.responseTimer);
    }
    entry.windowKey = windowKey;
    entry.deadline = Date.now() + responseTimeoutMs;
    entry.responseTimer = later(() => {
      entry.responseTimer = undefined;
      entry.windowKey = undefined;
      entry.game.passAll();
      afterChange(entry);
    }, responseTimeoutMs);
  };

  const afterChange = (entry: RoomEntry) => {
    syncResponseTimer(entry);
    broadcast(entry);
  };

  const getRoom = (room: string) => {
    let entry = rooms.get(room);
    if (!entry) {
      entry = {
        game: new CoupGame(room),
        sockets: new Map(),
        deadline: null,
        disconnectTimers: new Map(),
      };
      rooms.set(room, entry);
      log(`room ${room} created`);
    }
    if (entry.emptyTimer) {
      clearTimeout(entry.emptyTimer);
      entry.emptyTimer = undefined;
    }
    return entry;
  };

  const detach = (ws: WebSocket) => {
    const session = sessions.get(ws);
    if (!session?.room || !session.playerId) return;
    const entry = rooms.get(session.room);
    const {playerId} = session;
    session.room = undefined;
    session.playerId = undefined;
    if (!entry) return;
    const set = entry.sockets.get(playerId);
    set?.delete(ws);
    if (set && set.size === 0) {
      entry.sockets.delete(playerId);
      onPlayerOffline(entry, playerId);
    }
  };

  const onPlayerOffline = (entry: RoomEntry, playerId: string) => {
    if (closed) return;
    const game = entry.game;
    if (game.phase.kind === 'lobby') {
      // Nobody is waiting on a lobby player: just drop them.
      game.leave(playerId);
    } else {
      game.setConnected(playerId, false);
      if (disconnectGraceMs > 0 && game.isAlive(game.getPlayer(playerId))) {
        entry.disconnectTimers.set(
          playerId,
          later(() => {
            entry.disconnectTimers.delete(playerId);
            if (!entry.sockets.has(playerId)) {
              game.leave(playerId);
              afterChange(entry);
            }
          }, disconnectGraceMs),
        );
      }
    }
    afterChange(entry);
    if (entry.sockets.size === 0) {
      entry.emptyTimer = later(() => {
        if (entry.sockets.size === 0) {
          if (entry.responseTimer) clearTimeout(entry.responseTimer);
          entry.disconnectTimers.forEach(t => clearTimeout(t));
          rooms.delete(entry.game.room);
          log(`room ${entry.game.room} deleted`);
        }
      }, emptyRoomTtlMs);
    }
  };

  const handle = (ws: WebSocket, session: Session, msg: ClientMessage) => {
    if (msg.type === 'ping') return send(ws, {type: 'pong'});

    if (msg.type === 'join') {
      if (!ID_RE.test(String(msg.room)) || !ID_RE.test(String(msg.playerId))) {
        throw new GameError('Invalid room or player id');
      }
      if (session.room) detach(ws);
      const entry = getRoom(msg.room);
      entry.game.join(msg.playerId, String(msg.name ?? ''));
      const timer = entry.disconnectTimers.get(msg.playerId);
      if (timer) {
        clearTimeout(timer);
        entry.disconnectTimers.delete(msg.playerId);
      }
      session.room = msg.room;
      session.playerId = msg.playerId;
      if (!entry.sockets.has(msg.playerId)) {
        entry.sockets.set(msg.playerId, new Set());
      }
      entry.sockets.get(msg.playerId)!.add(ws);
      afterChange(entry);
      return;
    }

    const entry = session.room ? rooms.get(session.room) : undefined;
    if (!entry || !session.playerId) throw new GameError('Join a room first');
    const game = entry.game;
    const me = session.playerId;

    // Answers to a window that already closed (someone else was faster) are
    // expected in a real-time game: drop them silently.
    if (
      (msg.type === 'challenge' ||
        msg.type === 'pass' ||
        msg.type === 'block') &&
      msg.windowId !== undefined &&
      (msg.windowId !== game.windowId ||
        !isResponseWindow(game.phase.kind) ||
        !game.waitingOn().includes(me))
    ) {
      return;
    }

    switch (msg.type) {
      case 'rename':
        game.rename(me, String(msg.name ?? ''));
        break;
      case 'start':
        game.start(me);
        break;
      case 'action':
        if (!(msg.action in ACTIONS)) throw new GameError('Unknown action');
        game.declareAction(me, msg.action, msg.targetId);
        break;
      case 'challenge':
        game.challenge(me);
        break;
      case 'pass':
        game.pass(me);
        break;
      case 'block':
        if (!ROLES.includes(msg.role)) throw new GameError('Unknown role');
        game.block(me, msg.role);
        break;
      case 'loseCard':
        game.loseInfluence(me, Number(msg.index));
        break;
      case 'exchange':
        if (!Array.isArray(msg.keep)) throw new GameError('Invalid exchange');
        game.exchange(me, msg.keep.map(Number));
        break;
      case 'leave':
        game.leave(me);
        detach(ws);
        send(ws, {type: 'left'});
        break;
      case 'restart':
        game.restart(me);
        break;
      default:
        throw new GameError('Unknown message');
    }
    afterChange(entry);
  };

  wss.on('connection', ws => {
    const session: Session = {alive: true};
    sessions.set(ws, session);
    ws.on('pong', () => (session.alive = true));

    ws.on('message', raw => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, {type: 'error', message: 'Invalid JSON'});
      }
      try {
        handle(ws, session, msg);
      } catch (err) {
        if (err instanceof GameError) {
          send(ws, {type: 'error', message: err.message});
        } else {
          log('unexpected error', err);
          send(ws, {type: 'error', message: 'Server error'});
        }
      }
    });

    ws.on('close', () => {
      detach(ws);
      sessions.delete(ws);
    });
    ws.on('error', () => ws.terminate());
  });

  // Drop connections that stopped answering pings (mobile sleep, wifi loss...).
  const heartbeat = setInterval(() => {
    sessions.forEach((session, ws) => {
      if (!session.alive) {
        ws.terminate();
        return;
      }
      session.alive = false;
      ws.ping();
    });
  }, heartbeatMs);

  return {
    app,
    server,
    wss,
    rooms,
    listen(port = opts.port ?? 8000) {
      return new Promise<number>(resolve => {
        server.listen(port, () => {
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      rooms.forEach(entry => {
        if (entry.responseTimer) clearTimeout(entry.responseTimer);
        if (entry.emptyTimer) clearTimeout(entry.emptyTimer);
        entry.disconnectTimers.forEach(t => clearTimeout(t));
      });
      wss.clients.forEach(ws => ws.terminate());
      return new Promise<void>(resolve => {
        wss.close(() => server.close(() => resolve()));
      });
    },
  };
}
