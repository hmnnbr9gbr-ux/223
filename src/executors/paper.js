import { buyTokensOut, sellSolOut } from '../curve.js';

// Simulated execution against the live bonding-curve state, with a
// deliberately pessimistic cost model so paper results don't flatter you:
//   - pump.fun curve fee (default 1%)
//   - PumpPortal fee you'd pay in live mode (default 0.5%)
//   - flat network/priority fee per transaction
//   - slippage haircut (someone trades ahead of you)

export class PaperExecutor {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
  }

  feeMultiplier() {
    const f = this.cfg.fees;
    return 1 - (f.pumpFeePct + f.portalFeePct) / 100;
  }

  async buy(tracker, solAmount) {
    const f = this.cfg.fees;
    const solAfterFees = solAmount * this.feeMultiplier();
    const slip = 1 - f.slippagePct / 100;
    const tokens = buyTokensOut(tracker.vSol, tracker.vTok, solAfterFees) * slip;
    if (!(tokens > 0)) throw new Error('paper buy: zero tokens (bad curve state)');
    const costSol = solAmount + f.txFeeSol;
    return { tokens, costSol, price: solAfterFees / tokens, sig: 'paper' };
  }

  async sell(tracker, tokens) {
    const f = this.cfg.fees;
    const gross = sellSolOut(tracker.vSol, tracker.vTok, tokens);
    const slip = 1 - f.slippagePct / 100;
    const proceedsSol = Math.max(gross * this.feeMultiplier() * slip - f.txFeeSol, 0);
    return { proceedsSol, sig: 'paper' };
  }
}
