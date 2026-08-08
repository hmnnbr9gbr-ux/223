import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTradeEvent, encodeTradeEvent, tradesFromLogs, base58, TRADE_EVENT_DISC } from '../src/pumpevents.js';

const MINT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const USER = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

function sample(over = {}) {
  return encodeTradeEvent({
    mintBytes: MINT, userBytes: USER,
    solAmount: 1.975, tokenAmount: 66_275_997, isBuy: true,
    timestamp: 1_786_214_316, vSol: 31.975, vTok: 1_006_000_000,
    ...over,
  });
}

test('decodes a buy TradeEvent round-trip', () => {
  const t = decodeTradeEvent(sample());
  assert.equal(t.txType, 'buy');
  assert.ok(Math.abs(t.solAmount - 1.975) < 1e-9);
  assert.ok(Math.abs(t.tokenAmount - 66_275_997) < 1e-3);
  assert.equal(t.timestamp, 1_786_214_316);
  assert.ok(Math.abs(t.vSolInBondingCurve - 31.975) < 1e-9);
  assert.equal(t.mint, base58(MINT));
  assert.equal(t.traderPublicKey, base58(USER));
  assert.equal(t.pool, 'pump');
});

test('decodes sells and tolerates trailing bytes (newer program versions)', () => {
  const padded = Buffer.concat([sample({ isBuy: false }), Buffer.alloc(40)]);
  const t = decodeTradeEvent(padded);
  assert.equal(t.txType, 'sell');
});

test('rejects wrong discriminator and short buffers', () => {
  const bad = sample();
  bad[0] ^= 0xff;
  assert.equal(decodeTradeEvent(bad), null);
  assert.equal(decodeTradeEvent(sample().subarray(0, 40)), null);
});

test('tradesFromLogs extracts events and skips noise', () => {
  const logs = [
    'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
    `Program data: ${sample().toString('base64')}`,
    'Program data: bm90IGFuIGV2ZW50', // "not an event"
    'Program log: Instruction: Buy',
    `Program data: ${sample({ isBuy: false }).toString('base64')}`,
  ];
  const trades = tradesFromLogs(logs);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].txType, 'buy');
  assert.equal(trades[1].txType, 'sell');
});

test('base58 matches known Solana vectors', () => {
  assert.equal(base58(new Uint8Array(32)), '1'.repeat(32)); // system program: all zeros
  assert.equal(base58(Uint8Array.from([0, 0, 1])), '112');
});

test('discriminator matches the live-verified value', () => {
  assert.deepEqual([...TRADE_EVENT_DISC], [0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee]);
});
