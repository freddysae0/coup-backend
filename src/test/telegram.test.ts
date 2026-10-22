import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AdminStats, RoomDetail, RoomSummary} from '../admin';
import {createBot} from '../telegram/bot';
import {HttpError} from '../telegram/clients';
import {
  callbackData,
  escapeHtml,
  formatNotice,
  formatRoomDetail,
  formatRoomList,
  MAX_MESSAGE,
  formatStats,
  parseCallback,
  parseChatIds,
  parseCommand,
  translateLog,
  truncate,
} from '../telegram/format';
import {createSseParser, SseMessage} from '../telegram/sse';

const NOW = Date.parse('2026-01-01T12:00:00Z');

const summary = (over: Partial<RoomSummary> = {}): RoomSummary => ({
  id: 'mesa1',
  phase: 'action',
  status: 'playing',
  players: 3,
  alive: 2,
  connected: 3,
  turn: 'Ana',
  winner: null,
  leader: [
    {name: 'Ana', cards: 2, coins: 5},
    {name: 'Beto', cards: 1, coins: 7},
  ],
  createdAt: '2026-01-01T11:00:00.000Z',
  lastActivity: '2026-01-01T11:58:00.000Z',
  ...over,
});

const detail = (over: Partial<RoomDetail> = {}): RoomDetail => ({
  ...summary(),
  players: [
    {
      name: 'Ana',
      coins: 5,
      cards: 2,
      revealed: [],
      alive: true,
      connected: true,
      online: true,
      host: true,
    },
    {
      name: 'Beto <b>',
      coins: 7,
      cards: 1,
      revealed: ['Duke'],
      alive: true,
      connected: true,
      online: false,
      host: false,
    },
    {
      name: 'Caro',
      coins: 0,
      cards: 0,
      revealed: ['Contessa', 'Captain'],
      alive: false,
      connected: true,
      online: true,
      host: false,
    },
  ],
  playerCount: 3,
  deckCount: 9,
  pending: {
    action: 'Steal',
    actor: 'Ana',
    target: 'Beto <b>',
    claim: 'Captain',
    block: null,
  },
  losing: null,
  waitingOn: ['Beto <b>'],
  log: [
    {
      id: 1,
      text: 'Game started. Ana goes first',
      event: {k: 'started', name: 'Ana'},
    },
    {id: 2, text: 'Ana takes 3 coins of tax', event: {k: 'tax', name: 'Ana'}},
  ],
  ...over,
});

test('escapeHtml escapes the characters Telegram HTML cares about', () => {
  assert.equal(escapeHtml('<a & b>'), '&lt;a &amp; b&gt;');
  assert.equal(escapeHtml(undefined), '');
});

test('commands, callbacks and chat ids are parsed', () => {
  assert.deepEqual(parseCommand('/sala abc'), {command: 'sala', args: ['abc']});
  assert.deepEqual(parseCommand('/Seguir@CoupBot  x1 '), {
    command: 'seguir',
    args: ['x1'],
  });
  assert.equal(parseCommand('hola'), null);
  assert.deepEqual(parseCallback(callbackData('follow', 'abc')!), {
    kind: 'follow',
    room: 'abc',
  });
  assert.equal(callbackData('follow', 'x'.repeat(64)), null, '64-byte limit');
  assert.deepEqual([...parseChatIds(' 123, -456 ,bad,')], ['123', '-456']);
});

test('log entries are translated to Spanish with an English fallback', () => {
  assert.equal(
    translateLog({
      text: '',
      event: {
        k: 'declare',
        name: 'Ana',
        action: 'Steal',
        target: 'Beto',
        role: 'Captain',
      },
    }),
    'Ana: Robar → Beto (dice ser Capitán)',
  );
  assert.equal(
    translateLog({
      text: '',
      event: {k: 'lose', name: 'Beto', reason: 'couped', role: 'Duke'},
    }),
    'Beto sufrió un golpe de Estado y revela Duque',
  );
  assert.equal(
    translateLog({text: 'Something new', event: {k: 'brandNew'}}),
    'Something new',
  );
});

test('stats message', () => {
  const stats: AdminStats = {
    rooms: 3,
    roomsByStatus: {lobby: 1, playing: 2, gameOver: 0},
    players: 9,
    playersOnline: 8,
    playersInGames: 6,
    connections: 8,
    gamesStarted: 5,
    gamesFinished: 3,
    startedAt: '2026-01-01T00:00:00.000Z',
    uptimeSec: 3 * 3600 + 120,
  };
  const text = formatStats(stats);
  assert.match(text, /Salas: <b>3<\/b> \(en juego 2, esperando 1/);
  assert.match(text, /conectados: <b>8<\/b>/);
  assert.match(text, /5 \/ 3/);
  assert.match(text, /3h 2m/);
});

test('room list shows leader, turn and one button per room', () => {
  const msg = formatRoomList(
    [
      summary(),
      summary({
        id: 'fin',
        status: 'gameOver',
        phase: 'gameOver',
        winner: 'Caro',
      }),
    ],
    {now: NOW},
  );
  assert.match(msg.text, /Salas \(2\)/);
  assert.match(msg.text, /turno de Ana/);
  assert.match(msg.text, /líder Ana \(2🂠 5🪙\)/);
  assert.match(msg.text, /🏆 Caro/);
  assert.match(msg.text, /hace 2m/);
  assert.deepEqual(
    msg.keyboard!.map(row => row[0].callback_data),
    ['r:mesa1', 'r:fin'],
  );
  assert.equal(formatRoomList([]).keyboard, undefined);
});

test('room list pages stay under the Telegram limit with matching buttons', () => {
  const long = 'x'.repeat(24);
  const rooms = Array.from({length: 30}, (_, i) =>
    summary({
      id: `${String(i).padStart(2, '0')}${'r'.repeat(60)}`,
      turn: long,
      leader: [{name: long, cards: 2, coins: 7}],
    }),
  );
  const seen: string[] = [];
  let page = 0;
  for (;;) {
    const msg = formatRoomList(rooms, {page, now: NOW});
    assert.ok(msg.text.length <= MAX_MESSAGE, `page ${page} too long`);
    const rows = msg.keyboard!;
    const roomRows = rows.filter(row => row[0].callback_data.startsWith('r:'));
    const ids = roomRows.map(row => row[0].callback_data.slice(2));
    for (const id of ids) assert.ok(msg.text.includes(id));
    seen.push(...ids);
    const next = rows
      .flat()
      .find(b => b.text.startsWith('Siguientes'))?.callback_data;
    if (!next) break;
    assert.equal(parseCallback(next)!.kind, 'rooms');
    page = Number(parseCallback(next)!.room);
  }
  assert.deepEqual(
    seen,
    rooms.map(r => r.id),
  );
  // Out-of-range pages fall back to the last one instead of failing.
  assert.match(formatRoomList(rooms, {page: 99, now: NOW}).text, /página/);
});

test('room detail escapes names and only shows counts for hidden cards', () => {
  const msg = formatRoomDetail(detail(), false, NOW);
  assert.ok(!msg.text.includes('Beto <b>'), 'names are escaped');
  assert.match(msg.text, /Beto &lt;b&gt; 📴 — 7🪙 🂠 <s>Duque<\/s>/);
  assert.match(msg.text, /• Ana ⭐ 👑 — 5🪙 🂠🂠/);
  assert.match(msg.text, /Caro 💀 — 0🪙 <s>Condesa<\/s> <s>Capitán<\/s>/);
  assert.match(msg.text, /turno de <b>Ana<\/b>/);
  assert.match(
    msg.text,
    /Ana → Robar contra Beto &lt;b&gt; \(dice ser Capitán\)/,
  );
  assert.match(msg.text, /Ana cobra 3 monedas de impuestos/);
  const datas = msg.keyboard!.flat().map(b => b.callback_data);
  assert.deepEqual(datas, ['r:mesa1', 'f:mesa1', 'l:']);
  const following = formatRoomDetail(detail(), true, NOW);
  assert.ok(
    following.keyboard!.flat().some(b => b.callback_data === 'u:mesa1'),
  );
});

test('notices for game start and end', () => {
  assert.match(
    formatNotice({type: 'gameStarted', room: 'm', at: 0, players: ['A', 'B']})!,
    /Empieza una partida en <b>m<\/b> con 2 jugadores: A, B/,
  );
  assert.match(
    formatNotice({type: 'gameOver', room: 'm', at: 0, winner: 'A'})!,
    /gana <b>A<\/b>/,
  );
  assert.equal(formatNotice({type: 'roomCreated', room: 'm', at: 0}), null);
});

test('truncate keeps messages under the Telegram limit', () => {
  const long = Array.from({length: 1000}, (_, i) => `line ${i}`).join('\n');
  const out = truncate(long, 100);
  assert.ok(out.length <= 100);
  assert.ok(out.endsWith('\n…'));
});

test('SSE parser handles chunked events and ignores comments', () => {
  const got: SseMessage[] = [];
  const feed = createSseParser(m => got.push(m));
  feed(': connected\n\nevent: log\nda');
  feed('ta: {"a":1}\n\ndata: x\ndata: y\n\n');
  assert.deepEqual(got, [
    {event: 'log', data: '{"a":1}'},
    {event: 'message', data: 'x\ny'},
  ]);
});

/** A bot wired to fakes: records Telegram calls, serves canned backend data. */
function fakeBot(rooms: Record<string, RoomDetail> = {}) {
  const calls: {method: string; params: Record<string, unknown>}[] = [];
  const saved: unknown[] = [];
  const bot = createBot({
    allowedChats: new Set(['1']),
    telegram: {
      async call<T>(method: string, params: object = {}) {
        calls.push({method, params: params as Record<string, unknown>});
        return {} as T;
      },
    },
    backend: {
      async get<T>(path: string) {
        const m = /^\/admin\/rooms\/(.+)$/.exec(path);
        if (m) {
          const room = rooms[decodeURIComponent(m[1])];
          if (!room) throw new HttpError(404, 'not found');
          return room as T;
        }
        if (path === '/admin/rooms') return {rooms: Object.values(rooms)} as T;
        throw new HttpError(500, 'boom');
      },
    },
    saveState: s => saved.push(s),
  });
  const texts = () =>
    calls
      .filter(c => c.method === 'sendMessage')
      .map(c => String(c.params.text));
  const msg = (text: string, chat = 1) =>
    bot.handleUpdate({
      update_id: 1,
      message: {message_id: 1, chat: {id: chat}, text},
    });
  return {bot, calls, texts, msg, saved};
}

test('bot answers strangers only with their chat id', async () => {
  const {texts, msg} = fakeBot();
  await msg('/stats', 999);
  await msg('/stats', 999);
  assert.equal(texts().length, 1, 'rate limited');
  assert.match(texts()[0], /<code>999<\/code>/);
});

test('bot follows a room, batches its moves and stops on deletion', async () => {
  const {bot, texts, msg, calls, saved} = fakeBot({mesa1: detail()});
  await msg('/seguir mesa1');
  assert.match(texts()[0], /Siguiendo <b>mesa1<\/b>/);
  assert.match(texts()[1], /Sala mesa1/);
  assert.deepEqual(bot.state().follows, {'1': ['mesa1']});
  assert.ok(saved.length > 0, 'state persisted');

  await msg('/seguir nope');
  assert.match(texts()[2], /No existe esa sala/);
  assert.deepEqual(bot.state().follows, {'1': ['mesa1']});

  const before = texts().length;
  for (const id of [10, 11]) {
    await bot.handleEvent({
      type: 'log',
      room: 'mesa1',
      at: 0,
      entries: [{id, text: '', event: {k: 'income', name: `P${id}`}}],
    });
  }
  await bot.handleEvent({
    type: 'log',
    room: 'other',
    at: 0,
    entries: [{id: 1, text: 'x', event: {k: 'joined', name: 'Z'}}],
  });
  assert.equal(texts().length, before, 'nothing sent until flush');
  await bot.flush();
  assert.equal(texts().length, before + 1, 'one batched message');
  assert.match(
    texts()[before],
    /mesa1[\s\S]*P10 toma 1 moneda\n· P11 toma 1 moneda/,
  );
  assert.ok(!texts()[before].includes('Z entró'));
  await bot.flush();
  assert.equal(texts().length, before + 1, 'empty flush sends nothing');

  // Notices go to every allowed chat unless turned off.
  await bot.handleEvent({
    type: 'gameOver',
    room: 'mesa1',
    at: 0,
    winner: 'Ana',
  });
  assert.match(texts().at(-1)!, /gana <b>Ana<\/b>/);
  await msg('/avisos off');
  const n = texts().length;
  await bot.handleEvent({
    type: 'gameOver',
    room: 'mesa1',
    at: 0,
    winner: 'Ana',
  });
  assert.equal(texts().length, n);

  await bot.handleEvent({type: 'roomDeleted', room: 'mesa1', at: 0});
  assert.match(texts().at(-1)!, /se cerró/);
  assert.deepEqual(bot.state().follows, {});

  // Inline buttons edit the message in place and answer the callback.
  await bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: 'q1',
      data: 'f:mesa1',
      message: {message_id: 5, chat: {id: 1}},
    },
  });
  const editCall = calls.find(c => c.method === 'editMessageText')!;
  assert.equal(editCall.params.message_id, 5);
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery'));
  assert.deepEqual(bot.state().follows, {'1': ['mesa1']});
});

test('bot reports backend problems in Spanish', async () => {
  const {texts, msg} = fakeBot();
  await msg('/stats');
  assert.match(texts()[0], /No puedo hablar con el backend/);
  await msg('/sala ../x');
  assert.match(texts()[1], /no válido/);
  await msg('/foo');
  assert.match(texts()[2], /Comando desconocido/);
});
