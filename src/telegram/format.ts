/**
 * Pure helpers that turn admin API data into Telegram messages (HTML parse
 * mode). Kept free of I/O so they are easy to test.
 */
import type {
  AdminEvent,
  AdminLogEntry,
  AdminStats,
  RoomDetail,
  RoomSummary,
} from '../admin';
import type {PhaseKind} from '../game/types';

export type Button = {text: string; callback_data: string};
export type Keyboard = Button[][];
export type Message = {text: string; keyboard?: Keyboard};

/** Telegram's hard limit is 4096; keep some margin for safety. */
export const MAX_MESSAGE = 4000;

export const escapeHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const ROLE_ES: Record<string, string> = {
  Duke: 'Duque',
  Assassin: 'Asesino',
  Captain: 'Capitán',
  Ambassador: 'Embajador',
  Contessa: 'Condesa',
};

const ACTION_ES: Record<string, string> = {
  Income: 'Ingresos',
  'Foreign aid': 'Ayuda exterior',
  Coup: 'Golpe de Estado',
  Tax: 'Impuestos',
  Assassinate: 'Asesinar',
  Steal: 'Robar',
  Exchange: 'Intercambiar',
};

const REASON_ES: Record<string, string> = {
  lostChallenge: 'perdió un desafío',
  caughtBluffing: 'fue pillado mintiendo',
  couped: 'sufrió un golpe de Estado',
  assassinated: 'fue asesinado',
};

const STATUS_ES: Record<string, string> = {
  lobby: 'en sala de espera',
  playing: 'en juego',
  gameOver: 'terminada',
};

const PHASE_ES: Record<PhaseKind, string> = {
  lobby: 'sala de espera',
  action: 'esperando acción',
  challengeAction: 'se puede desafiar la acción',
  blockAction: 'se puede bloquear la acción',
  challengeBlock: 'se puede desafiar el bloqueo',
  loseInfluence: 'alguien debe perder una carta',
  exchange: 'intercambiando cartas',
  gameOver: 'partida terminada',
};

const role = (r: unknown) => ROLE_ES[String(r)] ?? String(r ?? '');
const action = (a: unknown) => ACTION_ES[String(a)] ?? String(a ?? '');

type Params = Record<string, string | number>;
const EVENTS_ES: Record<string, (p: Params) => string> = {
  joined: p => `${p.name} entró en la sala`,
  renamed: p => `${p.from} ahora es ${p.to}`,
  started: p => `Empieza la partida. Abre ${p.name}`,
  backToLobby: () => 'De vuelta a la sala de espera',
  newHost: p => `${p.name} es el nuevo anfitrión`,
  leftRoom: p => `${p.name} salió de la sala`,
  forfeit: p => `${p.name} abandonó la partida`,
  cancelled: p => `Se cancela la acción de ${p.name}`,
  declare: p =>
    `${p.name}: ${action(p.action)}${p.target ? ` → ${p.target}` : ''}` +
    `${p.role ? ` (dice ser ${role(p.role)})` : ''}`,
  blockStands: p =>
    `El ${role(p.role)} de ${p.name} frena: ${action(p.action)}`,
  challenge: p => `${p.name} desafía el ${role(p.role)} de ${p.target}`,
  bluffing: p => `¡${p.name} iba de farol!`,
  isBlocked: p => `${action(p.action)} queda bloqueada`,
  blockBluff: p => `${p.name} iba de farol. El bloqueo fracasa`,
  blockDeclared: p =>
    `${p.name} bloquea ${action(p.action)} (dice ser ${role(p.role)})`,
  reveal: p => `${p.name} enseña ${role(p.role)} y roba otra carta`,
  lose: p =>
    `${p.name} ${REASON_ES[String(p.reason)] ?? p.reason} y revela ${role(p.role)}`,
  out: p => `${p.name} queda fuera de la partida`,
  noEffect: p =>
    `${action(p.action)} no tiene efecto: el objetivo ya está fuera`,
  income: p => `${p.name} toma 1 moneda`,
  foreignAid: p => `${p.name} toma 2 monedas de ayuda exterior`,
  tax: p => `${p.name} cobra 3 monedas de impuestos`,
  steal: p => `${p.name} roba ${p.amount} a ${p.target}`,
  exchangeDraw: p => `${p.name} roba ${p.count} cartas`,
  exchangeReturn: p => `${p.name} devuelve ${p.count} cartas al mazo`,
  win: p => `🏆 ¡${p.name} gana la partida!`,
  nobodyWins: () => 'Nadie gana',
};

/** Spanish text of a log entry, falling back to the engine's English text. */
export function translateLog(entry: Pick<AdminLogEntry, 'text' | 'event'>) {
  const fn = entry.event && EVENTS_ES[entry.event.k];
  return fn ? fn(entry.event) : entry.text;
}

export function formatDuration(totalSec: number) {
  const s = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/** "hace 3m" relative to `now`. */
export function ago(isoDate: string, now = Date.now()) {
  return `hace ${formatDuration((now - Date.parse(isoDate)) / 1000)}`;
}

// Callback data is limited to 64 bytes; room ids are at most 64 chars, so a
// button is simply dropped when it would not fit.
export type CallbackAction = 'room' | 'follow' | 'unfollow' | 'rooms';
const CB_PREFIX: Record<CallbackAction, string> = {
  room: 'r:',
  follow: 'f:',
  unfollow: 'u:',
  rooms: 'l:',
};

export function callbackData(kind: CallbackAction, room = '') {
  const data = CB_PREFIX[kind] + room;
  return Buffer.byteLength(data) <= 64 ? data : null;
}

export function parseCallback(
  data: string,
): {kind: CallbackAction; room: string} | null {
  for (const [kind, prefix] of Object.entries(CB_PREFIX)) {
    if (data.startsWith(prefix)) {
      return {kind: kind as CallbackAction, room: data.slice(prefix.length)};
    }
  }
  return null;
}

const button = (text: string, kind: CallbackAction, room?: string) => {
  const data = callbackData(kind, room);
  return data ? [{text, callback_data: data}] : [];
};

export function parseCommand(text: string) {
  const match = /^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  const args = (match[2] ?? '').trim().split(/\s+/).filter(Boolean);
  return {command: match[1].toLowerCase(), args};
}

export function parseChatIds(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(s => /^-?\d+$/.test(s)),
  );
}

export const HELP = [
  '<b>Coup · observabilidad</b>',
  '',
  '/stats — resumen: salas, jugadores, partidas',
  '/salas — salas activas (con botones para abrirlas)',
  '/sala &lt;id&gt; — detalle: jugadores, monedas, cartas, turno, últimas jugadas',
  '/seguir &lt;id&gt; — recibir las jugadas de una sala en directo',
  '/dejar [id] — dejar de seguir una sala (o todas)',
  '/avisos on|off — avisar cuando empieza o termina una partida',
  '/ayuda — esta ayuda',
  '',
  'Por privacidad nunca se muestran las cartas ocultas, solo cuántas quedan y las reveladas.',
].join('\n');

export function formatUnknownChat(chatId: number | string) {
  return (
    'Este bot es privado.\n' +
    `El id de este chat es <code>${escapeHtml(chatId)}</code>. ` +
    'Si eres el dueño, añádelo a <code>TELEGRAM_ALLOWED_CHAT_IDS</code>.'
  );
}

export function formatStats(s: AdminStats): string {
  return [
    '<b>📊 Coup ahora mismo</b>',
    `Salas: <b>${s.rooms}</b> (en juego ${s.roomsByStatus.playing}, ` +
      `esperando ${s.roomsByStatus.lobby}, terminadas ${s.roomsByStatus.gameOver})`,
    `Jugadores conectados: <b>${s.playersOnline}</b> (en salas ${s.players})`,
    `Jugadores en partidas en curso: <b>${s.playersInGames}</b>`,
    `Conexiones abiertas: ${s.connections}`,
    `Partidas empezadas / terminadas desde el arranque: ${s.gamesStarted} / ${s.gamesFinished}`,
    `Servidor activo desde hace ${formatDuration(s.uptimeSec)}`,
  ].join('\n');
}

const leaderLine = (r: RoomSummary) => {
  if (r.status === 'gameOver')
    return r.winner ? `🏆 ${escapeHtml(r.winner)}` : 'sin ganador';
  if (!r.leader.length) return '';
  const l = r.leader[0];
  return `líder ${escapeHtml(l.name)} (${l.cards}🂠 ${l.coins}🪙)`;
};

export function formatRoomList(
  rooms: RoomSummary[],
  now = Date.now(),
): Message {
  if (!rooms.length) return {text: 'No hay salas activas ahora mismo.'};
  const shown = rooms.slice(0, 30);
  const lines = shown.map(r => {
    const parts = [
      `<b>${escapeHtml(r.id)}</b> · ${STATUS_ES[r.status]}`,
      `${r.players} jug.` +
        (r.status === 'playing' ? `, ${r.alive} vivos` : '') +
        `, ${r.connected} online`,
    ];
    if (r.status === 'playing' && r.turn)
      parts.push(`turno de ${escapeHtml(r.turn)}`);
    const leader = leaderLine(r);
    if (leader) parts.push(leader);
    parts.push(ago(r.lastActivity, now));
    return '• ' + parts.join(' · ');
  });
  if (rooms.length > shown.length)
    lines.push(`… y ${rooms.length - shown.length} más`);
  const keyboard = shown
    .map(r => button(`🔍 ${r.id}`, 'room', r.id))
    .filter(row => row.length);
  return {
    text: [`<b>🃏 Salas (${rooms.length})</b>`, ...lines].join('\n'),
    keyboard,
  };
}

const cardsText = (p: RoomDetail['players'][number]) => {
  const hidden = '🂠'.repeat(p.cards);
  const revealed = p.revealed.map(r => `<s>${escapeHtml(role(r))}</s>`);
  return [hidden, ...revealed].filter(Boolean).join(' ');
};

export function formatRoomDetail(
  d: RoomDetail,
  following: boolean,
  now = Date.now(),
): Message {
  const lines: string[] = [
    `<b>🃏 Sala ${escapeHtml(d.id)}</b> · ${STATUS_ES[d.status]}`,
  ];
  if (d.status === 'playing') {
    lines.push(
      `Fase: ${PHASE_ES[d.phase]}` +
        (d.turn ? ` · turno de <b>${escapeHtml(d.turn)}</b>` : ''),
    );
  }
  if (d.pending) {
    const p = d.pending;
    let text =
      `En juego: ${escapeHtml(p.actor)} → ${escapeHtml(action(p.action))}` +
      (p.target ? ` contra ${escapeHtml(p.target)}` : '') +
      (p.claim ? ` (dice ser ${escapeHtml(role(p.claim))})` : '');
    if (p.block) {
      text += `; bloquea ${escapeHtml(p.block.by)} con ${escapeHtml(role(p.block.role))}`;
    }
    lines.push(text);
  }
  if (d.losing) {
    lines.push(
      `${escapeHtml(d.losing.player)} debe elegir qué carta pierde ` +
        `(${REASON_ES[d.losing.reason] ?? d.losing.reason})`,
    );
  }
  if (d.waitingOn.length && d.status === 'playing') {
    lines.push(
      `Esperando a: ${d.waitingOn.map(n => escapeHtml(n)).join(', ')}`,
    );
  }
  if (d.status === 'gameOver') {
    lines.push(
      d.winner ? `🏆 Ganó <b>${escapeHtml(d.winner)}</b>` : 'Nadie ganó',
    );
  }

  lines.push('', `<b>Jugadores (${d.playerCount})</b>`);
  const order = new Map(d.leader.map((l, i) => [l.name, i]));
  d.players.forEach(p => {
    const flags = [
      p.host ? '👑' : '',
      p.online ? '' : '📴',
      d.status !== 'lobby' && !p.alive ? '💀' : '',
    ].join('');
    const rank =
      d.status === 'playing' && order.get(p.name) === 0 && p.alive ? ' ⭐' : '';
    const head = [`• ${escapeHtml(p.name)}${rank}`, flags]
      .filter(Boolean)
      .join(' ');
    lines.push(
      d.status === 'lobby'
        ? head
        : `${head} — ${p.coins}🪙 ${cardsText(p)}`.trimEnd(),
    );
  });

  if (d.log.length) {
    lines.push('', '<b>Últimas jugadas</b>');
    d.log
      .slice(-10)
      .forEach(e => lines.push(`· ${escapeHtml(translateLog(e))}`));
  }
  lines.push('', `<i>Última actividad ${ago(d.lastActivity, now)}</i>`);

  const keyboard: Keyboard = [
    [
      ...button('🔄 Actualizar', 'room', d.id),
      ...(following
        ? button('🔕 Dejar de seguir', 'unfollow', d.id)
        : button('👁 Seguir en directo', 'follow', d.id)),
    ],
    button('⬅️ Salas', 'rooms'),
  ].filter(row => row.length);
  return {text: truncate(lines.join('\n')), keyboard};
}

/** A batch of live moves of one room, as a single message. */
export function formatMoves(room: string, lines: string[]) {
  const body = lines.map(l => `· ${escapeHtml(l)}`).join('\n');
  return truncate(`<b>🎲 ${escapeHtml(room)}</b>\n${body}`);
}

/** Global notifications (/avisos). Returns null for events that are not news. */
export function formatNotice(event: AdminEvent): string | null {
  const room = `<b>${escapeHtml(event.room)}</b>`;
  switch (event.type) {
    case 'gameStarted':
      return (
        `🟢 Empieza una partida en ${room} con ${event.players.length} jugadores: ` +
        event.players.map(n => escapeHtml(n)).join(', ') +
        `\n/sala ${escapeHtml(event.room)}`
      );
    case 'gameOver':
      return event.winner
        ? `🏁 Terminó la partida en ${room}: gana <b>${escapeHtml(event.winner)}</b>`
        : `🏁 Terminó la partida en ${room} sin ganador`;
    default:
      return null;
  }
}

/** Cuts text so it fits in one Telegram message (keeps whole lines). */
export function truncate(text: string, max = MAX_MESSAGE) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max - 2);
  return text.slice(0, cut > 0 ? cut : max - 2) + '\n…';
}
