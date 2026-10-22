import crypto from 'crypto';
import express, {Request, Response, NextFunction} from 'express';
import {CoupGame} from './game/engine';
import {ACTIONS, LogEvent, PhaseKind, Role} from './game/types';

/**
 * Read-only observability API for the owner (used by the Telegram bot).
 *
 * Privacy: it is a spectator view. Hidden (face-down) cards are never exposed,
 * only how many each player has left and the ones already revealed, so the
 * owner can play in a room while watching others without cheating. Player ids
 * are not exposed either: they act as seat credentials on the WebSocket.
 */

/** The part of a server room the admin API needs. */
export type AdminRoom = {
  game: CoupGame;
  sockets: Map<string, unknown>;
  createdAt: number;
  lastActivity: number;
};

/** Coarse status used for counting: everything between start and the end is "playing". */
export type RoomStatus = 'lobby' | 'playing' | 'gameOver';

export const statusOf = (kind: PhaseKind): RoomStatus =>
  kind === 'lobby' ? 'lobby' : kind === 'gameOver' ? 'gameOver' : 'playing';

export type AdminLogEntry = {id: number; text: string; event: LogEvent};

export type AdminEvent = {room: string; at: number} & (
  | {type: 'roomCreated'}
  | {type: 'roomDeleted'}
  | {type: 'log'; entries: AdminLogEntry[]}
  | {type: 'phase'; phase: PhaseKind; status: RoomStatus; turn: string | null}
  | {type: 'gameStarted'; players: string[]}
  | {type: 'gameOver'; winner: string | null}
);

export type Standing = {name: string; cards: number; coins: number};

/** Alive players, best first: more influence left, then more coins. */
export function standings(game: CoupGame): Standing[] {
  return game
    .alivePlayers()
    .map(p => ({
      name: p.name,
      cards: game.aliveCards(p).length,
      coins: p.coins,
    }))
    .sort((a, b) => b.cards - a.cards || b.coins - a.coins);
}

const nameOf = (game: CoupGame, id: string | null | undefined) =>
  (id && game.getPlayer(id)?.name) || null;

const winnerOf = (game: CoupGame) =>
  game.phase.kind === 'gameOver' ? nameOf(game, game.phase.winnerId) : null;

const iso = (ms: number) => new Date(ms).toISOString();

export function roomSummary(id: string, entry: AdminRoom) {
  const game = entry.game;
  const board = standings(game);
  return {
    id,
    phase: game.phase.kind,
    status: statusOf(game.phase.kind),
    players: game.players.length,
    alive: game.phase.kind === 'lobby' ? game.players.length : board.length,
    connected: entry.sockets.size,
    turn: nameOf(game, game.turnId),
    winner: winnerOf(game),
    leader: game.phase.kind === 'lobby' ? [] : board.slice(0, 3),
    createdAt: iso(entry.createdAt),
    lastActivity: iso(entry.lastActivity),
  };
}

export function roomDetail(id: string, entry: AdminRoom, logLimit = 25) {
  const game = entry.game;
  const pending = game.pending;
  const phase = game.phase;
  return {
    ...roomSummary(id, entry),
    players: game.players.map(p => ({
      name: p.name,
      coins: p.coins,
      cards: game.aliveCards(p).length,
      revealed: p.influences.filter(i => i.revealed).map(i => i.role) as Role[],
      alive: game.isAlive(p),
      connected: p.connected,
      online: entry.sockets.has(p.id),
      host: p.isHost,
    })),
    playerCount: game.players.length,
    deckCount: game.deck.length,
    pending: pending
      ? {
          action: pending.type,
          actor: nameOf(game, pending.actorId),
          target: nameOf(game, pending.targetId),
          claim: ACTIONS[pending.type].role ?? null,
          block: pending.block
            ? {
                by: nameOf(game, pending.block.blockerId),
                role: pending.block.role,
              }
            : null,
        }
      : null,
    losing:
      phase.kind === 'loseInfluence'
        ? {player: nameOf(game, phase.playerId), reason: phase.reason}
        : null,
    waitingOn: game.waitingOn().map(pid => nameOf(game, pid)),
    log: game.log
      .slice(-logLimit)
      .map(({id, text, event}) => ({id, text, event})),
  };
}

/** Constant-time comparison that does not leak the token length either. */
export function safeEqual(a: string, b: string) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

type Tracked = {lastLogId: number; status: RoomStatus; phase: PhaseKind};

export type AdminOptions = {
  rooms: Map<string, AdminRoom>;
  /** Open WebSocket connections, for the stats. */
  sockets: () => number;
  /** Bearer token; when empty the HTTP routes are not mounted at all. */
  token?: string;
  sseHeartbeatMs?: number;
};

export function createAdmin(opts: AdminOptions) {
  const {rooms} = opts;
  const bootedAt = Date.now();
  const tracked = new Map<string, Tracked>();
  const streams = new Set<{res: Response; room?: string}>();
  let gamesStarted = 0;
  let gamesFinished = 0;

  const emit = (event: AdminEvent) => {
    const chunk = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    streams.forEach(s => {
      if (!s.room || s.room === event.room) s.res.write(chunk);
    });
  };

  const track = (game: CoupGame): Tracked => ({
    lastLogId: game.log.length ? game.log[game.log.length - 1].id : 0,
    status: statusOf(game.phase.kind),
    phase: game.phase.kind,
  });

  /** Server hook: a room was just created. */
  const roomCreated = (id: string, entry: AdminRoom) => {
    tracked.set(id, track(entry.game));
    emit({type: 'roomCreated', room: id, at: Date.now()});
  };

  /** Server hook: a room was garbage-collected. */
  const roomDeleted = (id: string) => {
    tracked.delete(id);
    emit({type: 'roomDeleted', room: id, at: Date.now()});
  };

  /** Server hook: called after every state change of a room. */
  const changed = (id: string, entry: AdminRoom) => {
    const game = entry.game;
    const at = Date.now();
    const prev = tracked.get(id) ?? {
      lastLogId: 0,
      status: 'lobby' as RoomStatus,
      phase: 'lobby' as PhaseKind,
    };
    const next = track(game);
    tracked.set(id, next);

    const entries = game.log
      .filter(e => e.id > prev.lastLogId)
      .map(({id, text, event}) => ({id, text, event}));
    if (entries.length) emit({type: 'log', room: id, at, entries});

    if (next.phase !== prev.phase) {
      emit({
        type: 'phase',
        room: id,
        at,
        phase: next.phase,
        status: next.status,
        turn: nameOf(game, game.turnId),
      });
    }
    if (next.status !== prev.status) {
      if (next.status === 'playing' && prev.status === 'lobby') {
        gamesStarted++;
        emit({
          type: 'gameStarted',
          room: id,
          at,
          players: game.players.map(p => p.name),
        });
      } else if (next.status === 'gameOver') {
        gamesFinished++;
        emit({type: 'gameOver', room: id, at, winner: winnerOf(game)});
      }
    }
  };

  const stats = () => {
    const byStatus: Record<RoomStatus, number> = {
      lobby: 0,
      playing: 0,
      gameOver: 0,
    };
    let players = 0;
    let playersOnline = 0;
    let playersInGames = 0;
    rooms.forEach(entry => {
      const status = statusOf(entry.game.phase.kind);
      byStatus[status]++;
      players += entry.game.players.length;
      playersOnline += entry.sockets.size;
      if (status === 'playing') playersInGames += entry.game.players.length;
    });
    return {
      rooms: rooms.size,
      roomsByStatus: byStatus,
      players,
      playersOnline,
      playersInGames,
      connections: opts.sockets(),
      gamesStarted,
      gamesFinished,
      startedAt: iso(bootedAt),
      uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
    };
  };

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !safeEqual(match[1].trim(), opts.token!)) {
      res.status(401).json({error: 'unauthorized'});
      return;
    }
    next();
  };

  const stream = (req: Request, res: Response, room?: string) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const client = {res, room};
    streams.add(client);
    const ping = setInterval(
      () => res.write(': ping\n\n'),
      opts.sseHeartbeatMs ?? 20_000,
    ).unref();
    req.on('close', () => {
      clearInterval(ping);
      streams.delete(client);
    });
  };

  const router = express.Router();
  if (opts.token) {
    router.use('/admin', auth);
    router.get('/admin/stats', (_req, res) => {
      res.json(stats());
    });
    router.get('/admin/rooms', (_req, res) => {
      const list = [...rooms.entries()]
        .map(([id, entry]) => roomSummary(id, entry))
        .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
      res.json({rooms: list});
    });
    router.get('/admin/rooms/:id', (req, res) => {
      const entry = rooms.get(req.params.id);
      if (!entry) {
        res.status(404).json({error: 'notFound'});
        return;
      }
      res.json(roomDetail(req.params.id, entry));
    });
    // Global stream (optionally filtered with ?room=) and a per-room alias.
    router.get('/admin/events', (req, res) => {
      const room = typeof req.query.room === 'string' ? req.query.room : '';
      stream(req, res, room || undefined);
    });
    router.get('/admin/rooms/:id/events', (req, res) => {
      stream(req, res, req.params.id);
    });
  }

  return {
    router,
    roomCreated,
    roomDeleted,
    changed,
    stats,
    close() {
      streams.forEach(s => s.res.end());
      streams.clear();
    },
  };
}

export type RoomSummary = ReturnType<typeof roomSummary>;
export type RoomDetail = ReturnType<typeof roomDetail>;
export type AdminStats = ReturnType<ReturnType<typeof createAdmin>['stats']>;
