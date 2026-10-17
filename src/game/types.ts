export type Role = 'Duke' | 'Assassin' | 'Captain' | 'Ambassador' | 'Contessa';

export const ROLES: Role[] = [
  'Duke',
  'Assassin',
  'Captain',
  'Ambassador',
  'Contessa',
];

export type ActionType =
  | 'Income' // Take 1 coin
  | 'Foreign aid' // Take 2 coins (blockable by Duke)
  | 'Coup' // Pay 7, target loses an influence (unblockable)
  | 'Tax' // Duke: take 3 coins
  | 'Assassinate' // Assassin: pay 3, target loses an influence (blockable by Contessa)
  | 'Steal' // Captain: take up to 2 coins from target (blockable by Captain/Ambassador)
  | 'Exchange'; // Ambassador: draw 2, return 2

export type ActionDef = {
  cost: number;
  role?: Role; // Role the actor claims (challengeable)
  targeted: boolean;
  blockedBy: Role[];
};

export const ACTIONS: Record<ActionType, ActionDef> = {
  Income: {cost: 0, targeted: false, blockedBy: []},
  'Foreign aid': {cost: 0, targeted: false, blockedBy: ['Duke']},
  Coup: {cost: 7, targeted: true, blockedBy: []},
  Tax: {cost: 0, role: 'Duke', targeted: false, blockedBy: []},
  Assassinate: {
    cost: 3,
    role: 'Assassin',
    targeted: true,
    blockedBy: ['Contessa'],
  },
  Steal: {
    cost: 0,
    role: 'Captain',
    targeted: true,
    blockedBy: ['Captain', 'Ambassador'],
  },
  Exchange: {cost: 0, role: 'Ambassador', targeted: false, blockedBy: []},
};

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
export const FORCED_COUP_COINS = 10;

export type Influence = {role: Role; revealed: boolean};

export type PlayerState = {
  id: string;
  name: string;
  coins: number;
  influences: Influence[];
  isHost: boolean;
  connected: boolean;
};

export type PendingAction = {
  type: ActionType;
  actorId: string;
  targetId?: string;
  block?: {blockerId: string; role: Role};
};

/** What happens once a pending influence loss has been paid. */
export type Continuation =
  | 'blockOrResolve' // The action survived a challenge: open block window or resolve
  | 'resolve' // Apply the action effect
  | 'endTurn';

export type Phase =
  | {kind: 'lobby'}
  | {kind: 'action'}
  | {kind: 'challengeAction'; passed: string[]}
  | {kind: 'blockAction'; passed: string[]}
  | {kind: 'challengeBlock'; passed: string[]}
  | {
      kind: 'loseInfluence';
      playerId: string;
      reason: string;
      then: Continuation;
    }
  | {kind: 'exchange'; drawn: Role[]}
  | {kind: 'gameOver'; winnerId: string | null};

export type PhaseKind = Phase['kind'];

export type LogEntry = {id: number; text: string};

export class GameError extends Error {}
