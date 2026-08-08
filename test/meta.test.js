import test from 'node:test';
import assert from 'node:assert/strict';
import { MetaDetector } from '../src/meta.js';

const T0 = 1_000_000_000;

test('wave starters are not hot; the wave itself is', () => {
  const d = new MetaDetector({ windowMin: 30, hotCount: 4 });
  assert.equal(d.onLaunch('grok phone', 'GROKP', T0).hot, false);
  assert.equal(d.onLaunch('baby grok', 'BGROK', T0 + 60_000).hot, false);
  assert.equal(d.onLaunch('grok 5', 'GROK5', T0 + 120_000).hot, false);
  const fourth = d.onLaunch('grok wif hat', 'GWH', T0 + 180_000);
  assert.equal(fourth.hot, true);
  assert.equal(fourth.word, 'grok');
});

test('unrelated launches never go hot', () => {
  const d = new MetaDetector({ windowMin: 30, hotCount: 3 });
  assert.equal(d.onLaunch('doge killer', 'DK', T0).hot, false);
  assert.equal(d.onLaunch('cat wizard', 'CW', T0 + 1000).hot, false);
  assert.equal(d.onLaunch('moon lambo', 'ML', T0 + 2000).hot, false);
});

test('window expiry cools a wave down', () => {
  const d = new MetaDetector({ windowMin: 30, hotCount: 3 });
  d.onLaunch('pepe one', 'P1', T0);
  d.onLaunch('pepe two', 'P2', T0 + 1000);
  // 31 minutes later the earlier launches have aged out
  const late = d.onLaunch('pepe three', 'P3', T0 + 31 * 60_000);
  assert.equal(late.hot, false);
});

test('stopwords and numbers are ignored as keywords', () => {
  const words = MetaDetector.words('The Official Pump Coin 42', 'TOKEN');
  assert.equal(words.size, 0);
});
