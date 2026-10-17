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

## Structure

```
src/
 ├── game/
 │    ├── types.ts    # Roles, actions (cost, claimed role, who blocks), phases
 │    ├── engine.ts   # CoupGame: the state machine with all the rules
 │    └── view.ts     # Per-player view + the options each player has right now
 ├── server.ts        # Rooms, sockets, reconnection, timers, heartbeat
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
