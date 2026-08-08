import { price } from './curve.js';

// Per-token state machine: WATCHING -> (entry signal) -> HOLDING -> (exit signal) -> DONE.
// Entry style is "confirmation momentum": we deliberately do NOT buy at creation
// (block-0 is a sniper-bot race retail cannot win); we buy only after real,
// distributed demand shows up — and we bail out fast.

export const Decision = Object.freeze({
  NONE: 'none',
  ENTER: 'enter',
  EXIT: 'exit',
  DROP: 'drop', // stop watching, never entered
});

export class TokenTracker {
  constructor(createMsg, cfg, now = Date.now()) {
    this.cfg = cfg;
    this.mint = createMsg.mint;
    this.symbol = createMsg.symbol ?? '?';
    this.name = createMsg.name ?? '';
    this.creator = createMsg.traderPublicKey ?? null;
    this.createdAt = now;
    this.devBuySol = Number(createMsg.solAmount ?? 0);
    this.vSol = Number(createMsg.vSolInBondingCurve ?? 0);
    this.vTok = Number(createMsg.vTokensInBondingCurve ?? 0);

    this.grossInflowSol = 0;
    this.netInflowSol = 0;
    this.buyersGross = new Map(); // trader -> gross SOL bought
    this.creatorSold = false;

    this.state = 'WATCHING';
    this.position = null; // set by the engine on fill
    this.metaHot = false; // set by the engine when the token rides a hot narrative wave
    this.source = 'scan'; // 'scan' | 'copy'
  }

  get ageSec() { return (Date.now() - this.createdAt) / 1000; }
  get currentPrice() { return price(this.vSol, this.vTok); }

  get topBuyerShare() {
    if (this.grossInflowSol <= 0) return 0;
    let top = 0;
    for (const v of this.buyersGross.values()) top = Math.max(top, v);
    return top / this.grossInflowSol;
  }

  get uniqueBuyers() { return this.buyersGross.size; }

  /** Feed a trade event; returns a Decision for the engine to act on. */
  onTrade(msg, now = Date.now()) {
    const sol = Number(msg.solAmount ?? 0);
    const trader = msg.traderPublicKey ?? 'unknown';
    if (Number(msg.vSolInBondingCurve) > 0) this.vSol = Number(msg.vSolInBondingCurve);
    if (Number(msg.vTokensInBondingCurve) > 0) this.vTok = Number(msg.vTokensInBondingCurve);

    if (msg.txType === 'buy') {
      this.grossInflowSol += sol;
      this.netInflowSol += sol;
      this.buyersGross.set(trader, (this.buyersGross.get(trader) ?? 0) + sol);
    } else if (msg.txType === 'sell') {
      this.netInflowSol -= sol;
      if (trader === this.creator && sol > 0) this.creatorSold = true;
    }

    if (this.state === 'WATCHING') return this.evaluateEntry(now);
    if (this.state === 'HOLDING') return this.evaluateExit(now);
    return Decision.NONE;
  }

  evaluateEntry(now = Date.now()) {
    const e = this.cfg.entry;
    const age = (now - this.createdAt) / 1000;

    if (age > this.cfg.watch.windowSec) return Decision.DROP;
    if (this.creatorSold) return Decision.DROP; // dev already dumping pre-entry
    if (age < e.minAgeSec) return Decision.NONE;
    if (this.devBuySol > e.maxDevBuySol) return Decision.DROP;

    // A token riding an established narrative wave gets relaxed demand
    // thresholds — the crowd is already proven, we just need this token to
    // catch it. Safety filters (dev buy, dev sell, whale share) never relax.
    const m = this.cfg.meta ?? {};
    const minBuyers = this.metaHot
      ? Math.max(2, e.minUniqueBuyers - (m.buyerRelief ?? 0))
      : e.minUniqueBuyers;
    const minInflow = this.metaHot
      ? e.minNetInflowSol * (m.inflowRelief ?? 1)
      : e.minNetInflowSol;

    if (this.uniqueBuyers < minBuyers) return Decision.NONE;
    if (this.netInflowSol < minInflow) return Decision.NONE;
    if (this.topBuyerShare > e.maxTopBuyerShare) return Decision.NONE;
    return Decision.ENTER;
  }

  /** Called by the engine after a successful (real or simulated) buy. */
  openPosition(fill, now = Date.now()) {
    this.state = 'HOLDING';
    this.position = {
      entryPrice: fill.price,
      tokens: fill.tokens,
      costSol: fill.costSol,
      openedAt: now,
      peakPrice: fill.price,
    };
  }

  evaluateExit(now = Date.now()) {
    const x = this.cfg.exit;
    const p = this.position;
    if (!p) return Decision.NONE;

    const cur = this.currentPrice;
    if (cur > p.peakPrice) p.peakPrice = cur;
    const pnlPct = ((cur - p.entryPrice) / p.entryPrice) * 100;
    const heldSec = (now - p.openedAt) / 1000;

    if (x.exitOnCreatorSell && this.creatorSold) return this.exit('creator-sold');
    if (pnlPct <= -x.stopLossPct) return this.exit('stop-loss');
    if (pnlPct >= x.takeProfitPct) return this.exit('take-profit');
    const peakGainPct = ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100;
    if (peakGainPct >= x.armTrailingAtPct) {
      const drawdownPct = ((p.peakPrice - cur) / p.peakPrice) * 100;
      if (drawdownPct >= x.trailingStopPct) return this.exit('trailing-stop');
    }
    if (heldSec >= x.maxHoldSec) return this.exit('timeout');
    return Decision.NONE;
  }

  exit(reason) {
    this.exitReason = reason;
    return Decision.EXIT;
  }

  /** Timer-driven check so positions exit even when a dead token stops trading. */
  onTick(now = Date.now()) {
    if (this.state === 'HOLDING') return this.evaluateExit(now);
    if (this.state === 'WATCHING' && (now - this.createdAt) / 1000 > this.cfg.watch.windowSec) {
      return Decision.DROP;
    }
    return Decision.NONE;
  }
}
