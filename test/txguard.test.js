import test from 'node:test';
import assert from 'node:assert/strict';
import {
  guardTransaction, ALLOWED_PROGRAMS,
  SYSTEM_PROGRAM, TOKEN_PROGRAM, PUMP_PROGRAM, COMPUTE_BUDGET_PROGRAM,
} from '../src/txguard.js';

const ME = 'MyWa11etPubkey1111111111111111111111111111';
const OTHER = 'Attacker111111111111111111111111111111111111';
const SOL = 1e9;

function u32le(n) { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]; }
function u64le(n) {
  const out = [];
  let v = BigInt(Math.round(n));
  for (let i = 0; i < 8; i++) { out.push(Number(v & 0xffn)); v >>= 8n; }
  return out;
}

const sysTransfer = (from, lamports) => ({
  programId: SYSTEM_PROGRAM,
  accounts: [from, OTHER],
  data: Uint8Array.from([...u32le(2), ...u64le(lamports)]),
});
const sysCreate = (funder, lamports) => ({
  programId: SYSTEM_PROGRAM,
  accounts: [funder, OTHER],
  data: Uint8Array.from([...u32le(0), ...u64le(lamports)]),
});
const pumpBuy = (maxSolCostLamports) => ({
  programId: PUMP_PROGRAM,
  accounts: [ME],
  data: Uint8Array.from([
    0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea,
    ...u64le(123456), ...u64le(maxSolCostLamports),
  ]),
});
const computeBudget = () => ({ programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([2, 0, 0, 0, 0]) });

const msg = (instructions, over = {}) => ({ feePayer: ME, hasLookups: false, instructions, ...over });
const opts = { signer: ME, maxLamportsOut: 0.05 * SOL };

test('accepts a normal-looking buy transaction', () => {
  const v = guardTransaction(msg([
    computeBudget(),
    sysCreate(ME, 0.002 * SOL), // ATA rent
    sysTransfer(ME, 0.0002 * SOL), // portal fee
    pumpBuy(0.033 * SOL),
  ]), opts);
  assert.deepEqual(v, { ok: true });
});

test('rejects address table lookups', () => {
  const v = guardTransaction(msg([], { hasLookups: true }), opts);
  assert.equal(v.ok, false);
  assert.match(v.reason, /lookup/);
});

test('rejects a foreign fee payer', () => {
  const v = guardTransaction(msg([], { feePayer: OTHER }), opts);
  assert.equal(v.ok, false);
  assert.match(v.reason, /fee payer/);
});

test('rejects instructions for unknown programs', () => {
  const v = guardTransaction(msg([{ programId: OTHER, accounts: [], data: new Uint8Array() }]), opts);
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected program/);
});

test('rejects a full-balance drain via system transfer', () => {
  const v = guardTransaction(msg([sysTransfer(ME, 5 * SOL)]), opts);
  assert.equal(v.ok, false);
  assert.match(v.reason, /cap/);
});

test('ignores transfers funded by someone else', () => {
  const v = guardTransaction(msg([sysTransfer(OTHER, 5 * SOL)]), opts);
  assert.deepEqual(v, { ok: true });
});

test('sums multiple small outflows against the cap', () => {
  const many = Array.from({ length: 10 }, () => sysTransfer(ME, 0.01 * SOL));
  const v = guardTransaction(msg(many), opts);
  assert.equal(v.ok, false);
});

test('rejects exotic system instructions like Assign', () => {
  const assign = { programId: SYSTEM_PROGRAM, accounts: [ME], data: Uint8Array.from([...u32le(1)]) };
  const v = guardTransaction(msg([assign]), opts);
  assert.equal(v.ok, false);
  assert.match(v.reason, /system instruction/);
});

test('rejects token Approve and SetAuthority', () => {
  for (const tag of [4, 6, 13]) {
    const ix = { programId: TOKEN_PROGRAM, accounts: [ME], data: Uint8Array.from([tag, 0, 0, 0]) };
    const v = guardTransaction(msg([ix]), opts);
    assert.equal(v.ok, false, `tag ${tag} should be rejected`);
  }
});

test('counts pump buy max_sol_cost against the cap', () => {
  const v = guardTransaction(msg([pumpBuy(10 * SOL)]), opts);
  assert.equal(v.ok, false);
  assert.match(v.reason, /cap/);
});

test('rejects malformed (truncated) system transfer data', () => {
  const ix = { programId: SYSTEM_PROGRAM, accounts: [ME], data: Uint8Array.from([...u32le(2), 1, 2]) };
  const v = guardTransaction(msg([ix]), opts);
  assert.equal(v.ok, false);
});

test('allowlist stays tight', () => {
  assert.equal(ALLOWED_PROGRAMS.size, 6);
});
