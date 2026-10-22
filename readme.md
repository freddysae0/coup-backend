# Coup Backend

Authoritative WebSocket server for the [Coup](https://github.com/freddysae0/coup) card game.

The server owns the whole game: it shuffles and deals, validates every move,
resolves challenges and blocks, and sends each player **their own view** of the
table (their cards, everybody's revealed cards, and only counts for the rest).
Clients just send intents like "I challenge" or "I play Tax".

## Run it

```bash
npm install
npm run dev          # builds and starts on http://localhost:8000 (WS on the same port)
npm test             # rules tests, fuzzing of 3000 random games, WebSocket simulations
npm run simulate -- ws://localhost:8000 4   # watch 4 bots play a full game
```

Environment variables:

| Variable              | Default  | Meaning                                                      |
| --------------------- | -------- | ------------------------------------------------------------ |
| `PORT`                | `8000`   | HTTP + WebSocket port (any path works, e.g. `/` or `/ws`)    |
| `RESPONSE_TIMEOUT_MS` | `30000`  | Time to challenge/block before everyone left auto-passes (`0` = never) |
| `DISCONNECT_GRACE_MS` | `120000` | A player offline this long during a game forfeits (`0` = never) |
| `ADMIN_TOKEN`         | (unset)  | Enables the read-only `/admin` API (bearer token). Unset = `/admin` is 404 |

## Observability and Telegram bot

With `ADMIN_TOKEN` set, the backend exposes a read-only API (header
`Authorization: Bearer <ADMIN_TOKEN>`):

| Route                        | What                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `GET /admin/stats`           | Rooms (by lobby/playing/gameOver), players online, players in games, games started/finished since boot, uptime |
| `GET /admin/rooms`           | Live rooms: phase, players, alive, turn, leader (most cards, then coins), winner, activity |
| `GET /admin/rooms/:id`       | Players (coins, cards left, revealed cards, online, host), turn, pending action, recent log |
| `GET /admin/events`          | Server-Sent Events: `log`, `phase`, `gameStarted`, `gameOver`, `roomCreated`, `roomDeleted` (`?room=<id>` filters) |
| `GET /admin/rooms/:id/events`| Same stream, for one room                                            |

It is a **spectator** view: face-down cards and player ids (which work as
seat credentials) are never exposed, so you can play yourself without cheating.

The Telegram bot (`src/telegram/`, entry `dist/telegram/index.js`) is a
separate process built from the same image. Spanish commands: `/salas`,
`/sala <id>`, `/seguir <id>` (live moves, batched every few seconds),
`/dejar [id]`, `/stats`, `/avisos on|off` (game started/finished notices),
`/ayuda`.

Setup:

1. In Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot`
   and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Generate an admin token, e.g.
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Start the bot and send it `/start`: since your chat is not allowed yet it
   answers with your chat id. Put it in `TELEGRAM_ALLOWED_CHAT_IDS`
   (comma-separated; group ids are negative) and restart the bot.

Run both locally without Docker:

```bash
ADMIN_TOKEN=secret npm run dev                      # terminal 1
ADMIN_TOKEN=secret TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_CHAT_IDS=123   BACKEND_URL=http://localhost:8000 node dist/telegram/index.js   # terminal 2
```

Or with Docker, each service in its own container:

```bash
cp .env.example .env   # fill it in
docker compose up -d --build
```

To also start the bot, set `COMPOSE_PROFILES=telegram` in `.env`.

## Deploy on Ploi

Production runs on a [Ploi](https://ploi.io) server with Docker: Nginx (managed
by Ploi) terminates TLS and proxies to the backend container, which only
listens on `127.0.0.1:8000`.

One-time setup:

1. On the server, let the Ploi user run Docker: `sudo usermod -aG docker ploi`
   (log out and back in, or restart the Ploi daemon).
2. Create a site for the backend domain (e.g. `api.example.com`), install this
   repository on the `master` branch and request a Let's Encrypt certificate.
   Leave **Quick deploy off**: GitHub Actions triggers the deploy only after
   lint and tests pass.
3. In the site directory create `.env` from `.env.example` (Ploi's
   *Environment* tab, or over SSH). Add `COMPOSE_PROFILES=telegram` to run the
   Telegram bot too.
4. Deploy script:

   ```bash
   cd {SITE_DIRECTORY}
   git pull origin {BRANCH}
   docker compose up -d --build --remove-orphans
   docker image prune -f
   ```

5. Nginx: replace the site's `location / { ... }` block with a WebSocket and
   SSE friendly proxy:

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:8000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 1h;
       proxy_buffering off;
   }
   ```

6. Copy the deploy webhook URL from the site's *Repository* tab into the GitHub
   secret `PLOI_DEPLOY_WEBHOOK`. Every push to `master` then runs lint and
   tests and, if green, asks Ploi to deploy.

## Structure

```
src/
 ├── game/
 │    ├── types.ts    # Roles, actions (cost, claimed role, who blocks), phases
 │    ├── engine.ts   # CoupGame: the state machine with all the rules
 │    └── view.ts     # Per-player view + the options each player has right now
 ├── server.ts        # Rooms, sockets, reconnection, timers, heartbeat
 ├── admin.ts         # Read-only /admin API + live event stream (SSE)
 ├── telegram/        # Telegram bot (separate process): commands, formatting, SSE client
 ├── bot.ts           # A client that plays using only its own view
 ├── simulate.ts      # CLI: bots play a full game against any server
 ├── index.ts         # Entry point
 └── test/            # node:test suites
```

## Game flow (phases)

```
lobby ──start──▶ action ──(Income / Coup / Foreign aid)──────────────┐
                   │                                                  │
                   └─(Tax/Assassinate/Steal/Exchange)─▶ challengeAction
                                                        │ all pass    │ challenge
                                                        ▼             ▼
                            blockAction ◀── action stands ◀── loseInfluence
                     (target, or anyone for Foreign aid)
                       │ all pass          │ block
                       ▼                   ▼
                    resolve         challengeBlock ── all pass ──▶ blocked
                       │                   │ challenge
                       ▼                   ▼
         Coup/Assassinate → loseInfluence  loseInfluence → resolve or blocked
         Exchange → exchange
                       ▼
                  next turn … until one player is left → gameOver ──restart──▶ lobby
```

Rules covered: 2-player variant (first player starts with 1 coin), forced Coup
at 10+ coins, coin costs paid on declaration (Assassin refunded if caught
bluffing), revealed cards replaced from the deck after a won challenge, double
loss (failed challenge + assassination), losing the last card automatically,
exchange keeps as many cards as alive influence, eliminated players skipped,
players leaving at any moment, disconnections and reconnections.

## Protocol

Client → server (JSON):

```ts
{type: 'join', room, playerId, name?}   // also used to reconnect to your seat
{type: 'rename', name}
{type: 'start'}                         // host only
{type: 'action', action, targetId?}     // 'Income' | 'Foreign aid' | 'Coup' | 'Tax' | 'Assassinate' | 'Steal' | 'Exchange'
{type: 'challenge', windowId?}
{type: 'block', role, windowId?}
{type: 'pass', windowId?}
{type: 'loseCard', index}
{type: 'exchange', keep: number[]}      // indexes into options.exchange.cards
{type: 'leave'}
{type: 'restart'}                       // host only, after gameOver
```

Server → client:

```ts
{type: 'state', state: GameView, serverTime, responseTimeoutMs}
{type: 'error', message}
{type: 'left'}
```

`GameView.options` tells the client exactly what it may do right now, so the UI
never has to re-implement the rules. Responses that include `windowId` and
arrive after that window closed (somebody else was faster) are ignored.
