import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenTracker, Decision } from '../src/strategy.js';

const CFG = {
  watch: { windowSec: 90 },
  entry: { minAgeSec: 10, maxDevBuySol: 2.0, minUniqueBuyers: 3, minNetInflowSol: 1.0, maxTopBuyerShare: 0.5 },
  exit: { takeProfitPct: 60, stopLossPct: 25, trailingStopPct: 25, armTrailingAtPct: 40, maxHoldSec: 300, exitOnCreatorSell: true },
};

const T0 = 1_000_000;

function createMsg(over = {}) {
  return {
    mint: 'MINT1', symbol: 'TEST', name: 'Test Coin', traderPublicKey: 'DEV',
    solAmount: 0.5, vSolInBondingCurve: 30.5, vTokensInBondingCurve: 1_055_000_000,
    ...over,
  };
}

function buy(trader, sol, vSol, vTok) {
  return { txType: 'buy', mint: 'MINT1', traderPublicKey: trader, solAmount: sol,
    vSolInBondingCurve: vSol, vTokensInBondingCurve: vTok };
}

function sell(trader, sol, vSol, vTok) {
  return { txType: 'sell', mint: 'MINT1', traderPublicKey: trader, solAmount: sol,
    vSolInBondingCurve: vSol, vTokensInBondingCurve: vTok };
}

test('no entry before minAgeSec even with demand', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  let d;
  d = t.onTrade(buy('A', 0.5, 31, 1_040_000_000), T0 + 2000);
  d = t.onTrade(buy('B', 0.5, 31.5, 1_030_000_000), T0 + 3000);
  d = t.onTrade(buy('C', 0.5, 32, 1_020_000_000), T0 + 4000);
  assert.equal(d, Decision.NONE);
});

test('enters after enough distinct buyers and net inflow', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.onTrade(buy('A', 0.5, 31, 1_040_000_000), T0 + 11_000);
  t.onTrade(buy('B', 0.5, 31.5, 1_030_000_000), T0 + 12_000);
  const d = t.onTrade(buy('C', 0.5, 32, 1_020_000_000), T0 + 13_000);
  assert.equal(d, Decision.ENTER);
});

test('rejects when one wallet dominates inflow (bundler heuristic)', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.onTrade(buy('WHALE', 5, 35, 950_000_000), T0 + 11_000);
  t.onTrade(buy('B', 0.2, 35.2, 945_000_000), T0 + 12_000);
  const d = t.onTrade(buy('C', 0.2, 35.4, 940_000_000), T0 + 13_000);
  assert.equal(d, Decision.NONE);
  assert.ok(t.topBuyerShare > 0.5);
});

test('drops token when the dev pre-sells during watch', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.onTrade(buy('A', 1.0, 31, 1_040_000_000), T0 + 11_000);
  const d = t.onTrade(sell('DEV', 0.3, 30.7, 1_050_000_000), T0 + 12_000);
  assert.equal(d, Decision.DROP);
});

test('drops oversized dev buys', () => {
  const t = new TokenTracker(createMsg({ solAmount: 5 }), CFG, T0);
  const d = t.onTrade(buy('A', 1.5, 36, 900_000_000), T0 + 11_000);
  assert.equal(d, Decision.DROP);
});

test('drop after watch window expires with no entry', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  assert.equal(t.onTick(T0 + 91_000), Decision.DROP);
});

test('take-profit exit fires', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.openPosition({ price: 30 / 1_000_000_000, tokens: 1_000_000, costSol: 0.03 }, T0 + 15_000);
  // price up ~67%: vSol 50 / vTok 1B
  const d = t.onTrade(buy('Z', 1, 50, 1_000_000_000), T0 + 20_000);
  assert.equal(d, Decision.EXIT);
  assert.equal(t.exitReason, 'take-profit');
});

test('stop-loss exit fires', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.openPosition({ price: 30 / 1_000_000_000, tokens: 1_000_000, costSol: 0.03 }, T0 + 15_000);
  const d = t.onTrade(sell('Z', 1, 21, 1_000_000_000), T0 + 20_000);
  assert.equal(d, Decision.EXIT);
  assert.equal(t.exitReason, 'stop-loss');
});

test('creator sell forces exit while holding', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.openPosition({ price: 30 / 1_000_000_000, tokens: 1_000_000, costSol: 0.03 }, T0 + 15_000);
  const d = t.onTrade(sell('DEV', 0.5, 29, 1_010_000_000), T0 + 16_000);
  assert.equal(d, Decision.EXIT);
  assert.equal(t.exitReason, 'creator-sold');
});

test('timeout exit via tick when token goes silent', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.openPosition({ price: 30 / 1_000_000_000, tokens: 1_000_000, costSol: 0.03 }, T0 + 15_000);
  const d = t.onTick(T0 + 15_000 + 301_000);
  assert.equal(d, Decision.EXIT);
  assert.equal(t.exitReason, 'timeout');
});

test('trailing stop arms after gain and fires on drawdown', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.openPosition({ price: 30 / 1_000_000_000, tokens: 1_000_000, costSol: 0.03 }, T0 + 15_000);
  // +50% peak: arms trailing (>=40)
  let d = t.onTrade(buy('Z', 1, 45, 1_000_000_000), T0 + 16_000);
  assert.equal(d, Decision.NONE);
  // fall 26.7% from peak (45 -> 33): trailing fires before stop-loss (33 is +10% vs entry)
  d = t.onTrade(sell('Z', 1, 33, 1_000_000_000), T0 + 17_000);
  assert.equal(d, Decision.EXIT);
  assert.equal(t.exitReason, 'trailing-stop');
});
