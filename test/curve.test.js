import test from 'node:test';
import assert from 'node:assert/strict';
import { price, buyTokensOut, sellSolOut, afterBuy, afterSell } from '../src/curve.js';

// Fresh pump.fun curve: 30 virtual SOL, 1.073B virtual tokens.
const V_SOL = 30;
const V_TOK = 1_073_000_000;

test('price is vSol/vTok', () => {
  assert.equal(price(V_SOL, V_TOK), V_SOL / V_TOK);
  assert.equal(price(0, V_TOK), 0);
  assert.equal(price(V_SOL, 0), 0);
});

test('buying moves price up, k stays constant', () => {
  const { vSol, vTok, tokensOut } = afterBuy(V_SOL, V_TOK, 1);
  assert.ok(tokensOut > 0);
  assert.ok(price(vSol, vTok) > price(V_SOL, V_TOK));
  assert.ok(Math.abs(vSol * vTok - V_SOL * V_TOK) < 1e-3 * V_SOL * V_TOK);
});

test('round trip with no fees returns the same SOL', () => {
  const solIn = 0.5;
  const buy = afterBuy(V_SOL, V_TOK, solIn);
  const solOut = sellSolOut(buy.vSol, buy.vTok, buy.tokensOut);
  assert.ok(Math.abs(solOut - solIn) < 1e-9);
});

test('a later buyer pays a higher average price', () => {
  const first = buyTokensOut(V_SOL, V_TOK, 1);
  const after = afterBuy(V_SOL, V_TOK, 5);
  const second = buyTokensOut(after.vSol, after.vTok, 1);
  assert.ok(second < first);
});

test('selling into the curve moves price down', () => {
  const bought = afterBuy(V_SOL, V_TOK, 2);
  const sold = afterSell(bought.vSol, bought.vTok, bought.tokensOut / 2);
  assert.ok(price(sold.vSol, sold.vTok) < price(bought.vSol, bought.vTok));
  assert.ok(sold.solOut > 0);
});

test('degenerate inputs return zero instead of NaN', () => {
  assert.equal(buyTokensOut(0, V_TOK, 1), 0);
  assert.equal(buyTokensOut(V_SOL, V_TOK, 0), 0);
  assert.equal(sellSolOut(V_SOL, 0, 1), 0);
  assert.equal(sellSolOut(V_SOL, V_TOK, -5), 0);
});
