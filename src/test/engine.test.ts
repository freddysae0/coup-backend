import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CoupGame} from '../game/engine';
import {ACTIONS, ActionType, GameError, Role} from '../game/types';
import {viewFor} from '../game/view';

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

/** Started game with fixed hands; player "a" has the turn. */
function setup(hands: Role[][], coins: number[] = []) {
  const game = new CoupGame('room');
  hands.forEach((_, i) => game.join(IDS[i], IDS[i].toUpperCase()));
  game.start('a');
  // Put every dealt card back and hand out the requested ones.
  game.players.forEach(p => {
    game.deck.push(...p.influences.map(i => i.role));
  });
  game.players.forEach((p, i) => {
    p.influences = hands[i].map(role => {
      game.deck.splice(game.deck.indexOf(role), 1);
      return {role, revealed: false};
    });
    p.coins = coins[i] ?? 2;
  });
  game.turnId = 'a';
  return game;
}

const p = (game: CoupGame, id: string) => game.getPlayer(id)!;
const alive = (game: CoupGame, id: string) =>
  game.aliveCards(p(game, id)).map(i => i.role);
const passAll = (game: CoupGame) =>
  game.waitingOn().forEach(id => game.pass(id));
const totalCards = (game: CoupGame) =>
  game.deck.length +
  game.players.reduce((n, pl) => n + pl.influences.length, 0) +
  (game.phase.kind === 'exchange' ? game.phase.drawn.length : 0);

// ------------------------------------------------------------------ lobby

test('lobby: host, rename, start rules and late joins', () => {
  const game = new CoupGame('r');
  game.join('a', 'Ana');
  assert.equal(p(game, 'a').isHost, true);
  assert.throws(() => game.start('a'), GameError); // only one player
  game.join('b', '');
  assert.equal(p(game, 'b').name, 'Player 2');
  game.rename('b', '  Beto  ');
  assert.equal(p(game, 'b').name, 'Beto');
  assert.throws(() => game.start('b'), /host/);
  game.start('a');
  assert.equal(game.phase.kind, 'action');
  assert.equal(totalCards(game), 15);
  assert.throws(() => game.join('c', 'Late'), /already started/);
  // A known player can reconnect after the start.
  game.setConnected('a', false);
  game.join('a', 'Ana');
  assert.equal(p(game, 'a').connected, true);
});

test('lobby: two-player start gives the first player 1 coin', () => {
  const game = new CoupGame('r', () => 0);
  game.join('a', 'A');
  game.join('b', 'B');
  game.start('a');
  assert.equal(game.turnId, 'a');
  assert.equal(p(game, 'a').coins, 1);
  assert.equal(p(game, 'b').coins, 2);
});

test('lobby: host leaving hands the host role to someone else', () => {
  const game = new CoupGame('r');
  game.join('a', 'A');
  game.join('b', 'B');
  game.leave('a');
  assert.equal(game.players.length, 1);
  assert.equal(p(game, 'b').isHost, true);
});

// ---------------------------------------------------------- basic actions

test('income ends the turn immediately', () => {
  const game = setup([
    ['Duke', 'Captain'],
    ['Contessa', 'Assassin'],
  ]);
  game.declareAction('a', 'Income');
  assert.equal(p(game, 'a').coins, 3);
  assert.equal(game.turnId, 'b');
  assert.throws(() => game.declareAction('a', 'Income'), /not your turn/);
});

test('foreign aid: unblocked, blocked, and block challenged both ways', () => {
  let game = setup([
    ['Captain', 'Captain'],
    ['Contessa', 'Assassin'],
    ['Duke', 'Ambassador'],
  ]);
  game.declareAction('a', 'Foreign aid');
  assert.equal(game.phase.kind, 'blockAction');
  assert.deepEqual(game.waitingOn(), ['b', 'c']);
  assert.throws(() => game.challenge('b'), /block or pass/);
  passAll(game);
  assert.equal(p(game, 'a').coins, 4);

  // Real Duke blocks, nobody challenges.
  game = setup([
    ['Captain', 'Captain'],
    ['Contessa', 'Assassin'],
    ['Duke', 'Ambassador'],
  ]);
  game.declareAction('a', 'Foreign aid');
  game.block('c', 'Duke');
  assert.equal(game.phase.kind, 'challengeBlock');
  assert.deepEqual(game.waitingOn(), ['a', 'b']);
  passAll(game);
  assert.equal(p(game, 'a').coins, 2);
  assert.equal(game.turnId, 'b');

  // Real Duke is challenged: challenger loses, Duke is replaced.
  game = setup([
    ['Captain', 'Captain'],
    ['Contessa', 'Assassin'],
    ['Duke', 'Ambassador'],
  ]);
  game.declareAction('a', 'Foreign aid');
  game.block('c', 'Duke');
  game.challenge('a');
  assert.equal(game.phase.kind, 'loseInfluence');
  game.loseInfluence('a', 0);
  assert.deepEqual(alive(game, 'a'), ['Captain']);
  assert.equal(p(game, 'a').coins, 2);
  assert.equal(alive(game, 'c').length, 2);
  assert.equal(totalCards(game), 15);

  // Fake Duke is challenged: blocker loses, foreign aid goes through.
  game = setup([
    ['Captain', 'Captain'],
    ['Contessa', 'Assassin'],
    ['Duke', 'Ambassador'],
  ]);
  game.declareAction('a', 'Foreign aid');
  game.block('b', 'Duke');
  game.challenge('c');
  game.loseInfluence('b', 1);
  assert.deepEqual(alive(game, 'b'), ['Contessa']);
  assert.equal(p(game, 'a').coins, 4);
  assert.equal(game.turnId, 'b');
});

test('tax: unchallenged, truthful challenge and bluff challenge', () => {
  let game = setup([
    ['Duke', 'Captain'],
    ['Contessa', 'Assassin'],
  ]);
  game.declareAction('a', 'Tax');
  assert.equal(game.phase.kind, 'challengeAction');
  game.pass('b');
  assert.equal(p(game, 'a').coins, 5);

  game = setup([
    ['Duke', 'Captain'],
    ['Contessa', 'Assassin'],
  ]);
  game.declareAction('a', 'Tax');
  game.challenge('b');
  game.loseInfluence('b', 0);
  assert.equal(p(game, 'a').coins, 5);
  assert.equal(alive(game, 'a').length, 2);
  assert.equal(totalCards(game), 15);

  game = setup([
    ['Contessa', 'Captain'],
    ['Contessa', 'Assassin'],
  ]);
  game.declareAction('a', 'Tax');
  game.challenge('b');
  game.loseInfluence('a', 0);
  assert.equal(p(game, 'a').coins, 2);
  assert.deepEqual(alive(game, 'a'), ['Captain']);
  assert.equal(game.turnId, 'b');
});

test('coup: costs 7, victim chooses, last card is lost automatically', () => {
  const game = setup(
    [
      ['Duke', 'Captain'],
      ['Contessa', 'Assassin'],
      ['Duke', 'Duke'],
    ],
    [14, 2, 2],
  );
  assert.throws(() => game.declareAction('a', 'Coup'), /valid target/);
  assert.throws(() => game.declareAction('a', 'Coup', 'a'), /valid target/);
  game.declareAction('a', 'Coup', 'b');
  assert.equal(p(game, 'a').coins, 7);
  assert.deepEqual(game.waitingOn(), ['b']);
  assert.throws(() => game.loseInfluence('c', 0), /do not have to/);
  game.loseInfluence('b', 1);
  assert.deepEqual(alive(game, 'b'), ['Contessa']);
  // b's turn: income; c's turn: income; a coups b again (1 card -> automatic).
  game.declareAction('b', 'Income');
  game.declareAction('c', 'Income');
  game.declareAction('a', 'Coup', 'b');
  assert.equal(game.isAlive(p(game, 'b')), false);
  assert.equal(game.turnId, 'c', 'eliminated players are skipped');
});

test('forced coup at 10 coins', () => {
  const game = setup(
    [
      ['Duke', 'Captain'],
      ['Contessa', 'Assassin'],
    ],
    [10, 2],
  );
  assert.throws(() => game.declareAction('a', 'Income'), /must Coup/);
  const opts = game.availableActions('a');
  assert.deepEqual(
    opts.filter(o => o.enabled).map(o => o.type),
    ['Coup'],
  );
  game.declareAction('a', 'Coup', 'b');
  assert.equal(game.phase.kind, 'loseInfluence');
});

test('not enough coins', () => {
  const game = setup(
    [
      ['Assassin', 'Captain'],
      ['Contessa', 'Assassin'],
    ],
    [2, 2],
  );
  assert.throws(() => game.declareAction('a', 'Assassinate', 'b'), /costs 3/);
  assert.throws(() => game.declareAction('a', 'Coup', 'b'), /costs 7/);
});

// ------------------------------------------------------------ assassinate

test('assassinate: success, contessa block, bluffed contessa, double loss', () => {
  // Unopposed.
  let game = setup(
    [
      ['Assassin', 'Captain'],
      ['Contessa', 'Duke'],
      ['Duke', 'Duke'],
    ],
    [3, 2, 2],
  );
  game.declareAction('a', 'Assassinate', 'b');
  assert.equal(p(game, 'a').coins, 0);
  passAll(game); // challenge window
  assert.equal(game.phase.kind, 'blockAction');
  assert.deepEqual(game.waitingOn(), ['b'], 'only the target may block');
  game.pass('b');
  game.loseInfluence('b', 1);
  assert.deepEqual(alive(game, 'b'), ['Contessa']);

  // Real Contessa block: coins are still spent.
  game = setup(
    [
      ['Assassin', 'Captain'],
      ['Contessa', 'Duke'],
      ['Duke', 'Duke'],
    ],
    [3, 2, 2],
  );
  game.declareAction('a', 'Assassinate', 'b');
  passAll(game);
  assert.throws(() => game.block('b', 'Duke'), /cannot block/);
  game.block('b', 'Contessa');
  passAll(game);
  assert.equal(alive(game, 'b').length, 2);
  assert.equal(p(game, 'a').coins, 0);

  // Bluffed Contessa is challenged: target loses both cards.
  game = setup(
    [
      ['Assassin', 'Captain'],
      ['Captain', 'Duke'],
      ['Duke', 'Duke'],
    ],
    [3, 2, 2],
  );
  game.declareAction('a', 'Assassinate', 'b');
  passAll(game);
  game.block('b', 'Contessa');
  game.challenge('a');
  game.loseInfluence('b', 0); // bluff penalty
  // Assassination now resolves, last card goes automatically.
  assert.equal(game.isAlive(p(game, 'b')), false);
  assert.equal(game.turnId, 'c');

  // Target wrongly challenges the assassin, loses one, can still block.
  game = setup(
    [
      ['Assassin', 'Captain'],
      ['Contessa', 'Duke'],
      ['Duke', 'Duke'],
    ],
    [3, 2, 2],
  );
  game.declareAction('a', 'Assassinate', 'b');
  game.challenge('b');
  game.loseInfluence('b', 1);
  assert.equal(game.phase.kind, 'blockAction');
  game.block('b', 'Contessa');
  passAll(game);
  assert.deepEqual(alive(game, 'b'), ['Contessa']);
});

test('assassinate: target eliminated by losing the challenge ends the action', () => {
  const game = setup(
    [
      ['Assassin', 'Captain'],
      ['Duke', 'Duke'],
      ['Duke', 'Captain'],
    ],
    [3, 2, 2],
  );
  p(game, 'b').influences[0].revealed = true;
  game.declareAction('a', 'Assassinate', 'b');
  game.challenge('b'); // loses last card automatically
  assert.equal(game.isAlive(p(game, 'b')), false);
  assert.equal(game.phase.kind, 'action');
  assert.equal(game.turnId, 'c');
});

test('assassinate: bluffing assassin gets the coins back', () => {
  const game = setup(
    [
      ['Duke', 'Captain'],
      ['Contessa', 'Duke'],
    ],
    [3, 2],
  );
  game.declareAction('a', 'Assassinate', 'b');
  game.challenge('b');
  game.loseInfluence('a', 0);
  assert.equal(p(game, 'a').coins, 3);
  assert.equal(alive(game, 'b').length, 2);
});

// ------------------------------------------------------------------ steal

test('steal: takes up to 2, can be blocked by captain or ambassador', () => {
  let game = setup(
    [
      ['Captain', 'Duke'],
      ['Contessa', 'Duke'],
    ],
    [2, 1],
  );
  game.declareAction('a', 'Steal', 'b');
  game.pass('b');
  game.pass('b');
  assert.equal(p(game, 'a').coins, 3);
  assert.equal(p(game, 'b').coins, 0);

  game = setup(
    [
      ['Captain', 'Duke'],
      ['Ambassador', 'Duke'],
    ],
    [2, 5],
  );
  game.declareAction('a', 'Steal', 'b');
  game.pass('b');
  assert.deepEqual(viewFor(game, 'b').options.blockRoles, [
    'Captain',
    'Ambassador',
  ]);
  game.block('b', 'Ambassador');
  game.pass('a');
  assert.equal(p(game, 'b').coins, 5);

  // Stealing from a player with 0 coins is legal and gives nothing.
  game = setup(
    [
      ['Captain', 'Duke'],
      ['Ambassador', 'Duke'],
    ],
    [2, 0],
  );
  game.declareAction('a', 'Steal', 'b');
  game.pass('b');
  game.pass('b');
  assert.equal(p(game, 'a').coins, 2);
});

// --------------------------------------------------------------- exchange

test('exchange: choose exactly as many cards as alive influence', () => {
  const game = setup([
    ['Ambassador', 'Duke'],
    ['Contessa', 'Duke'],
  ]);
  game.declareAction('a', 'Exchange');
  game.pass('b');
  assert.equal(game.phase.kind, 'exchange');
  assert.equal(totalCards(game), 15);
  const opts = game.exchangeOptions('a')!;
  assert.equal(opts.cards.length, 4);
  assert.equal(opts.keep, 2);
  assert.equal(viewFor(game, 'b').options.exchange, null, 'hidden from others');
  assert.throws(() => game.exchange('a', [0]), /exactly 2/);
  assert.throws(() => game.exchange('a', [0, 0]), /exactly 2/);
  assert.throws(() => game.exchange('a', [0, 9]), /exactly 2/);
  game.exchange('a', [2, 3]);
  assert.deepEqual(alive(game, 'a'), [opts.cards[2], opts.cards[3]]);
  assert.equal(totalCards(game), 15);
  assert.equal(game.turnId, 'b');
});

test('exchange with one influence left keeps one card', () => {
  const game = setup([
    ['Ambassador', 'Duke'],
    ['Contessa', 'Duke'],
  ]);
  p(game, 'a').influences[1].revealed = true;
  game.declareAction('a', 'Exchange');
  game.pass('b');
  assert.equal(game.exchangeOptions('a')!.keep, 1);
  game.exchange('a', [1]);
  assert.equal(alive(game, 'a').length, 1);
  assert.equal(
    p(game, 'a').influences[1].role,
    'Duke',
    'revealed card untouched',
  );
});

// ------------------------------------------------------- end and leaving

test('game over and restart back to the lobby', () => {
  const game = setup(
    [
      ['Duke', 'Captain'],
      ['Contessa', 'Assassin'],
    ],
    [7, 2],
  );
  p(game, 'b').influences[0].revealed = true;
  game.declareAction('a', 'Coup', 'b');
  assert.equal(game.phase.kind, 'gameOver');
  assert.equal(viewFor(game, 'a').winnerId, 'a');
  assert.throws(() => game.declareAction('b', 'Income'), GameError);
  assert.throws(() => game.restart('b'), /host/);
  game.restart('a');
  assert.equal(game.phase.kind, 'lobby');
  game.start('a');
  assert.equal((game.phase as {kind: string}).kind, 'action');
});

test('leaving mid-game in every kind of phase keeps the game consistent', () => {
  // Turn player leaves.
  let game = setup([
    ['Duke', 'Captain'],
    ['Contessa', 'Assassin'],
    ['Duke', 'Duke'],
  ]);
  game.leave('a');
  assert.equal(game.turnId, 'b');

  // Actor leaves while others decide whether to challenge.
  game = setup([
    ['Duke', 'Captain'],
    ['Contessa', 'Assassin'],
    ['Duke', 'Duke'],
  ]);
  game.declareAction('a', 'Tax');
  game.leave('a');
  assert.equal(game.phase.kind, 'action');
  assert.equal(game.turnId, 'b');

  // A responder leaves: window continues without them.
  game = setup([
    ['Duke', 'Captain'],
    ['Contessa', 'Assassin'],
    ['Duke', 'Duke'],
  ]);
  game.declareAction('a', 'Tax');
  game.pass('b');
  game.leave('c');
  assert.equal(p(game, 'a').coins, 5);

  // Victim leaves while choosing which card to lose.
  game = setup(
    [
      ['Duke', 'Captain'],
      ['Contessa', 'Assassin'],
      ['Duke', 'Duke'],
    ],
    [7, 2, 2],
  );
  game.declareAction('a', 'Coup', 'b');
  game.leave('b');
  assert.equal(game.phase.kind, 'action');
  assert.equal(game.turnId, 'c');

  // Exchanger leaves: drawn cards go back to the deck.
  game = setup([
    ['Ambassador', 'Captain'],
    ['Contessa', 'Assassin'],
    ['Duke', 'Duke'],
  ]);
  game.declareAction('a', 'Exchange');
  passAll(game);
  game.leave('a');
  assert.equal(totalCards(game), 15);
  assert.equal(game.turnId, 'b');

  // Blocker leaves: block is withdrawn, action resolves.
  game = setup([
    ['Captain', 'Captain'],
    ['Contessa', 'Assassin'],
    ['Duke', 'Duke'],
  ]);
  game.declareAction('a', 'Foreign aid');
  game.block('c', 'Duke');
  game.leave('c');
  assert.equal(p(game, 'a').coins, 4);

  // Last opponent leaves: game over.
  game = setup([
    ['Duke', 'Captain'],
    ['Contessa', 'Assassin'],
  ]);
  game.leave('b');
  assert.equal(game.phase.kind, 'gameOver');
  assert.equal(viewFor(game, 'a').winnerId, 'a');
});

test('response timeout: passAll auto-passes everybody', () => {
  const game = setup([
    ['Duke', 'Captain'],
    ['Contessa', 'Assassin'],
    ['Duke', 'Duke'],
  ]);
  game.declareAction('a', 'Foreign aid');
  game.passAll();
  assert.equal(p(game, 'a').coins, 4);
});

test('views hide other players cards and the deck', () => {
  const game = setup([
    ['Duke', 'Captain'],
    ['Contessa', 'Assassin'],
  ]);
  p(game, 'b').influences[0].revealed = true;
  const view = viewFor(game, 'a');
  assert.deepEqual(
    view.players[0].cards.map(c => c.role),
    ['Duke', 'Captain'],
  );
  assert.deepEqual(
    view.players[1].cards.map(c => c.role),
    ['Contessa', null],
  );
  assert.equal(JSON.stringify(view).includes('"role":"Assassin"'), false);
  assert.equal(view.deckCount, 11);
});

// ------------------------------------------------------------------ fuzz

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** Plays one random but legal move for whoever the game waits on. */
export function randomMove(game: CoupGame, rnd: () => number) {
  const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
  const waiting = game.waitingOn();
  const id = pick(waiting);
  const view = viewFor(game, id);
  const o = view.options;
  if (o.actions.length) {
    const action = pick(o.actions.filter(a => a.enabled));
    game.declareAction(id, action.type as ActionType, pick(action.targets));
  } else if (o.loseInfluence) {
    const idx = view.players
      .find(pl => pl.id === id)!
      .cards.map((c, i) => (c.revealed ? -1 : i))
      .filter(i => i >= 0);
    game.loseInfluence(id, pick(idx));
  } else if (o.exchange) {
    const all = o.exchange.cards.map((_, i) => i).sort(() => rnd() - 0.5);
    game.exchange(id, all.slice(0, o.exchange.keep));
  } else if (o.canPass) {
    const r = rnd();
    if (o.canChallenge && r < 0.2) game.challenge(id);
    else if (o.blockRoles.length && r < 0.4) game.block(id, pick(o.blockRoles));
    else if (r < 0.03) game.leave(id);
    else game.pass(id);
  } else {
    throw new Error(`No move for ${id} in ${game.phase.kind}`);
  }
}

test('fuzz: 3000 random games always finish with consistent state', () => {
  const stats: Record<string, number> = {};
  for (let g = 0; g < 3000; g++) {
    const rnd = seeded(g + 1);
    const n = 2 + (g % 9);
    const game = new CoupGame('fuzz', seeded(g + 7));
    for (let i = 0; i < n; i++) game.join(`p${i}`, `P${i}`);
    game.start('p0');
    const cards = totalCards(game);
    let steps = 0;
    while (game.phase.kind !== 'gameOver') {
      assert.ok(game.waitingOn().length > 0, `stuck in ${game.phase.kind}`);
      const pending = game.pending?.type;
      randomMove(game, rnd);
      if (pending) stats[pending] = (stats[pending] ?? 0) + 1;
      assert.equal(totalCards(game), cards, 'cards are conserved');
      assert.ok(
        game.players.every(pl => pl.coins >= 0),
        'no negative coins',
      );
      assert.ok(++steps < 5000, 'game terminates');
    }
    assert.ok(game.alivePlayers().length <= 1);
  }
  (Object.keys(ACTIONS) as ActionType[])
    .filter(a => ACTIONS[a].role || ACTIONS[a].blockedBy.length)
    .forEach(a => assert.ok(stats[a] > 0, `${a} exercised`));
});
