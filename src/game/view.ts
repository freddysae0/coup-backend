import {CoupGame} from './engine';
import {ACTIONS, PhaseKind, Role} from './types';

export type CardView = {role: Role | null; revealed: boolean};

export type PlayerView = {
  id: string;
  name: string;
  coins: number;
  isHost: boolean;
  connected: boolean;
  alive: boolean;
  cards: CardView[];
};

export type Options = {
  actions: ReturnType<CoupGame['availableActions']>;
  canChallenge: boolean;
  canPass: boolean;
  blockRoles: Role[];
  loseInfluence: boolean;
  exchange: {cards: Role[]; keep: number} | null;
  canStart: boolean;
  canRestart: boolean;
};

export type GameView = {
  room: string;
  you: string;
  version: number;
  windowId: number;
  phase: PhaseKind;
  players: PlayerView[];
  deckCount: number;
  turnId: string | null;
  pending: {
    type: string;
    actorId: string;
    targetId?: string;
    claim?: Role;
    block?: {blockerId: string; role: Role};
  } | null;
  loss: {playerId: string; reason: string} | null;
  waitingOn: string[];
  winnerId: string | null;
  deadline: number | null;
  log: {id: number; text: string}[];
  options: Options;
};

/**
 * Builds what a single player is allowed to see: their own cards, revealed
 * cards of everybody, and only counts for everything else.
 */
export function viewFor(
  game: CoupGame,
  playerId: string,
  deadline: number | null = null,
): GameView {
  const phase = game.phase;
  const pending = game.pending;
  const waitingOn = game.waitingOn();
  const me = game.getPlayer(playerId);
  const responding =
    (phase.kind === 'challengeAction' ||
      phase.kind === 'blockAction' ||
      phase.kind === 'challengeBlock') &&
    waitingOn.includes(playerId);

  const options: Options = {
    actions: game.availableActions(playerId),
    canChallenge:
      responding &&
      (phase.kind === 'challengeAction' || phase.kind === 'challengeBlock'),
    canPass: responding,
    blockRoles:
      responding && phase.kind === 'blockAction' && pending
        ? ACTIONS[pending.type].blockedBy
        : [],
    loseInfluence:
      phase.kind === 'loseInfluence' && phase.playerId === playerId,
    exchange: game.exchangeOptions(playerId),
    canStart:
      phase.kind === 'lobby' && !!me?.isHost && game.players.length >= 2,
    canRestart: phase.kind === 'gameOver' && !!me?.isHost,
  };

  return {
    room: game.room,
    you: playerId,
    version: game.version,
    windowId: game.windowId,
    phase: phase.kind,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      coins: p.coins,
      isHost: p.isHost,
      connected: p.connected,
      alive: game.isAlive(p),
      cards: p.influences.map(i => ({
        role: i.revealed || p.id === playerId ? i.role : null,
        revealed: i.revealed,
      })),
    })),
    deckCount: game.deck.length,
    turnId: game.turnId,
    pending: pending
      ? {
          type: pending.type,
          actorId: pending.actorId,
          targetId: pending.targetId,
          claim: ACTIONS[pending.type].role,
          block: pending.block,
        }
      : null,
    loss:
      phase.kind === 'loseInfluence'
        ? {playerId: phase.playerId, reason: phase.reason}
        : null,
    waitingOn,
    winnerId: phase.kind === 'gameOver' ? phase.winnerId : null,
    deadline,
    log: game.log.slice(-30),
    options,
  };
}
