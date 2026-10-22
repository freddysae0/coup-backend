/** Minimal Server-Sent Events client on top of fetch, with reconnection. */
import {StringDecoder} from 'string_decoder';

export type SseMessage = {event: string; data: string};

/**
 * Incremental SSE parser: feed it text chunks as they arrive and it calls
 * `onMessage` for every complete event. Comments (": ping") are ignored.
 */
export function createSseParser(onMessage: (msg: SseMessage) => void) {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length)
      onMessage({event: event || 'message', data: data.join('\n')});
    event = '';
    data = [];
  };
  return (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
      if (line === '') {
        dispatch();
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
  };
}

export type StreamOptions = {
  url: string;
  headers?: Record<string, string>;
  onMessage: (msg: SseMessage) => void;
  onStatus?: (status: 'connected' | 'disconnected', detail?: unknown) => void;
  signal?: AbortSignal;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Reconnect if nothing (not even a ping) arrives for this long. */
  idleTimeoutMs?: number;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Keeps a stream open forever (until `signal` aborts), with exponential backoff. */
export async function followStream(opts: StreamOptions) {
  const min = opts.minDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  const idle = opts.idleTimeoutMs ?? 60_000;
  let delay = min;
  while (!opts.signal?.aborted) {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', abort);
    let watchdog: NodeJS.Timeout | undefined;
    const kick = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(abort, idle);
    };
    try {
      kick();
      const res = await fetch(opts.url, {
        headers: {Accept: 'text/event-stream', ...opts.headers},
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      opts.onStatus?.('connected');
      delay = min;
      const parse = createSseParser(opts.onMessage);
      const decoder = new StringDecoder('utf8');
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        kick();
        parse(decoder.write(Buffer.from(chunk)));
      }
      opts.onStatus?.('disconnected', 'stream ended');
    } catch (err) {
      if (opts.signal?.aborted) break;
      opts.onStatus?.('disconnected', err);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      opts.signal?.removeEventListener('abort', abort);
    }
    await sleep(delay, opts.signal);
    delay = Math.min(max, delay * 2);
  }
}
