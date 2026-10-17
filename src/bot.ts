import WebSocket from 'ws';
import type {GameView} from './game/view';

export type BotOptions = {
  url: string;
  room: string;
  playerId: string;
  name: string;
  rnd?: () => number;
  /** Delay before acting, to look a bit more like a human. */
  thinkMs?: number;
  onLog?: (text: string) => void;
};

/**
 * Plays Coup over the real WebSocket protocol using only the information a
 * browser client would have (its own GameView). Used by the simulation test
 * and by `npm run simulate`.
 */
export class Bot {
  ws!: WebSocket;
  state: GameView | null = null;
  errors: string[] = [];
  private actedVersion = -1;
  private seenLog = 0;
  private rnd: () => number;

  constructor(readonly opts: BotOptions) {
    this.rnd = opts.rnd ?? Math.random;
  }

  connect() {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.opts.url);
      this.ws.on('open', () => {
        this.send({
          type: 'join',
          room: this.opts.room,
          playerId: this.opts.playerId,
          name: this.opts.name,
        });
        resolve();
      });
      this.ws.on('error', reject);
      this.ws.on('message', raw => this.onMessage(JSON.parse(raw.toString())));
    });
  }

  disconnect() {
    return new Promise<void>(resolve => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  send(msg: object) {
    if (this.ws.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(msg));
  }

  /** Resolves when the predicate holds for this bot's latest state. */
  waitFor(pred: (s: GameView) => boolean, timeoutMs = 20_000) {
    return new Promise<GameView>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (this.state && pred(this.state)) return resolve(this.state);
        if (Date.now() - started > timeoutMs) {
          return reject(
            new Error(
              `${this.opts.name}: timeout (phase ${this.state?.phase})`,
            ),
          );
        }
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  private onMessage(msg: {type: string; state?: GameView; message?: string}) {
    if (msg.type === 'error') {
      this.errors.push(msg.message || '');
      return;
    }
    if (msg.type !== 'state' || !msg.state) return;
    this.state = msg.state;
    if (this.opts.onLog) {
      msg.state.log
        .filter(l => l.id > this.seenLog)
        .forEach(l => this.opts.onLog!(l.text));
      this.seenLog = Math.max(this.seenLog, ...msg.state.log.map(l => l.id));
    }
    const version = msg.state.version;
    if (version === this.actedVersion) return;
    const move = this.chooseMove(msg.state);
    if (!move) return;
    this.actedVersion = version;
    const delay = this.opts.thinkMs ?? 0;
    if (delay) setTimeout(() => this.send(move), delay * (0.5 + this.rnd()));
    else this.send(move);
  }

  private chooseMove(s: GameView): object | null {
    const o = s.options;
    const pick = <T>(arr: T[]) => arr[Math.floor(this.rnd() * arr.length)];
    const me = s.players.find(p => p.id === s.you);
    if (!me) return null;

    if (o.actions.length) {
      const enabled = o.actions.filter(a => a.enabled);
      // Prefer impactful moves a little, but stay random.
      const strong = enabled.filter(
        a => a.type === 'Coup' || a.type === 'Assassinate',
      );
      const action =
        strong.length && this.rnd() < 0.6 ? pick(strong) : pick(enabled);
      return {
        type: 'action',
        action: action.type,
        targetId: pick(action.targets),
      };
    }
    if (o.loseInfluence) {
      const idx = me.cards
        .map((c, i) => (c.revealed ? -1 : i))
        .filter(i => i >= 0);
      return {type: 'loseCard', index: pick(idx)};
    }
    if (o.exchange) {
      const order = o.exchange.cards
        .map((_, i) => i)
        .sort(() => this.rnd() - 0.5);
      return {type: 'exchange', keep: order.slice(0, o.exchange.keep)};
    }
    if (o.canPass) {
      const r = this.rnd();
      if (o.canChallenge && r < 0.25)
        return {type: 'challenge', windowId: s.windowId};
      if (o.blockRoles.length && r < 0.5) {
        // Block truthfully when possible, otherwise sometimes bluff.
        const mine = o.blockRoles.filter(role =>
          me.cards.some(c => !c.revealed && c.role === role),
        );
        return {
          type: 'block',
          role: mine.length ? mine[0] : pick(o.blockRoles),
          windowId: s.windowId,
        };
      }
      return {type: 'pass', windowId: s.windowId};
    }
    return null;
  }
}
