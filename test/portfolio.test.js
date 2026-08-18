import test from 'node:test';
import assert from 'node:assert/strict';
import { Portfolio } from '../src/portfolio.js';

const noopLog = { info() {}, warn() {}, error() {}, trade() {} };

const cfg = {
  maxConcurrentPositions: 2,
  risk: { dailyLossLimitSol: 0.15, maxSpendPerDaySol: 0.5 },
};

const fill = (costSol) => ({ costSol, tokens: 1000 });

function losingTrade(p, mint, costSol, proceedsSol) {
  p.onBuy(mint, 'TEST', fill(costSol));
  p.onSell(mint, proceedsSol);
}

test('blocks entries once the daily loss limit is hit', () => {
  const p = new Portfolio(cfg, noopLog);
  losingTrade(p, 'a', 0.1, 0); // -0.1
  assert.equal(p.rejectEntry(0.03), null);
  losingTrade(p, 'b', 0.1, 0); // -0.2 cumulative, past the 0.15 limit
  assert.equal(p.rejectEntry(0.03), 'daily loss limit hit');
});

test('the daily loss limit resets on a new day', () => {
  const p = new Portfolio(cfg, noopLog);
  losingTrade(p, 'a', 0.2, 0);
  assert.equal(p.rejectEntry(0.03), 'daily loss limit hit');

  p.dayKey = '1999-01-01'; // simulate the clock rolling over to a new day
  assert.equal(p.rejectEntry(0.03), null, 'a new day must clear yesterday losses');
});

test('lifetime P&L survives the day roll even though the gate resets', () => {
  const p = new Portfolio(cfg, noopLog);
  losingTrade(p, 'a', 0.2, 0);
  p.dayKey = '1999-01-01';
  p.rejectEntry(0.03); // triggers the roll
  assert.equal(p.realizedPnlSol.toFixed(4), '-0.2000');
  assert.equal(p.realizedPnlTodaySol, 0);
});

test('daily spend cap resets on a new day', () => {
  const p = new Portfolio(cfg, noopLog);
  p.onBuy('a', 'TEST', fill(0.49));
  assert.equal(p.rejectEntry(0.03), 'daily spend cap hit');
  p.dayKey = '1999-01-01';
  assert.equal(p.rejectEntry(0.03), null);
});

test('max concurrent positions gate', () => {
  const p = new Portfolio(cfg, noopLog);
  p.onBuy('a', 'A', fill(0.03));
  p.onBuy('b', 'B', fill(0.03));
  assert.equal(p.rejectEntry(0.03), 'max concurrent positions');
});

test('wins and losses are tallied per closed trade', () => {
  const p = new Portfolio(cfg, noopLog);
  losingTrade(p, 'a', 0.03, 0.05); // win
  losingTrade(p, 'b', 0.03, 0.01); // loss
  assert.equal(p.wins, 1);
  assert.equal(p.losses, 1);
});
