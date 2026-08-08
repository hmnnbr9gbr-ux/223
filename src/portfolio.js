// Bankroll accounting and risk limits. All figures in SOL.

export class Portfolio {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    this.openPositions = new Map(); // mint -> { costSol, tokens, symbol }
    this.realizedPnlSol = 0;
    this.spentTodaySol = 0;
    this.wins = 0;
    this.losses = 0;
    this.dayKey = this.today();
  }

  today() { return new Date().toISOString().slice(0, 10); }

  rollDayIfNeeded() {
    const key = this.today();
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.spentTodaySol = 0;
    }
  }

  /** Risk gate consulted before every entry. Returns a reject reason or null. */
  rejectEntry(buyAmountSol) {
    this.rollDayIfNeeded();
    const r = this.cfg.risk;
    if (this.openPositions.size >= this.cfg.maxConcurrentPositions) return 'max concurrent positions';
    if (this.realizedPnlSol <= -r.dailyLossLimitSol) return 'daily loss limit hit';
    if (this.spentTodaySol + buyAmountSol > r.maxSpendPerDaySol) return 'daily spend cap hit';
    return null;
  }

  onBuy(mint, symbol, fill) {
    this.openPositions.set(mint, { costSol: fill.costSol, tokens: fill.tokens, symbol });
    this.spentTodaySol += fill.costSol;
  }

  onSell(mint, proceedsSol) {
    const pos = this.openPositions.get(mint);
    if (!pos) return 0;
    this.openPositions.delete(mint);
    const pnl = proceedsSol - pos.costSol;
    this.realizedPnlSol += pnl;
    if (pnl >= 0) this.wins++; else this.losses++;
    return pnl;
  }

  summary() {
    const open = [...this.openPositions.values()]
      .map((p) => `${p.symbol}(${p.costSol.toFixed(4)})`).join(', ') || 'none';
    return (
      `realized P&L ${this.realizedPnlSol >= 0 ? '+' : ''}${this.realizedPnlSol.toFixed(4)} SOL | ` +
      `${this.wins}W/${this.losses}L | spent today ${this.spentTodaySol.toFixed(4)} | open: ${open}`
    );
  }
}
