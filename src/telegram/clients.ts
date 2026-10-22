/** Thin HTTP clients for the Telegram Bot API and the backend admin API. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export type TelegramCaller = {
  call<T = unknown>(
    method: string,
    params?: object,
    signal?: AbortSignal,
  ): Promise<T>;
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {retry_after?: number};
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function telegramApi(token: string, retries = 3): TelegramCaller {
  const base = `https://api.telegram.org/bot${token}`;
  return {
    async call<T>(
      method: string,
      params: object = {},
      signal?: AbortSignal,
    ): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${base}/${method}`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(params),
          signal,
        });
        const body = (await res.json()) as TelegramResponse<T>;
        if (body.ok) return body.result as T;
        const retryAfter = body.parameters?.retry_after;
        // Rate limited: wait as told and try again.
        if (body.error_code === 429 && retryAfter && attempt < retries) {
          await sleep(retryAfter * 1000);
          continue;
        }
        throw new HttpError(
          body.error_code ?? res.status,
          `${method}: ${body.description ?? res.statusText}`,
          retryAfter,
        );
      }
    },
  };
}

export type BackendClient = {
  get<T>(path: string): Promise<T>;
  eventsUrl: string;
  headers: Record<string, string>;
};

export function backendClient(baseUrl: string, token: string): BackendClient {
  const base = baseUrl.replace(/\/+$/, '');
  const headers = {Authorization: `Bearer ${token}`};
  return {
    eventsUrl: `${base}/admin/events`,
    headers,
    async get<T>(path: string) {
      const res = await fetch(base + path, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok)
        throw new HttpError(res.status, `GET ${path}: ${res.status}`);
      return (await res.json()) as T;
    },
  };
}
