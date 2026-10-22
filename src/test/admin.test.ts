import {test} from 'node:test';
import {StringDecoder} from 'string_decoder';
import assert from 'node:assert/strict';
import {createCoupServer} from '../server';
import {Bot} from '../bot';
import type {AdminEvent, AdminStats, RoomDetail, RoomSummary} from '../admin';
import {safeEqual} from '../admin';
import {createSseParser} from '../telegram/sse';

const TOKEN = 'test-admin-token';
const auth = {Authorization: `Bearer ${TOKEN}`};

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

async function startServer(opts = {}) {
  const coup = createCoupServer({
    heartbeatMs: 60_000,
    responseTimeoutMs: 2000,
    ...opts,
  });
  const port = await coup.listen(0);
  return {
    coup,
    ws: `ws://127.0.0.1:${port}/ws`,
    http: `http://127.0.0.1:${port}`,
  };
}

/** Opens an SSE stream and collects its events. */
async function openEvents(url: string) {
  const events: AdminEvent[] = [];
  const ctrl = new AbortController();
  const res = await fetch(url, {headers: auth, signal: ctrl.signal});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const parse = createSseParser(m => events.push(JSON.parse(m.data)));
  const decoder = new StringDecoder('utf8');
  const done = (async () => {
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>)
        parse(decoder.write(Buffer.from(chunk)));
    } catch {
      // aborted
    }
  })();
  return {
    events,
    async close() {
      ctrl.abort();
      await done;
    },
  };
}

const waitUntil = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 20));
  }
};

test('safeEqual compares tokens', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', 'x'), false);
});

test('admin API is disabled (404) without ADMIN_TOKEN', async () => {
  const {coup, http} = await startServer();
  try {
    const res = await fetch(`${http}/admin/stats`, {headers: auth});
    assert.equal(res.status, 404);
  } finally {
    await coup.close();
  }
});

test('admin API requires the bearer token', async () => {
  const {coup, http} = await startServer({adminToken: TOKEN});
  try {
    for (const path of ['/admin/stats', '/admin/rooms', '/admin/events']) {
      assert.equal((await fetch(http + path)).status, 401, path);
      const wrong = await fetch(http + path, {
        headers: {Authorization: 'Bearer nope'},
      });
      assert.equal(wrong.status, 401, path);
    }
    const ok = await fetch(`${http}/admin/stats`, {headers: auth});
    assert.equal(ok.status, 200);
    const missing = await fetch(`${http}/admin/rooms/none`, {headers: auth});
    assert.equal(missing.status, 404);
  } finally {
    await coup.close();
  }
});

test('stats, rooms, detail and live events follow a real game', async () => {
  const {coup, ws, http} = await startServer({adminToken: TOKEN});
  const get = async <T>(path: string) => {
    const res = await fetch(http + path, {headers: auth});
    assert.equal(res.status, 200, path);
    return (await res.json()) as T;
  };
  const stream = await openEvents(`${http}/admin/events`);
  const roomStream = await openEvents(`${http}/admin/rooms/other/events`);
  const names = ['Ana', 'Beto', 'Caro'];
  const bots = names.map(
    (name, i) =>
      new Bot({
        url: ws,
        room: 'obs',
        playerId: `secret-id-${i}`,
        name,
        rnd: seeded(7 + i),
      }),
  );
  // A second room that stays in the lobby.
  const idle = new Bot({
    url: ws,
    room: 'other',
    playerId: 'idle-1',
    name: 'Idle',
  });
  try {
    for (const bot of bots) await bot.connect();
    await idle.connect();
    await bots[0].waitFor(s => s.players.length === 3);
    await idle.waitFor(s => s.players.length === 1);

    let stats = await get<AdminStats>('/admin/stats');
    assert.equal(stats.rooms, 2);
    assert.deepEqual(stats.roomsByStatus, {lobby: 2, playing: 0, gameOver: 0});
    assert.equal(stats.playersOnline, 4);
    assert.equal(stats.connections, 4);

    bots[0].send({type: 'start'});
    await bots[0].waitFor(s => s.phase !== 'lobby');

    // While playing: detail never contains hidden cards nor player ids.
    const view = bots[0].state!;
    const detail = await get<RoomDetail>('/admin/rooms/obs');
    assert.equal(detail.playerCount, 3);
    assert.equal(
      detail.status,
      view.phase === 'gameOver' ? 'gameOver' : 'playing',
    );
    const raw = JSON.stringify(detail);
    assert.ok(!raw.includes('secret-id'), 'player ids are not exposed');
    detail.players.forEach(p => {
      assert.deepEqual(Object.keys(p).sort(), [
        'alive',
        'cards',
        'coins',
        'connected',
        'host',
        'name',
        'online',
        'revealed',
      ]);
      // Bots keep playing meanwhile, so only check invariants.
      const seen = view.players.find(v => v.name === p.name)!;
      assert.equal(p.cards + p.revealed.length, seen.cards.length);
      assert.equal(typeof p.coins, 'number');
    });
    assert.ok(!('deck' in detail) && typeof detail.deckCount === 'number');

    stats = await get<AdminStats>('/admin/stats');
    if (view.phase !== 'gameOver') {
      assert.equal(stats.roomsByStatus.playing, 1);
      assert.equal(stats.playersInGames, 3);
    }

    const final = await bots[0].waitFor(s => s.phase === 'gameOver', 60_000);
    const winner = final.players.find(p => p.id === final.winnerId)!.name;

    stats = await get<AdminStats>('/admin/stats');
    assert.equal(stats.gamesStarted, 1);
    assert.equal(stats.gamesFinished, 1);
    assert.deepEqual(stats.roomsByStatus, {lobby: 1, playing: 0, gameOver: 1});

    const {rooms} = await get<{rooms: RoomSummary[]}>('/admin/rooms');
    assert.deepEqual(rooms.map(r => r.id).sort(), ['obs', 'other']);
    const obs = rooms.find(r => r.id === 'obs')!;
    assert.equal(obs.status, 'gameOver');
    assert.equal(obs.winner, winner);
    assert.equal(obs.alive, 1);
    assert.equal(obs.leader[0].name, winner);

    // The global stream saw the whole story, in order.
    await waitUntil(() => stream.events.some(e => e.type === 'gameOver'));
    const ev = stream.events;
    const created = ev.filter(e => e.type === 'roomCreated').map(e => e.room);
    assert.deepEqual(created.sort(), ['obs', 'other']);
    const started = ev.find(e => e.type === 'gameStarted');
    assert.ok(started && started.type === 'gameStarted');
    assert.deepEqual(started.players, names);
    const over = ev.find(e => e.type === 'gameOver');
    assert.ok(over && over.type === 'gameOver' && over.winner === winner);
    const logIds = ev
      .filter(e => e.room === 'obs')
      .flatMap(e => (e.type === 'log' ? e.entries.map(x => x.id) : []));
    assert.deepEqual(
      logIds,
      [...logIds].sort((a, b) => a - b),
      'log entries arrive once and in order',
    );
    assert.equal(new Set(logIds).size, logIds.length);
    const texts = ev.flatMap(e =>
      e.type === 'log' && e.room === 'obs' ? e.entries.map(x => x.text) : [],
    );
    assert.ok(texts.some(t => /Game started/.test(t)));
    assert.ok(texts.some(t => t === `${winner} wins the game!`));
    assert.ok(ev.some(e => e.type === 'phase' && e.room === 'obs'));

    // The per-room stream only carries its own room.
    assert.ok(roomStream.events.length > 0);
    assert.ok(roomStream.events.every(e => e.room === 'other'));
  } finally {
    await stream.close();
    await roomStream.close();
    await Promise.all([...bots, idle].map(b => b.disconnect()));
    await coup.close();
  }
});

test('room deletion is announced on the stream', async () => {
  const {coup, ws, http} = await startServer({
    adminToken: TOKEN,
    emptyRoomTtlMs: 50,
  });
  const stream = await openEvents(`${http}/admin/events`);
  const bot = new Bot({url: ws, room: 'gone', playerId: 'p1', name: 'P'});
  try {
    await bot.connect();
    await bot.waitFor(s => s.players.length === 1);
    await bot.disconnect();
    await waitUntil(() => stream.events.some(e => e.type === 'roomDeleted'));
    const stats = (await (
      await fetch(`${http}/admin/stats`, {headers: auth})
    ).json()) as AdminStats;
    assert.equal(stats.rooms, 0);
  } finally {
    await stream.close();
    await coup.close();
  }
});
