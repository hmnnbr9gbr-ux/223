import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenTracker } from '../src/strategy.js';
import { PaperExecutor } from '../src/executors/paper.js';

// Regression: the copy-trade path acts on a leader's trade BEFORE the tracker's
// own onTrade bookkeeping runs. A tracker built from a launch message that
// carried no reserves therefore had vSol/vTok = 0, and pricing a fill against
// that state threw "zero tokens (bad curve state)" — seen live in paper mode.

const cfg = {
  watch: { windowSec: 90 },
  entry: { minAgeSec: 10, maxDevBuySol: 2, minUniqueBuyers: 8, minNetInflowSol: 1.5, maxTopBuyerShare: 0.2 },
  exit: { takeProfitPct: 60, stopLossPct: 25, trailingStopPct: 25, armTrailingAtPct: 40, maxHoldSec: 300, exitOnCreatorSell: true },
  fees: { pumpFeePct: 1, portalFeePct: 0.5, txFeeSol: 0.0015, slippagePct: 2 },
};

const launchWithoutReserves = { mint: 'mint1', symbol: 'AAA', traderPublicKey: 'devwallet' };
const leaderBuy = {
  mint: 'mint1', txType: 'buy', solAmount: 1.2, tokenAmount: 40_000_000,
  traderPublicKey: 'leaderwallet', vSolInBondingCurve: 31.2, vTokensInBondingCurve: 1_030_000_000, pool: 'pump',
};

test('a launch message without reserves leaves the tracker unpriceable', () => {
  const t = new TokenTracker(launchWithoutReserves, cfg);
  assert.equal(t.vSol, 0);
  assert.equal(t.currentPrice, 0);
});

test('syncCurve adopts reserves from a trade and reports usability', () => {
  const t = new TokenTracker(launchWithoutReserves, cfg);
  assert.equal(t.syncCurve(leaderBuy), true);
  assert.equal(t.vSol, 31.2);
  assert.equal(t.vTok, 1_030_000_000);
  assert.ok(t.currentPrice > 0);
});

test('syncCurve reports false when a message carries no usable reserves', () => {
  const t = new TokenTracker(launchWithoutReserves, cfg);
  assert.equal(t.syncCurve({ mint: 'mint1', txType: 'buy', solAmount: 1 }), false);
});

test('syncCurve never downgrades known reserves to zero', () => {
  const t = new TokenTracker({ ...launchWithoutReserves, vSolInBondingCurve: 30, vTokensInBondingCurve: 1e9 }, cfg);
  t.syncCurve({ vSolInBondingCurve: 0, vTokensInBondingCurve: 0 });
  assert.equal(t.vSol, 30);
  assert.equal(t.vTok, 1e9);
});

test('a copy fill priced after syncCurve succeeds where the stale one threw', async () => {
  const executor = new PaperExecutor(cfg, { info() {}, warn() {}, error() {} });
  const stale = new TokenTracker(launchWithoutReserves, cfg);
  await assert.rejects(() => executor.buy(stale, 0.03), /bad curve state/);

  const synced = new TokenTracker(launchWithoutReserves, cfg);
  synced.syncCurve(leaderBuy);
  const fill = await executor.buy(synced, 0.03);
  assert.ok(fill.tokens > 0);
  assert.ok(fill.price > 0);
});

test('onTrade still syncs reserves through the normal path', () => {
  const t = new TokenTracker(launchWithoutReserves, cfg);
  t.onTrade(leaderBuy);
  assert.equal(t.vSol, 31.2);
  assert.equal(t.uniqueBuyers, 1);
});
