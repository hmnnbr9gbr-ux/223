import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletBook } from '../src/walletbook.js';

function book() {
  const b = new WalletBook('/nonexistent/never-loaded.json');
  b.save = () => {}; // no disk in tests
  return b;
}

const buy = (addr, mint, sol, tokens) => ({ txType: 'buy', traderPublicKey: addr, mint, solAmount: sol, tokenAmount: tokens });
const sell = (addr, mint, sol, tokens) => ({ txType: 'sell', traderPublicKey: addr, mint, solAmount: sol, tokenAmount: tokens });

test('realizes profit on a winning round trip', () => {
  const b = book();
  b.onTrade(buy('W1', 'M1', 1.0, 1000));
  b.onTrade(sell('W1', 'M1', 1.5, 1000));
  const w = b.wallets.get('W1');
  assert.ok(Math.abs(w.pnlSol - 0.5) < 1e-9);
  assert.equal(w.closed, 1);
  assert.equal(w.wins, 1);
});

test('partial sells realize proportional cost', () => {
  const b = book();
  b.onTrade(buy('W1', 'M1', 2.0, 1000));
  b.onTrade(sell('W1', 'M1', 1.5, 500)); // half out: cost basis 1.0 -> +0.5
  let w = b.wallets.get('W1');
  assert.ok(Math.abs(w.pnlSol - 0.5) < 1e-9);
  b.onTrade(sell('W1', 'M1', 0.4, 500)); // rest out at a loss: cost 1.0 -> -0.6
  w = b.wallets.get('W1');
  assert.ok(Math.abs(w.pnlSol - (-0.1)) < 1e-9);
  assert.equal(w.closed, 2);
  assert.equal(w.wins, 1);
});

test('sells without an observed buy are not scored', () => {
  const b = book();
  b.onTrade(sell('W1', 'M1', 3.0, 1000));
  const w = b.wallets.get('W1');
  assert.equal(w.pnlSol, 0);
  assert.equal(w.closed, 0);
});

test('top() gates on sample size and profit', () => {
  const b = book();
  for (let i = 0; i < 12; i++) {
    b.onTrade(buy('GOOD', `M${i}`, 1, 100));
    b.onTrade(sell('GOOD', `M${i}`, 1.4, 100));
  }
  b.onTrade(buy('LUCKY', 'X', 1, 100));
  b.onTrade(sell('LUCKY', 'X', 9, 100)); // huge but only 1 closed trade
  const top = b.top(5, { minClosed: 10, minPnlSol: 3 });
  assert.equal(top.length, 1);
  assert.equal(top[0].addr, 'GOOD');
  assert.ok(top[0].winRate === 1);
});
