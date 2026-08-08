import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCurve, encodeCurve, CURVE_DISCRIMINATOR } from '../src/pumpcurve.js';

test('round-trips a fresh curve (30 SOL / 1.073B tokens)', () => {
  const buf = encodeCurve({ vTok: 1_073_000_000, vSol: 30, realTok: 793_100_000, realSol: 0, supply: 1_000_000_000 });
  const d = decodeCurve(buf);
  assert.ok(Math.abs(d.vSol - 30) < 1e-6);
  assert.ok(Math.abs(d.vTok - 1_073_000_000) < 1);
  assert.equal(d.complete, false);
});

test('decodes a post-buy curve and reflects higher SOL reserves', () => {
  const buf = encodeCurve({ vTok: 1_025_312_756, vSol: 31.3953, realSol: 1.3953 });
  const d = decodeCurve(buf);
  assert.ok(Math.abs(d.vSol - 31.3953) < 1e-4);
  assert.ok(Math.abs(d.realSol - 1.3953) < 1e-4);
  assert.ok(d.vSol > 30);
});

test('reads the complete/graduated flag', () => {
  const d = decodeCurve(encodeCurve({ vTok: 1, vSol: 85, complete: true }));
  assert.equal(d.complete, true);
});

test('rejects a buffer with the wrong discriminator', () => {
  const buf = encodeCurve({ vTok: 1, vSol: 1 });
  buf[0] = 0x00;
  assert.throws(() => decodeCurve(buf), /discriminator/);
});

test('rejects a too-short buffer', () => {
  assert.throws(() => decodeCurve(Buffer.alloc(10)), /too short/);
});

test('discriminator constant matches the known pump.fun value', () => {
  assert.deepEqual([...CURVE_DISCRIMINATOR], [0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);
});
