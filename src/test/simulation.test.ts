import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCoupServer} from '../server';
import {Bot} from '../bot';
import {ROLES} from '../game/types';
import type {GameView} from '../game/view';

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

async function startServer(opts = {}) {
  const coup = createCoupServer({heartbeatMs: 60_000, ...opts});
  const port = await coup.listen(0);
  return {coup, url: `ws://127.0.0.1:${port}/ws`};
}

/** No player should ever receive the hidden cards of somebody else. */
function assertNoLeaks(view: GameView) {
  view.players
    .filter(p => p.id !== view.you)
    .forEach(p =>
      p.cards.forEach(c =>
        assert.ok(c.revealed || c.role === null, 'leaked card'),
      ),
    );
}

test('simulated 4-player game over WebSockets, with a reconnection', async () => {
  const {coup, url} = await startServer({responseTimeoutMs: 2000});
  const room = 'sim-room';
  const names = ['Ana', 'Beto', 'Caro', 'Dani'];
  const bots = names.map(
    (name, i) =>
      new Bot({url, room, playerId: `bot-${i}`, name, rnd: seeded(42 + i)}),
  );
  try {
    for (const bot of bots) await bot.connect();
    await bots[0].waitFor(s => s.players.length === 4 && s.options.canStart);
    assert.equal(bots[1].state!.options.canStart, false, 'only host starts');

    bots[0].send({type: 'start'});
    await Promise.all(bots.map(b => b.waitFor(s => s.phase !== 'lobby')));
    bots.forEach(b => {
      const me = b.state!.players.find(p => p.id === b.state!.you)!;
      assert.equal(me.cards.length, 2);
      assert.ok(me.cards.every(c => c.role && ROLES.includes(c.role)));
      assertNoLeaks(b.state!);
    });

    // A late joiner is rejected once the game started.
    const late = new Bot({url, room, playerId: 'late', name: 'Late'});
    await late.connect();
    await new Promise(r => setTimeout(r, 100));
    assert.match(late.errors.join(), /already started/);
    await late.disconnect();

    // Let a few moves happen, then drop and reconnect a player.
    await bots[0].waitFor(s => s.log.length >= 4 || s.phase === 'gameOver');
    if (bots[2].state!.phase !== 'gameOver') {
      const before = bots[2].state!.players.find(p => p.id === 'bot-2')!;
      await bots[2].disconnect();
      await bots[0].waitFor(
        s =>
          s.players.find(p => p.id === 'bot-2')!.connected === false ||
          s.phase === 'gameOver',
      );
      await bots[2].connect();
      const after = await bots[2].waitFor(
        s => s.players.find(p => p.id === 'bot-2')!.connected,
      );
      const me = after.players.find(p => p.id === 'bot-2')!;
      assert.equal(
        me.cards.length,
        before.cards.length,
        'same seat after reconnect',
      );
    }

    const final = await bots[0].waitFor(s => s.phase === 'gameOver', 60_000);
    assert.ok(final.winnerId, 'there is a winner');
    const winner = final.players.find(p => p.id === final.winnerId)!;
    assert.ok(winner.alive);
    assert.equal(final.players.filter(p => p.alive).length, 1);
    bots.forEach(b => assertNoLeaks(b.state!));
    bots.forEach(b =>
      assert.deepEqual(b.errors, [], `${b.opts.name} got unexpected errors`),
    );

    // Rematch: host restarts, everybody is back in the lobby and can play again.
    bots[0].send({type: 'restart'});
    await Promise.all(bots.map(b => b.waitFor(s => s.phase === 'lobby')));
    bots[0].send({type: 'start'});
    await Promise.all(bots.map(b => b.waitFor(s => s.phase !== 'lobby')));
  } finally {
    await Promise.all(bots.map(b => b.disconnect()));
    await coup.close();
  }
});

test('many simulated games in parallel rooms all finish', async () => {
  const {coup, url} = await startServer({responseTimeoutMs: 2000});
  try {
    const games = Array.from({length: 12}, async (_, g) => {
      const n = 2 + (g % 5);
      const bots = Array.from(
        {length: n},
        (_, i) =>
          new Bot({
            url,
            room: `room-${g}`,
            playerId: `g${g}-p${i}`,
            name: `P${i}`,
            rnd: seeded(1000 * g + i),
          }),
      );
      for (const bot of bots) await bot.connect();
      await bots[0].waitFor(s => s.players.length === n);
      bots[0].send({type: 'start'});
      const final = await bots[0].waitFor(s => s.phase === 'gameOver', 60_000);
      await Promise.all(bots.map(b => b.disconnect()));
      return final;
    });
    const results = await Promise.all(games);
    results.forEach(r => assert.ok(r.winnerId));
  } finally {
    await coup.close();
  }
});

test('idle responders are auto-passed and absent players forfeit', async () => {
  const {coup, url} = await startServer({
    responseTimeoutMs: 150,
    disconnectGraceMs: 200,
  });
  // Two manual clients: we drive them by hand to check the timers.
  const a = new Bot({url, room: 'timers', playerId: 'a', name: 'A'});
  const b = new Bot({url, room: 'timers', playerId: 'b', name: 'B'});
  const c = new Bot({url, room: 'timers', playerId: 'c', name: 'C'});
  // Disable their brains: we only want the transport.
  [a, b, c].forEach(
    bot =>
      ((bot as unknown as {chooseMove: () => null}).chooseMove = () => null),
  );
  try {
    await a.connect();
    await b.connect();
    await c.connect();
    await a.waitFor(s => s.players.length === 3);
    a.send({type: 'start'});
    const s = await a.waitFor(st => st.phase === 'action');
    const turn = [a, b, c].find(bot => bot.opts.playerId === s.turnId)!;
    const coinsBefore = s.players.find(p => p.id === s.turnId)!.coins;
    turn.send({type: 'action', action: 'Foreign aid'});
    const window = await turn.waitFor(st => st.phase === 'blockAction');
    assert.ok(window.deadline && window.deadline > Date.now() - 50);
    // Nobody answers: after the timeout the foreign aid resolves.
    const after = await turn.waitFor(
      st => st.phase === 'action' && st.turnId !== turn.opts.playerId,
    );
    assert.equal(
      after.players.find(p => p.id === turn.opts.playerId)!.coins,
      coinsBefore + 2,
    );

    // The next player disconnects and does not come back: they forfeit.
    const next = [a, b, c].find(bot => bot.opts.playerId === after.turnId)!;
    const watcher = [a, b, c].find(bot => bot !== next)!;
    await next.disconnect();
    const forfeited = await watcher.waitFor(
      st => !st.players.find(p => p.id === next.opts.playerId)!.alive,
    );
    assert.notEqual(forfeited.turnId, next.opts.playerId);
  } finally {
    await Promise.all([a, b, c].map(bot => bot.disconnect()));
    await coup.close();
  }
});

test('invalid messages get an error instead of crashing the server', async () => {
  const {coup, url} = await startServer();
  const bot = new Bot({url, room: 'bad', playerId: 'x', name: 'X'});
  try {
    await bot.connect();
    bot.ws.send('not json');
    bot.send({type: 'start'});
    bot.send({type: 'action', action: 'Nuke'});
    bot.send({type: 'join', room: '../etc', playerId: 'x'});
    bot.send({type: 'whatever'});
    await new Promise(r => setTimeout(r, 150));
    assert.ok(bot.errors.includes('Invalid JSON'));
    assert.ok(bot.errors.some(e => /At least 2/.test(e)));
    assert.ok(bot.errors.includes('Unknown action'));
    assert.ok(bot.errors.includes('Invalid room or player id'));
    assert.ok(bot.errors.includes('Unknown message'));
  } finally {
    await bot.disconnect();
    await coup.close();
  }
});
