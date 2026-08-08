import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const FEED_URL = 'wss://pumpportal.fun/api/data';

/**
 * PumpPortal market-data feed.
 * Emits: 'open', 'close', 'newToken' (creation event), 'trade' (per-token trade).
 * Manages per-mint trade subscriptions with automatic re-subscribe on reconnect.
 */
export class Feed extends EventEmitter {
  constructor(logger, { apiKey = null, url = FEED_URL } = {}) {
    super();
    this.log = logger;
    this.url = apiKey ? `${url}?api-key=${apiKey}` : url;
    this.degradedWarned = false;
    this.ws = null;
    this.watched = new Set();
    this.watchedAccounts = new Set();
    this.backoffMs = 1000;
    this.stopped = false;
  }

  connect() {
    this.stopped = false;
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.backoffMs = 1000;
      this.log.info('feed connected');
      this.send({ method: 'subscribeNewToken' });
      if (this.watched.size > 0) {
        this.send({ method: 'subscribeTokenTrade', keys: [...this.watched] });
      }
      if (this.watchedAccounts.size > 0) {
        this.send({ method: 'subscribeAccountTrade', keys: [...this.watchedAccounts] });
      }
      this.emit('open');
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.message) {
        // PumpPortal paywalls trade streams: without a funded API key we only
        // get token creations, and the strategy can never trigger an entry.
        if (!this.degradedWarned && /api key/i.test(msg.message)) {
          this.degradedWarned = true;
          this.emit('degraded', msg.message);
        }
        return; // subscription acks
      }
      if (msg.txType === 'create' && msg.mint) {
        this.emit('newToken', msg);
      } else if ((msg.txType === 'buy' || msg.txType === 'sell') && msg.mint) {
        this.emit('trade', msg);
      }
    });

    this.ws.on('close', () => {
      this.emit('close');
      if (this.stopped) return;
      this.log.warn(`feed closed, reconnecting in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });

    this.ws.on('error', (err) => this.log.error(`feed error: ${err.message}`));
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  watchToken(mint) {
    if (this.watched.has(mint)) return;
    this.watched.add(mint);
    this.send({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  unwatchToken(mint) {
    if (!this.watched.delete(mint)) return;
    this.send({ method: 'unsubscribeTokenTrade', keys: [mint] });
  }

  /** Replace the set of copy-traded leader wallets we listen to. */
  setWatchedAccounts(addrs) {
    const next = new Set(addrs);
    const removed = [...this.watchedAccounts].filter((a) => !next.has(a));
    const added = [...next].filter((a) => !this.watchedAccounts.has(a));
    if (removed.length > 0) this.send({ method: 'unsubscribeAccountTrade', keys: removed });
    if (added.length > 0) this.send({ method: 'subscribeAccountTrade', keys: added });
    this.watchedAccounts = next;
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}
