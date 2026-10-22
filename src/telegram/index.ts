/**
 * Telegram bot entry point (runs as its own process/container):
 *   node dist/telegram/index.js
 */
import fs from 'fs';
import path from 'path';
import type {AdminEvent} from '../admin';
import {createBot, BotState, Update} from './bot';
import {backendClient, telegramApi} from './clients';
import {parseChatIds} from './format';
import {followStream} from './sse';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

const log = (...args: unknown[]) =>
  console.log(new Date().toISOString(), ...args);

const allowedChats = parseChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
const telegram = telegramApi(env('TELEGRAM_BOT_TOKEN'));
const backend = backendClient(
  process.env.BACKEND_URL || 'http://localhost:8000',
  env('ADMIN_TOKEN'),
);
const flushMs = Number(process.env.TELEGRAM_FLUSH_MS || 3000);
const stateFile = process.env.TELEGRAM_STATE_FILE;

const loadState = (): BotState | undefined => {
  if (!stateFile) return undefined;
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as BotState;
  } catch {
    return undefined;
  }
};

const saveState = (state: BotState) => {
  if (!stateFile) return;
  try {
    fs.mkdirSync(path.dirname(stateFile), {recursive: true});
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch (err) {
    log('could not save state', err);
  }
};

const bot = createBot({
  telegram,
  backend,
  allowedChats,
  initialState: loadState(),
  saveState,
  log,
});

const stop = new AbortController();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function poll() {
  let offset = 0;
  let delay = 1000;
  while (!stop.signal.aborted) {
    try {
      const updates = await telegram.call<Update[]>(
        'getUpdates',
        {offset, timeout: 50, allowed_updates: ['message', 'callback_query']},
        stop.signal,
      );
      delay = 1000;
      for (const update of updates) {
        offset = update.update_id + 1;
        await bot
          .handleUpdate(update)
          .catch(err => log('update failed', update.update_id, err));
      }
    } catch (err) {
      if (stop.signal.aborted) break;
      log('getUpdates failed, retrying', err);
      await sleep(delay);
      delay = Math.min(30_000, delay * 2);
    }
  }
}

async function main() {
  if (!allowedChats.size) {
    log(
      'TELEGRAM_ALLOWED_CHAT_IDS is empty: the bot only answers with the chat id.',
    );
  }
  const me = await telegram.call<{username: string}>('getMe');
  log(`Telegram bot @${me.username} started, backend ${backend.eventsUrl}`);
  await telegram
    .call('setMyCommands', {
      commands: [
        {command: 'salas', description: 'Salas activas'},
        {command: 'sala', description: 'Detalle de una sala'},
        {command: 'seguir', description: 'Seguir una sala en directo'},
        {command: 'dejar', description: 'Dejar de seguir'},
        {command: 'stats', description: 'Resumen general'},
        {command: 'avisos', description: 'Avisos de inicio/fin (on/off)'},
        {command: 'ayuda', description: 'Ayuda'},
      ],
    })
    .catch(err => log('setMyCommands failed', err));

  const flusher = setInterval(() => void bot.flush(), flushMs);
  void followStream({
    url: backend.eventsUrl,
    headers: backend.headers,
    signal: stop.signal,
    onStatus: (status, detail) =>
      log(`backend event stream ${status}`, detail ?? ''),
    onMessage: msg => {
      try {
        void bot
          .handleEvent(JSON.parse(msg.data) as AdminEvent)
          .catch(err => log('event failed', err));
      } catch (err) {
        log('bad event', err);
      }
    },
  });
  await poll();
  clearInterval(flusher);
  await bot.flush();
}

// Aborting ends the long poll and the event stream; main() then flushes.
const shutdown = () => stop.abort();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
  stop.abort();
});
