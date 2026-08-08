import fs from 'node:fs';
import path from 'node:path';

// Scores every wallet observed in the trade feed so the bot can build its own
// private leaderboard of provably profitable traders — instead of copying
// influencer wallets that are crowded, front-run, or outright bait.
//
// Accounting is average-cost per (wallet, mint): a sell realizes
// proceeds - cost * fractionSold. Only what the feed shows us counts, so a
// wallet's score here is "PnL over the window we watched", not lifetime truth.

export class WalletBook {
  constructor(file = 'data/walletbook.json') {
    this.file = file;
    this.wallets = new Map(); // addr -> { pnlSol, closed, wins, buys, lastSeen }
    this.positions = new Map(); // `${addr}:${mint}` -> { costSol, tokens }
    this.dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [addr, w] of Object.entries(raw.wallets ?? {})) this.wallets.set(addr, w);
      for (const [key, p] of Object.entries(raw.positions ?? {})) this.positions.set(key, p);
    } catch { /* first run */ }
  }

  save() {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      wallets: Object.fromEntries(this.wallets),
      positions: Object.fromEntries(this.positions),
    }));
    this.dirty = false;
  }

  wallet(addr) {
    let w = this.wallets.get(addr);
    if (!w) { w = { pnlSol: 0, closed: 0, wins: 0, buys: 0, lastSeen: 0 }; this.wallets.set(addr, w); }
    return w;
  }

  onTrade(msg) {
    const addr = msg.traderPublicKey;
    const sol = Number(msg.solAmount ?? 0);
    const tokens = Number(msg.tokenAmount ?? 0);
    if (!addr || !(sol > 0) || !(tokens > 0)) return;

    const w = this.wallet(addr);
    w.lastSeen = Date.now();
    const key = `${addr}:${msg.mint}`;
    this.dirty = true;

    if (msg.txType === 'buy') {
      w.buys++;
      const p = this.positions.get(key) ?? { costSol: 0, tokens: 0 };
      p.costSol += sol;
      p.tokens += tokens;
      this.positions.set(key, p);
    } else if (msg.txType === 'sell') {
      const p = this.positions.get(key);
      if (!p || !(p.tokens > 0)) return; // bought before we started watching — unscoreable
      const fraction = Math.min(tokens / p.tokens, 1);
      const costOut = p.costSol * fraction;
      const pnl = sol - costOut;
      p.tokens -= Math.min(tokens, p.tokens);
      p.costSol -= costOut;
      if (p.tokens <= 1e-9) this.positions.delete(key); else this.positions.set(key, p);
      w.pnlSol += pnl;
      w.closed++;
      if (pnl > 0) w.wins++;
    }
  }

  /** Top wallets by observed realized PnL, gated on sample size and profit. */
  top(n, { minClosed = 10, minPnlSol = 1 } = {}) {
    return [...this.wallets.entries()]
      .filter(([, w]) => w.closed >= minClosed && w.pnlSol >= minPnlSol)
      .sort((a, b) => b[1].pnlSol - a[1].pnlSol)
      .slice(0, n)
      .map(([addr, w]) => ({ addr, ...w, winRate: w.closed ? w.wins / w.closed : 0 }));
  }

  size() { return this.wallets.size; }
}
