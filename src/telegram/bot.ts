/**
 * Telegram bot logic: commands, inline buttons and live room feeds. All I/O
 * goes through the injected clients so it can be tested with fakes.
 */
import type {AdminEvent, AdminStats, RoomDetail, RoomSummary} from '../admin';
import {HttpError, TelegramCaller} from './clients';
import {
  escapeHtml,
  formatMoves,
  formatNotice,
  formatRoomDetail,
  formatRoomList,
  formatStats,
  formatUnknownChat,
  HELP,
  Keyboard,
  Message,
  parseCallback,
  parseCommand,
  translateLog,
  truncate,
} from './format';

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The subset of Telegram's Update object the bot uses. */
export type Update = {
  update_id: number;
  message?: {
    message_id: number;
    chat: {id: number};
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {message_id: number; chat: {id: number}};
  };
};

/** Persisted per-chat preferences. */
export type BotState = {
  follows: Record<string, string[]>;
  noticesOff: string[];
};

export type BotOptions = {
  telegram: TelegramCaller;
  backend: {get<T>(path: string): Promise<T>};
  allowedChats: Set<string>;
  initialState?: BotState;
  saveState?: (state: BotState) => void;
  log?: (...args: unknown[]) => void;
};

export function createBot(opts: BotOptions) {
  const {telegram, backend, allowedChats} = opts;
  const log = opts.log ?? (() => {});
  const follows = new Map<string, Set<string>>();
  const noticesOff = new Set<string>(opts.initialState?.noticesOff ?? []);
  Object.entries(opts.initialState?.follows ?? {}).forEach(([chat, rooms]) => {
    if (allowedChats.has(chat)) follows.set(chat, new Set(rooms));
  });
  /** chat -> room -> pending lines, flushed as one message per chat. */
  const outbox = new Map<string, Map<string, string[]>>();
  const strangerReplies = new Map<string, number>();

  const state = (): BotState => {
    const out: BotState['follows'] = {};
    follows.forEach((rooms, chat) => {
      if (rooms.size) out[chat] = [...rooms];
    });
    return {follows: out, noticesOff: [...noticesOff]};
  };
  const persist = () => opts.saveState?.(state());

  const followers = (room: string) =>
    [...follows].filter(([, rooms]) => rooms.has(room)).map(([chat]) => chat);
  const isFollowing = (chat: string, room: string) =>
    !!follows.get(chat)?.has(room);

  const send = (chat: string, msg: Message | string) => {
    const m = typeof msg === 'string' ? {text: msg} : msg;
    return telegram.call('sendMessage', {
      chat_id: chat,
      text: m.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(m.keyboard ? {reply_markup: {inline_keyboard: m.keyboard}} : {}),
    });
  };

  const edit = async (chat: string, messageId: number, m: Message) => {
    try {
      await telegram.call('editMessageText', {
        chat_id: chat,
        message_id: messageId,
        text: m.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {inline_keyboard: m.keyboard ?? ([] as Keyboard)},
      });
    } catch (err) {
      // Pressing "Actualizar" with nothing new is not an error worth showing.
      if (!(err instanceof Error && /not modified/i.test(err.message)))
        throw err;
    }
  };

  const backendError = (err: unknown) =>
    err instanceof HttpError && err.status === 404
      ? 'No existe esa sala (o ya se cerró).'
      : err instanceof HttpError && err.status === 401
        ? 'El backend rechazó el token: revisa <code>ADMIN_TOKEN</code>.'
        : `No puedo hablar con el backend: ${escapeHtml(
            err instanceof Error ? err.message : err,
          )}`;

  const roomMessage = async (chat: string, room: string) => {
    const detail = await backend.get<RoomDetail>(
      `/admin/rooms/${encodeURIComponent(room)}`,
    );
    return formatRoomDetail(detail, isFollowing(chat, room));
  };

  const roomsMessage = async (page = 0) => {
    const {rooms} = await backend.get<{rooms: RoomSummary[]}>('/admin/rooms');
    return formatRoomList(rooms, {page});
  };

  const follow = (chat: string, room: string) => {
    if (!follows.has(chat)) follows.set(chat, new Set());
    follows.get(chat)!.add(room);
    persist();
  };

  const unfollow = (chat: string, room?: string) => {
    const rooms = follows.get(chat);
    if (!rooms) return [];
    const removed = room ? (rooms.delete(room) ? [room] : []) : [...rooms];
    if (!room) rooms.clear();
    persist();
    return removed;
  };

  /** Replies to a command; returns what was sent (useful for tests). */
  const handleCommand = async (chat: string, text: string) => {
    const cmd = parseCommand(text);
    if (!cmd) return send(chat, 'Escribe /ayuda para ver los comandos.');
    const [arg] = cmd.args;
    const needRoom = (usage: string) =>
      !arg
        ? `Uso: <code>${usage}</code>`
        : !ROOM_RE.test(arg)
          ? 'Id de sala no válido.'
          : null;

    try {
      switch (cmd.command) {
        case 'start':
        case 'ayuda':
        case 'help':
          return await send(chat, HELP);
        case 'stats':
          return await send(
            chat,
            formatStats(await backend.get<AdminStats>('/admin/stats')),
          );
        case 'salas':
          return await send(chat, await roomsMessage());
        case 'sala': {
          if (!arg) return await send(chat, await roomsMessage());
          const bad = needRoom('/sala <id>');
          if (bad) return await send(chat, bad);
          return await send(chat, await roomMessage(chat, arg));
        }
        case 'seguir': {
          const bad = needRoom('/seguir <id>');
          if (bad) return await send(chat, bad);
          follow(chat, arg);
          const msg = await roomMessage(chat, arg).catch(err => {
            unfollow(chat, arg);
            throw err;
          });
          await send(
            chat,
            `👁 Siguiendo <b>${escapeHtml(arg)}</b>: te iré mandando las jugadas.`,
          );
          return await send(chat, msg);
        }
        case 'dejar': {
          if (arg && !ROOM_RE.test(arg))
            return await send(chat, 'Id de sala no válido.');
          const removed = unfollow(chat, arg);
          return await send(
            chat,
            removed.length
              ? `🔕 Dejas de seguir: ${removed.map(r => `<b>${escapeHtml(r)}</b>`).join(', ')}`
              : 'No estabas siguiendo esa sala.',
          );
        }
        case 'avisos': {
          const value = (arg ?? '').toLowerCase();
          if (value === 'on' || value === 'off') {
            if (value === 'on') noticesOff.delete(chat);
            else noticesOff.add(chat);
            persist();
          }
          const on = !noticesOff.has(chat);
          return await send(
            chat,
            `Avisos de inicio/fin de partida: <b>${on ? 'activados' : 'desactivados'}</b>.\n` +
              `Cámbialo con <code>/avisos ${on ? 'off' : 'on'}</code>.`,
          );
        }
        default:
          return await send(chat, 'Comando desconocido. Prueba /ayuda.');
      }
    } catch (err) {
      log('command failed', cmd.command, err);
      return send(chat, backendError(err));
    }
  };

  const handleCallback = async (q: NonNullable<Update['callback_query']>) => {
    const chat = q.message ? String(q.message.chat.id) : '';
    const answer = (text?: string) =>
      telegram
        .call('answerCallbackQuery', {callback_query_id: q.id, text})
        .catch(err => log('answerCallbackQuery failed', err));
    if (!chat || !allowedChats.has(chat)) return answer('No autorizado');
    const parsed = parseCallback(q.data ?? '');
    if (!parsed || (parsed.kind !== 'rooms' && !ROOM_RE.test(parsed.room)))
      return answer();
    const messageId = q.message!.message_id;
    try {
      let toast: string | undefined;
      if (parsed.kind === 'follow') {
        follow(chat, parsed.room);
        toast = 'Siguiendo la sala en directo';
      } else if (parsed.kind === 'unfollow') {
        unfollow(chat, parsed.room);
        toast = 'Ya no sigues la sala';
      }
      const msg =
        parsed.kind === 'rooms'
          ? await roomsMessage(Number(parsed.room) || 0)
          : await roomMessage(chat, parsed.room);
      await edit(chat, messageId, msg);
      await answer(toast);
    } catch (err) {
      log('callback failed', err);
      await answer('Error');
      await send(chat, backendError(err));
    }
  };

  const handleUpdate = async (update: Update) => {
    if (update.callback_query) return handleCallback(update.callback_query);
    const message = update.message;
    if (!message?.text) return;
    const chat = String(message.chat.id);
    if (!allowedChats.has(chat)) {
      // Tell strangers their chat id (so the owner can find theirs), at most
      // once an hour per chat.
      const last = strangerReplies.get(chat) ?? 0;
      if (Date.now() - last < 3600_000) return;
      strangerReplies.set(chat, Date.now());
      return send(chat, formatUnknownChat(chat));
    }
    return handleCommand(chat, message.text);
  };

  const queue = (chat: string, room: string, lines: string[]) => {
    if (!outbox.has(chat)) outbox.set(chat, new Map());
    const rooms = outbox.get(chat)!;
    rooms.set(room, [...(rooms.get(room) ?? []), ...lines]);
  };

  /** Feeds one backend event to the interested chats. */
  const handleEvent = async (event: AdminEvent) => {
    if (event.type === 'log') {
      const lines = event.entries.map(translateLog);
      followers(event.room).forEach(chat => queue(chat, event.room, lines));
    } else if (event.type === 'roomDeleted') {
      const chats = followers(event.room);
      chats.forEach(chat => unfollow(chat, event.room));
      await Promise.all(
        chats.map(chat =>
          send(
            chat,
            `🚪 La sala <b>${escapeHtml(event.room)}</b> se cerró (se quedó vacía). Dejo de seguirla.`,
          ).catch(err => log('send failed', err)),
        ),
      );
    }
    const notice = formatNotice(event);
    if (notice) {
      await Promise.all(
        [...allowedChats]
          .filter(chat => !noticesOff.has(chat))
          .map(chat =>
            send(chat, notice).catch(err => log('send failed', err)),
          ),
      );
    }
  };

  /**
   * Sends the moves queued since the last flush: at most one message per chat,
   * which keeps us far below Telegram's ~1 message/second per chat limit.
   */
  const flush = async () => {
    const pending = [...outbox];
    outbox.clear();
    await Promise.all(
      pending.map(([chat, rooms]) => {
        const text = truncate(
          [...rooms]
            .map(([room, lines]) => formatMoves(room, lines))
            .join('\n\n'),
        );
        return send(chat, text).catch(err => log('send failed', err));
      }),
    );
  };

  return {handleUpdate, handleEvent, flush, state};
}

export type CoupBot = ReturnType<typeof createBot>;
