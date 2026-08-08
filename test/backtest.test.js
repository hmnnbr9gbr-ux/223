import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, gridSearch } from '../src/backtest.js';
import { fromTapeLine } from '../src/recorder.js';

const CFG = {
  buyAmountSol: 0.03,
  maxConcurrentPositions: 2,
  watch: { windowSec: 90, maxTrackedTokens: 60 },
  entry: { minAgeSec: 10, maxDevBuySol: 2.0, minUniqueBuyers: 3, minNetInflowSol: 1.0, maxTopBuyerShare: 0.6 },
  exit: { takeProfitPct: 60, stopLossPct: 25, trailingStopPct: 25, armTrailingAtPct: 40, maxHoldSec: 300, exitOnCreatorSell: true },
  meta: { enabled: false },
  fees: { pumpFeePct: 1.0, portalFeePct: 0.5, txFeeSol: 0.0015, slippagePct: 2 },
};

const T0 = 1_000_000_000_000;

function winnerEvents() {
  const create = { kind: 'create', at: T0, msg: {
    mint: 'WIN', name: 'Winner', symbol: 'WIN', traderPublicKey: 'DEV', solAmount: 0.5,
    vSolInBondingCurve: 30.5, vTokensInBondingCurve: 1_055_000_000,
  } };
  const buys = ['A', 'B', 'C'].map((w, i) => ({ kind: 'trade', at: T0 + 11_000 + i * 1000, msg: {
    mint: 'WIN', txType: 'buy', solAmount: 0.5, tokenAmount: 15_000_000, traderPublicKey: w,
    vSolInBondingCurve: 31 + i * 0.5, vTokensInBondingCurve: 1_040_000_000 - i * 15_000_000,
  } }));
  // big pump after entry: price roughly doubles
  const pump = { kind: 'trade', at: T0 + 20_000, msg: {
    mint: 'WIN', txType: 'buy', solAmount: 30, tokenAmount: 300_000_000, traderPublicKey: 'Z',
    vSolInBondingCurve: 62, vTokensInBondingCurve: 700_000_000,
  } };
  return [create, ...buys, pump];
}

test('replays a winning token: enters on demand, exits take-profit, positive pnl', async () => {
  const stats = await runBacktest(winnerEvents(), CFG);
  assert.equal(stats.launches, 1);
  assert.equal(stats.trades, 1);
  assert.equal(stats.wins, 1);
  assert.ok(stats.pnlSol > 0);
  assert.ok(stats.byReason['take-profit']?.n === 1);
});

test('a dead token never enters and costs nothing', async () => {
  const events = [
    { kind: 'create', at: T0, msg: { mint: 'DEAD', name: 'Dead', symbol: 'DED', traderPublicKey: 'DEV', solAmount: 0.5, vSolInBondingCurve: 30.5, vTokensInBondingCurve: 1_055_000_000 } },
    { kind: 'trade', at: T0 + 200_000, msg: { mint: 'OTHER', txType: 'buy', solAmount: 0.1, tokenAmount: 1, traderPublicKey: 'X', vSolInBondingCurve: 30, vTokensInBondingCurve: 1_000_000_000 } },
  ];
  const stats = await runBacktest(events, CFG);
  assert.equal(stats.trades, 0);
  assert.equal(stats.spentSol, 0);
});

test('grid search ranks configs by pnl and returns every combo', async () => {
  const grid = { 'entry.minUniqueBuyers': [3, 99], 'exit.takeProfitPct': [60] };
  const results = await gridSearch(winnerEvents(), CFG, grid);
  assert.equal(results.length, 2);
  assert.ok(results[0].pnlSol >= results[1].pnlSol);
  assert.equal(results[0].params['entry.minUniqueBuyers'], 3); // 99-buyer bar never enters
  assert.equal(results[1].trades, 0);
});

test('tape lines round-trip through fromTapeLine', () => {
  const c = fromTapeLine(JSON.stringify({ k: 'c', at: 5, m: 'M', n: 'Name', s: 'SYM', c: 'DEV', ds: 0.5, vs: 30, vt: 1e9, bc: 'BC' }));
  assert.equal(c.kind, 'create');
  assert.equal(c.msg.mint, 'M');
  assert.equal(c.msg.solAmount, 0.5);
  const t = fromTapeLine(JSON.stringify({ k: 't', at: 6, m: 'M', x: 'sell', sol: 1.2, tok: 500, w: 'W', vs: 29, vt: 1.01e9 }));
  assert.equal(t.kind, 'trade');
  assert.equal(t.msg.txType, 'sell');
  assert.equal(t.msg.traderPublicKey, 'W');
  assert.equal(fromTapeLine('garbage'), null);
});
