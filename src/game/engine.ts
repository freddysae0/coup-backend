import {
  ACTIONS,
  LogEvent,
  LossReason,
  ActionType,
  Continuation,
  FORCED_COUP_COINS,
  GameError,
  LogEntry,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PendingAction,
  Phase,
  PlayerState,
  Role,
  ROLES,
} from './types';

export type Rng = () => number;

const MAX_LOG = 60;

/**
 * Authoritative Coup game for a single room.
 *
 * Every public method validates the request and throws GameError when it is
 * not allowed in the current phase, so the server can forward the message to
 * the offending client without touching the state.
 */
export class CoupGame {
  readonly room: string;
  players: PlayerState[] = [];
  deck: Role[] = [];
  phase: Phase = {kind: 'lobby'};
  turnId: string | null = null;
  pending: PendingAction | null = null;
  log: LogEntry[] = [];
  /** Incremented on every state change; used to invalidate timers. */
  version = 0;
  /** Id of the current challenge/block window, so late answers can be ignored. */
  windowId = 0;
  private logSeq = 0;
  private rng: Rng;

  constructor(room: string, rng: Rng = Math.random) {
    this.room = room;
    this.rng = rng;
  }

  // ---------------------------------------------------------------- helpers

  getPlayer(id: string) {
    return this.players.find(p => p.id === id);
  }

  private mustGetPlayer(id: string) {
    const player = this.getPlayer(id);
    if (!player) throw new GameError('notInRoom', 'You are not in this room');
    return player;
  }

  isAlive(player: PlayerState | undefined) {
    return !!player && player.influences.some(i => !i.revealed);
  }

  alivePlayers() {
    return this.players.filter(p => this.isAlive(p));
  }

  aliveCards(player: PlayerState) {
    return player.influences.filter(i => !i.revealed);
  }

  private addLog(text: string, event: LogEvent) {
    this.log.push({id: ++this.logSeq, text, event});
    if (this.log.length > MAX_LOG)
      this.log.splice(0, this.log.length - MAX_LOG);
  }

  private openWindow(
    kind: 'challengeAction' | 'blockAction' | 'challengeBlock',
  ) {
    this.windowId++;
    this.phase = {kind, passed: []};
    this.touch();
  }

  private touch() {
    this.version++;
  }

  private shuffle<T>(arr: T[]) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private buildDeck(playerCount: number) {
    const copies = playerCount <= 6 ? 3 : playerCount <= 8 ? 4 : 5;
    const deck: Role[] = [];
    ROLES.forEach(role => {
      for (let i = 0; i < copies; i++) deck.push(role);
    });
    return this.shuffle(deck);
  }

  private nameOf(id: string | undefined) {
    return (id && this.getPlayer(id)?.name) || 'Someone';
  }

  // ------------------------------------------------------------------ lobby

  join(id: string, name: string) {
    const existing = this.getPlayer(id);
    if (existing) {
      existing.connected = true;
      if (name && this.phase.kind === 'lobby') existing.name = clean(name);
      this.touch();
      return existing;
    }
    if (this.phase.kind !== 'lobby') {
      throw new GameError(
        'alreadyStarted',
        'The game has already started in this room',
      );
    }
    if (this.players.length >= MAX_PLAYERS) {
      throw new GameError(
        'roomFull',
        `This room is full (max ${MAX_PLAYERS} players)`,
        {max: MAX_PLAYERS},
      );
    }
    const player: PlayerState = {
      id,
      name: clean(name) || `Player ${this.players.length + 1}`,
      coins: 0,
      influences: [],
      isHost: this.players.length === 0,
      connected: true,
    };
    this.players.push(player);
    this.addLog(`${player.name} joined the room`, {
      k: 'joined',
      name: player.name,
    });
    this.touch();
    return player;
  }

  rename(id: string, name: string) {
    const player = this.mustGetPlayer(id);
    const newName = clean(name);
    if (!newName) throw new GameError('emptyName', 'Name cannot be empty');
    if (newName === player.name) return;
    this.addLog(`${player.name} is now ${newName}`, {
      k: 'renamed',
      from: player.name,
      to: newName,
    });
    player.name = newName;
    this.touch();
  }

  setConnected(id: string, connected: boolean) {
    const player = this.getPlayer(id);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    this.touch();
  }

  start(id: string) {
    const player = this.mustGetPlayer(id);
    if (this.phase.kind !== 'lobby')
      throw new GameError('alreadyStarted', 'Game already started');
    if (!player.isHost)
      throw new GameError('hostOnly', 'Only the host can start the game');
    if (this.players.length < MIN_PLAYERS) {
      throw new GameError(
        'notEnoughPlayers',
        `At least ${MIN_PLAYERS} players are needed`,
        {min: MIN_PLAYERS},
      );
    }

    this.deck = this.buildDeck(this.players.length);
    this.players.forEach(p => {
      p.influences = this.deck.splice(0, 2).map(role => ({
        role,
        revealed: false,
      }));
      p.coins = 2;
    });
    const first = this.players[Math.floor(this.rng() * this.players.length)];
    // Official two-player variant: the starting player begins with 1 coin.
    if (this.players.length === 2) first.coins = 1;
    this.turnId = first.id;
    this.pending = null;
    this.log = [];
    this.addLog(`Game started. ${first.name} goes first`, {
      k: 'started',
      name: first.name,
    });
    this.phase = {kind: 'action'};
    this.touch();
  }

  /** Host sends everybody back to the lobby after a finished game. */
  restart(id: string) {
    const player = this.mustGetPlayer(id);
    if (this.phase.kind !== 'gameOver') {
      throw new GameError('notOver', 'The game is not over yet');
    }
    if (!player.isHost)
      throw new GameError('hostOnly', 'Only the host can restart');
    this.players = this.players.filter(p => p.connected);
    this.players.forEach(p => {
      p.influences = [];
      p.coins = 0;
    });
    this.ensureHost();
    this.deck = [];
    this.turnId = null;
    this.pending = null;
    this.phase = {kind: 'lobby'};
    this.addLog('Back to the lobby for a new game', {k: 'backToLobby'});
    this.touch();
  }

  private ensureHost() {
    if (this.players.length && !this.players.some(p => p.isHost)) {
      const next = this.players.find(p => p.connected) || this.players[0];
      next.isHost = true;
      this.addLog(`${next.name} is now the host`, {
        k: 'newHost',
        name: next.name,
      });
    }
  }

  /**
   * A player leaves (explicitly, or after being disconnected for too long).
   * In the lobby they are removed; during a game they forfeit all influence.
   */
  leave(id: string) {
    const player = this.getPlayer(id);
    if (!player) return;

    if (this.phase.kind === 'lobby' || this.phase.kind === 'gameOver') {
      this.players = this.players.filter(p => p.id !== id);
      this.addLog(`${player.name} left the room`, {
        k: 'leftRoom',
        name: player.name,
      });
      if (player.isHost) this.ensureHost();
      this.touch();
      return;
    }

    const wasAlive = this.isAlive(player);
    player.influences.forEach(i => (i.revealed = true));
    player.connected = false;
    if (player.isHost) {
      player.isHost = false;
      this.ensureHost();
    }
    if (wasAlive) {
      this.addLog(`${player.name} left the game and forfeits`, {
        k: 'forfeit',
        name: player.name,
      });
    }
    this.touch();
    if (wasAlive) this.reconcileAfterElimination(id);
  }

  /** Repairs the current phase after a player is eliminated out of band. */
  private reconcileAfterElimination(id: string) {
    if (this.checkGameOver()) return;
    const phase = this.phase;
    const pending = this.pending;

    switch (phase.kind) {
      case 'action':
        if (this.turnId === id) this.endTurn();
        return;
      case 'loseInfluence':
        if (phase.playerId === id) this.continueWith(phase.then);
        return;
      case 'exchange':
        if (pending?.actorId === id) {
          this.deck.push(...phase.drawn);
          this.shuffle(this.deck);
          this.endTurn();
        }
        return;
      case 'challengeAction':
      case 'blockAction':
        if (pending?.actorId === id) {
          this.addLog(`${this.nameOf(id)}'s action is cancelled`, {
            k: 'cancelled',
            name: this.nameOf(id),
          });
          this.endTurn();
          return;
        }
        this.advanceIfAllPassed();
        return;
      case 'challengeBlock':
        if (pending?.actorId === id) {
          this.endTurn();
          return;
        }
        if (pending?.block?.blockerId === id) {
          // The block is withdrawn together with the blocker.
          pending.block = undefined;
          this.resolveAction();
          return;
        }
        this.advanceIfAllPassed();
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- actions

  /** Actions the given player may declare right now (empty if not their turn). */
  availableActions(id: string) {
    const player = this.getPlayer(id);
    if (!player || this.phase.kind !== 'action' || this.turnId !== id)
      return [];
    const targets = this.alivePlayers()
      .filter(p => p.id !== id)
      .map(p => p.id);
    const forced = player.coins >= FORCED_COUP_COINS;
    return (Object.keys(ACTIONS) as ActionType[]).map(type => {
      const def = ACTIONS[type];
      let reason: string | undefined;
      let reasonCode: 'mustCoup' | 'needsCoins' | undefined;
      if (forced && type !== 'Coup') {
        reason = 'With 10+ coins you must Coup';
        reasonCode = 'mustCoup';
      } else if (player.coins < def.cost) {
        reason = `Needs ${def.cost} coins`;
        reasonCode = 'needsCoins';
      }
      return {
        type,
        enabled: !reason,
        reason,
        reasonCode,
        cost: def.cost,
        targets: def.targeted ? targets : [],
      };
    });
  }

  declareAction(id: string, type: ActionType, targetId?: string) {
    const player = this.mustGetPlayer(id);
    if (this.phase.kind !== 'action')
      throw new GameError('notNow', 'Not the time to act');
    if (this.turnId !== id)
      throw new GameError('notYourTurn', "It's not your turn");
    const def = ACTIONS[type];
    if (!def) throw new GameError('unknownAction', 'Unknown action');
    if (player.coins >= FORCED_COUP_COINS && type !== 'Coup') {
      throw new GameError('mustCoup', 'With 10 or more coins you must Coup');
    }
    if (player.coins < def.cost) {
      throw new GameError('needsCoins', `${type} costs ${def.cost} coins`, {
        action: type,
        cost: def.cost,
      });
    }
    let target: PlayerState | undefined;
    if (def.targeted) {
      target = targetId ? this.getPlayer(targetId) : undefined;
      if (!target || target.id === id || !this.isAlive(target)) {
        throw new GameError('invalidTarget', 'Choose a valid target');
      }
    }

    player.coins -= def.cost;
    this.pending = {type, actorId: id, targetId: target?.id};
    const claim = def.role ? ` (claims ${def.role})` : '';
    this.addLog(
      `${player.name} → ${type}${target ? ` on ${target.name}` : ''}${claim}`,
      {
        k: 'declare',
        name: player.name,
        action: type,
        ...(target ? {target: target.name} : {}),
        ...(def.role ? {role: def.role} : {}),
      },
    );
    this.touch();

    if (def.role) {
      this.openWindow('challengeAction');
      this.advanceIfAllPassed();
    } else {
      this.afterActionStands();
    }
  }

  // ------------------------------------------------------ response windows

  /** Players who still have to answer in the current response window. */
  responders(): string[] {
    const pending = this.pending;
    if (!pending) return [];
    const alive = this.alivePlayers();
    switch (this.phase.kind) {
      case 'challengeAction':
        return alive.filter(p => p.id !== pending.actorId).map(p => p.id);
      case 'blockAction':
        return this.eligibleBlockers();
      case 'challengeBlock':
        return alive
          .filter(p => p.id !== pending.block?.blockerId)
          .map(p => p.id);
      default:
        return [];
    }
  }

  waitingOn(): string[] {
    const phase = this.phase;
    if (
      phase.kind === 'challengeAction' ||
      phase.kind === 'blockAction' ||
      phase.kind === 'challengeBlock'
    ) {
      return this.responders().filter(id => !phase.passed.includes(id));
    }
    if (phase.kind === 'loseInfluence') return [phase.playerId];
    if (phase.kind === 'exchange' || phase.kind === 'action') {
      return this.turnId ? [this.turnId] : [];
    }
    return [];
  }

  private eligibleBlockers(): string[] {
    const pending = this.pending;
    if (!pending) return [];
    const def = ACTIONS[pending.type];
    if (!def.blockedBy.length) return [];
    if (def.targeted) {
      const target = this.getPlayer(pending.targetId || '');
      return this.isAlive(target) ? [target!.id] : [];
    }
    return this.alivePlayers()
      .filter(p => p.id !== pending.actorId)
      .map(p => p.id);
  }

  private mustRespond(id: string) {
    this.mustGetPlayer(id);
    const phase = this.phase;
    if (
      phase.kind !== 'challengeAction' &&
      phase.kind !== 'blockAction' &&
      phase.kind !== 'challengeBlock'
    ) {
      throw new GameError('nothingToRespond', 'There is nothing to respond to');
    }
    if (!this.responders().includes(id)) {
      throw new GameError('cannotRespond', 'You cannot respond to this');
    }
    if (phase.passed.includes(id))
      throw new GameError('alreadyPassed', 'You already passed');
    return phase;
  }

  pass(id: string) {
    const phase = this.mustRespond(id);
    phase.passed.push(id);
    this.touch();
    this.advanceIfAllPassed();
  }

  /** Everyone who has not answered yet passes (response timer expired). */
  passAll() {
    const phase = this.phase;
    if (
      phase.kind !== 'challengeAction' &&
      phase.kind !== 'blockAction' &&
      phase.kind !== 'challengeBlock'
    ) {
      return;
    }
    this.waitingOn().forEach(id => phase.passed.push(id));
    this.touch();
    this.advanceIfAllPassed();
  }

  private advanceIfAllPassed() {
    const phase = this.phase;
    if (
      phase.kind !== 'challengeAction' &&
      phase.kind !== 'blockAction' &&
      phase.kind !== 'challengeBlock'
    ) {
      return;
    }
    if (this.waitingOn().length > 0) return;

    if (phase.kind === 'challengeAction') {
      this.afterActionStands();
    } else if (phase.kind === 'blockAction') {
      this.resolveAction();
    } else {
      const block = this.pending?.block;
      this.addLog(
        `${this.nameOf(block?.blockerId)} blocks with ${block?.role}. ` +
          `${this.pending?.type} fails`,
        {
          k: 'blockStands',
          name: this.nameOf(block?.blockerId),
          role: block?.role ?? '',
          action: this.pending?.type ?? '',
        },
      );
      this.endTurn();
    }
  }

  challenge(id: string) {
    const phase = this.mustRespond(id);
    const pending = this.pending!;
    const challenger = this.getPlayer(id)!;

    if (phase.kind === 'blockAction') {
      throw new GameError('blockOrPass', 'You can only block or pass now');
    }

    if (phase.kind === 'challengeAction') {
      const actor = this.getPlayer(pending.actorId)!;
      const role = ACTIONS[pending.type].role!;
      this.addLog(`${challenger.name} challenges ${actor.name}'s ${role}`, {
        k: 'challenge',
        name: challenger.name,
        target: actor.name,
        role,
      });
      if (this.revealAndReplace(actor, role)) {
        this.requireLoss(id, 'lostChallenge', 'blockOrResolve');
      } else {
        this.addLog(`${actor.name} was bluffing!`, {
          k: 'bluffing',
          name: actor.name,
        });
        if (pending.type === 'Assassinate')
          actor.coins += ACTIONS.Assassinate.cost;
        this.requireLoss(actor.id, 'caughtBluffing', 'endTurn');
      }
      return;
    }

    // challengeBlock
    const block = pending.block!;
    const blocker = this.getPlayer(block.blockerId)!;
    this.addLog(
      `${challenger.name} challenges ${blocker.name}'s ${block.role}`,
      {
        k: 'challenge',
        name: challenger.name,
        target: blocker.name,
        role: block.role,
      },
    );
    if (this.revealAndReplace(blocker, block.role)) {
      this.addLog(`${pending.type} is blocked`, {
        k: 'isBlocked',
        action: pending.type,
      });
      this.requireLoss(id, 'lostChallenge', 'endTurn');
    } else {
      this.addLog(`${blocker.name} was bluffing! The block fails`, {
        k: 'blockBluff',
        name: blocker.name,
      });
      pending.block = undefined;
      this.requireLoss(blocker.id, 'caughtBluffing', 'resolve');
    }
  }

  block(id: string, role: Role) {
    const phase = this.mustRespond(id);
    if (phase.kind !== 'blockAction')
      throw new GameError('cannotBlock', 'You cannot block now');
    const pending = this.pending!;
    if (!ACTIONS[pending.type].blockedBy.includes(role)) {
      throw new GameError(
        'wrongBlocker',
        `${role} cannot block ${pending.type}`,
        {role, action: pending.type},
      );
    }
    pending.block = {blockerId: id, role};
    this.addLog(`${this.nameOf(id)} blocks ${pending.type} (claims ${role})`, {
      k: 'blockDeclared',
      name: this.nameOf(id),
      action: pending.type,
      role,
    });
    this.openWindow('challengeBlock');
    this.touch();
    this.advanceIfAllPassed();
  }

  /**
   * If the player really holds `role`, they reveal it, shuffle it back and
   * draw a replacement. Returns whether the claim was true.
   */
  private revealAndReplace(player: PlayerState, role: Role) {
    const index = player.influences.findIndex(
      i => !i.revealed && i.role === role,
    );
    if (index === -1) return false;
    this.addLog(
      `${player.name} reveals ${withArticle(role)} and draws a new card`,
      {k: 'reveal', name: player.name, role},
    );
    this.deck.push(role);
    this.shuffle(this.deck);
    player.influences[index] = {role: this.deck.shift()!, revealed: false};
    this.touch();
    return true;
  }

  // ------------------------------------------------------- influence loss

  private requireLoss(
    playerId: string,
    reason: LossReason,
    then: Continuation,
  ) {
    const player = this.getPlayer(playerId);
    const alive = player ? this.aliveCards(player) : [];
    if (!player || alive.length === 0) {
      this.continueWith(then);
      return;
    }
    if (alive.length === 1) {
      this.revealInfluence(player, player.influences.indexOf(alive[0]), reason);
      if (this.checkGameOver()) return;
      this.continueWith(then);
      return;
    }
    this.phase = {kind: 'loseInfluence', playerId, reason, then};
    this.touch();
  }

  private revealInfluence(
    player: PlayerState,
    index: number,
    reason: LossReason,
  ) {
    const influence = player.influences[index];
    influence.revealed = true;
    this.addLog(
      `${player.name} ${REASON_TEXT[reason]} and loses ${withArticle(influence.role)}`,
      {k: 'lose', name: player.name, reason, role: influence.role},
    );
    if (!this.isAlive(player)) {
      this.addLog(`${player.name} is out of the game`, {
        k: 'out',
        name: player.name,
      });
    }
    this.touch();
  }

  loseInfluence(id: string, index: number) {
    const player = this.mustGetPlayer(id);
    const phase = this.phase;
    if (phase.kind !== 'loseInfluence' || phase.playerId !== id) {
      throw new GameError(
        'noLossPending',
        'You do not have to lose a card now',
      );
    }
    const influence = player.influences[index];
    if (!influence || influence.revealed)
      throw new GameError('chooseOwnCard', 'Choose one of your cards');
    this.revealInfluence(player, index, phase.reason);
    if (this.checkGameOver()) return;
    this.continueWith(phase.then);
  }

  private continueWith(then: Continuation) {
    if (this.checkGameOver()) return;
    if (then === 'blockOrResolve') this.afterActionStands();
    else if (then === 'resolve') this.resolveAction();
    else this.endTurn();
  }

  // ------------------------------------------------------------ resolution

  /** The action was not (successfully) challenged: maybe it can be blocked. */
  private afterActionStands() {
    const pending = this.pending!;
    const def = ACTIONS[pending.type];
    if (!this.isAlive(this.getPlayer(pending.actorId))) {
      this.endTurn();
      return;
    }
    if (def.targeted && !this.isAlive(this.getPlayer(pending.targetId || ''))) {
      this.addLog(`${pending.type} has no effect: the target is already out`, {
        k: 'noEffect',
        action: pending.type,
      });
      this.endTurn();
      return;
    }
    if (def.blockedBy.length && this.eligibleBlockers().length) {
      this.openWindow('blockAction');
      this.touch();
      return;
    }
    this.resolveAction();
  }

  private resolveAction() {
    const pending = this.pending!;
    const actor = this.getPlayer(pending.actorId);
    const target = pending.targetId
      ? this.getPlayer(pending.targetId)
      : undefined;
    if (!actor || !this.isAlive(actor)) {
      this.endTurn();
      return;
    }
    if (ACTIONS[pending.type].targeted && !this.isAlive(target)) {
      this.addLog(`${pending.type} has no effect: the target is already out`, {
        k: 'noEffect',
        action: pending.type,
      });
      this.endTurn();
      return;
    }
    this.touch();

    switch (pending.type) {
      case 'Income':
        actor.coins += 1;
        this.addLog(`${actor.name} takes 1 coin`, {
          k: 'income',
          name: actor.name,
        });
        return this.endTurn();
      case 'Foreign aid':
        actor.coins += 2;
        this.addLog(`${actor.name} takes 2 coins of foreign aid`, {
          k: 'foreignAid',
          name: actor.name,
        });
        return this.endTurn();
      case 'Tax':
        actor.coins += 3;
        this.addLog(`${actor.name} takes 3 coins of tax`, {
          k: 'tax',
          name: actor.name,
        });
        return this.endTurn();
      case 'Steal': {
        const amount = Math.min(2, target!.coins);
        target!.coins -= amount;
        actor.coins += amount;
        this.addLog(`${actor.name} steals ${amount} from ${target!.name}`, {
          k: 'steal',
          name: actor.name,
          target: target!.name,
          amount,
        });
        return this.endTurn();
      }
      case 'Coup':
        return this.requireLoss(target!.id, 'couped', 'endTurn');
      case 'Assassinate':
        return this.requireLoss(target!.id, 'assassinated', 'endTurn');
      case 'Exchange': {
        const drawn = this.deck.splice(0, 2);
        this.addLog(`${actor.name} draws ${drawn.length} cards to exchange`, {
          k: 'exchangeDraw',
          name: actor.name,
          count: drawn.length,
        });
        this.phase = {kind: 'exchange', drawn};
        return;
      }
    }
  }

  /** Cards the actor chooses from during an exchange (alive hand + drawn). */
  exchangeOptions(id: string) {
    const phase = this.phase;
    const player = this.getPlayer(id);
    if (phase.kind !== 'exchange' || this.pending?.actorId !== id || !player) {
      return null;
    }
    const hand = this.aliveCards(player).map(i => i.role);
    return {cards: [...hand, ...phase.drawn], keep: hand.length};
  }

  exchange(id: string, keep: number[]) {
    const options = this.exchangeOptions(id);
    if (!options)
      throw new GameError('notExchanging', 'You are not exchanging cards');
    const unique = Array.from(new Set(keep));
    if (
      unique.length !== options.keep ||
      unique.length !== keep.length ||
      unique.some(
        i => !Number.isInteger(i) || i < 0 || i >= options.cards.length,
      )
    ) {
      throw new GameError(
        'keepCount',
        `Choose exactly ${options.keep} cards to keep`,
        {count: options.keep},
      );
    }
    const player = this.getPlayer(id)!;
    const kept = unique.map(i => options.cards[i]);
    const returned = options.cards.filter((_, i) => !unique.includes(i));
    let k = 0;
    player.influences.forEach(inf => {
      if (!inf.revealed) inf.role = kept[k++];
    });
    this.deck.push(...returned);
    this.shuffle(this.deck);
    this.addLog(`${player.name} returns ${returned.length} cards to the deck`, {
      k: 'exchangeReturn',
      name: player.name,
      count: returned.length,
    });
    this.endTurn();
  }

  // ------------------------------------------------------------------ turns

  private checkGameOver() {
    if (this.phase.kind === 'lobby' || this.phase.kind === 'gameOver') {
      return this.phase.kind === 'gameOver';
    }
    const alive = this.alivePlayers();
    if (alive.length > 1) return false;
    const winner = alive[0];
    this.phase = {kind: 'gameOver', winnerId: winner ? winner.id : null};
    this.pending = null;
    if (winner) {
      this.addLog(`${winner.name} wins the game!`, {
        k: 'win',
        name: winner.name,
      });
    } else {
      this.addLog('Nobody wins', {k: 'nobodyWins'});
    }
    this.touch();
    return true;
  }

  private endTurn() {
    if (this.checkGameOver()) return;
    this.pending = null;
    const n = this.players.length;
    const start = Math.max(
      0,
      this.players.findIndex(p => p.id === this.turnId),
    );
    for (let step = 1; step <= n; step++) {
      const next = this.players[(start + step) % n];
      if (this.isAlive(next)) {
        this.turnId = next.id;
        break;
      }
    }
    this.phase = {kind: 'action'};
    this.touch();
  }
}

function withArticle(role: Role) {
  return /^[AEIOU]/.test(role) ? `an ${role}` : `a ${role}`;
}

function clean(name: string | undefined) {
  return (name || '').toString().trim().slice(0, 24);
}

const REASON_TEXT: Record<LossReason, string> = {
  lostChallenge: 'lost a challenge',
  caughtBluffing: 'was caught bluffing',
  couped: 'was couped',
  assassinated: 'was assassinated',
};
