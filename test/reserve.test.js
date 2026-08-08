import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenTracker, Decision } from '../src/strategy.js';

const CFG = {
  watch: { windowSec: 90 },
  entry: { minAgeSec: 10, maxDevBuySol: 2.0, minUniqueBuyers: 8, minNetInflowSol: 1.5, maxTopBuyerShare: 0.4 },
  reserve: { minTicks: 4, minNetInflowSol: 1.0 },
  exit: { takeProfitPct: 60, stopLossPct: 25, trailingStopPct: 25, armTrailingAtPct: 40, maxHoldSec: 300, exitOnCreatorSell: true },
  meta: { inflowRelief: 0.6 },
};

const T0 = 1_000_000;

function createMsg(over = {}) {
  return { mint: 'M', symbol: 'R', name: 'Reserve', traderPublicKey: 'DEV', solAmount: 0.5,
    bondingCurveKey: 'BC', vSolInBondingCurve: 30.5, vTokensInBondingCurve: 1_055_000_000, ...over };
}
const res = (vSol, vTok, complete = false) => ({ vSol, vTok, complete });

test('reserve entry needs both tick count and net inflow', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  // baseline
  t.onReserve(res(30.5, 1_055_000_000), T0 + 11_000);
  // three upticks, +0.9 SOL — not enough (need 4 ticks and +1.0)
  let d;
  d = t.onReserve(res(30.8, 1_050_000_000), T0 + 12_000);
  d = t.onReserve(res(31.1, 1_045_000_000), T0 + 13_000);
  d = t.onReserve(res(31.4, 1_040_000_000), T0 + 14_000);
  assert.equal(d, Decision.NONE);
  // fourth uptick pushes inflow to +1.1 and ticks to 4
  d = t.onReserve(res(31.6, 1_037_000_000), T0 + 15_000);
  assert.equal(d, Decision.ENTER);
});

test('no reserve entry before minAgeSec', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.onReserve(res(30.5, 1_055_000_000), T0 + 1000);
  let d;
  for (let i = 1; i <= 5; i++) d = t.onReserve(res(30.5 + i, 1_055_000_000 - i * 5_000_000), T0 + 1000 + i * 500);
  assert.equal(d, Decision.NONE); // still under 10s
});

test('graduated (complete) curve is dropped', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  const d = t.onReserve(res(85, 200_000_000, true), T0 + 15_000);
  assert.equal(d, Decision.DROP);
});

test('oversized dev buy is dropped in reserve mode too', () => {
  const t = new TokenTracker(createMsg({ solAmount: 5 }), CFG, T0);
  const d = t.onReserve(res(35, 900_000_000), T0 + 15_000);
  assert.equal(d, Decision.DROP);
});

test('meta relief lowers the reserve inflow bar', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.metaHot = true; // inflow bar becomes 1.0 * 0.6 = 0.6
  t.onReserve(res(30.5, 1_055_000_000), T0 + 11_000);
  t.onReserve(res(30.6, 1_054_000_000), T0 + 12_000);
  t.onReserve(res(30.7, 1_053_000_000), T0 + 13_000);
  t.onReserve(res(30.8, 1_052_000_000), T0 + 14_000);
  const d = t.onReserve(res(31.15, 1_050_000_000), T0 + 15_000); // +0.65, 5 ticks
  assert.equal(d, Decision.ENTER);
});

test('reserve updates drive price-based exits while holding', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  t.openPosition({ price: 30 / 1_000_000_000, tokens: 1_000_000, costSol: 0.03 }, T0 + 15_000);
  const d = t.onReserve(res(50, 1_000_000_000), T0 + 20_000); // price +67%
  assert.equal(d, Decision.EXIT);
  assert.equal(t.exitReason, 'take-profit');
});

test('watch-window expiry drops an un-entered reserve token', () => {
  const t = new TokenTracker(createMsg(), CFG, T0);
  const d = t.onReserve(res(30.6, 1_054_000_000), T0 + 91_000);
  assert.equal(d, Decision.DROP);
});
