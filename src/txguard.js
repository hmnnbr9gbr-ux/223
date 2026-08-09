// Guard for transactions returned by PumpPortal's trade-local API.
//
// Live mode signs a transaction built by a third-party service. TLS protects
// the transport, but if the service (or DNS, or a proxy) were ever compromised
// it could return a transaction that drains the wallet — a System transfer of
// the full balance, a token Approve/SetAuthority, an Assign of the wallet
// account, or a pump "buy" with max_sol_cost set to everything you have.
// This module inspects the decoded message BEFORE it is signed and rejects
// anything a legitimate pump.fun trade has no business containing.
//
// Dependency-free: operates on a normalized plain-object shape so the checks
// are unit-testable without @solana/web3.js installed.

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPSWAP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** Programs a pump.fun / PumpSwap trade may legitimately invoke top-level. */
export const ALLOWED_PROGRAMS = new Set([
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  TOKEN_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  PUMP_PROGRAM,
  PUMPSWAP_AMM_PROGRAM,
]);

// System program instruction indices (u32 LE at data[0..4]).
const SYS_CREATE_ACCOUNT = 0;
const SYS_TRANSFER = 2;

// SPL Token instruction tags (u8 at data[0]) that hand control of funds to a
// delegate or new authority — never part of a simple curve trade.
const TOKEN_FORBIDDEN = new Map([
  [4, 'Approve'],
  [6, 'SetAuthority'],
  [13, 'ApproveChecked'],
]);

// Anchor discriminator for pump.fun `buy` (sha256("global:buy")[0..8]).
const PUMP_BUY_DISC = [0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea];

function readU32LE(data, off) {
  if (data.length < off + 4) return null;
  return data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | ((data[off + 3] << 24) >>> 0);
}

function readU64LE(data, off) {
  if (data.length < off + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[off + i]);
  return v;
}

/**
 * Verify a normalized transaction message.
 *
 * @param msg  { feePayer, hasLookups, instructions: [{ programId, accounts, data }] }
 *             accounts are base58 strings, data a Uint8Array/Buffer.
 * @param opts { signer, maxLamportsOut } — signer is our wallet's base58 key;
 *             maxLamportsOut bounds SOL that may leave it (transfers, rent
 *             funding, and pump-buy max_sol_cost combined).
 * @returns    { ok: true } or { ok: false, reason }
 */
export function guardTransaction(msg, { signer, maxLamportsOut }) {
  if (msg.hasLookups) {
    return { ok: false, reason: 'transaction uses address table lookups (cannot verify offline)' };
  }
  if (msg.feePayer !== signer) {
    return { ok: false, reason: `fee payer ${msg.feePayer} is not our wallet` };
  }

  const cap = BigInt(Math.round(maxLamportsOut));
  let lamportsOut = 0n;

  for (const ix of msg.instructions) {
    if (!ALLOWED_PROGRAMS.has(ix.programId)) {
      return { ok: false, reason: `unexpected program ${ix.programId}` };
    }
    const data = ix.data ?? new Uint8Array(0);

    if (ix.programId === SYSTEM_PROGRAM) {
      const tag = readU32LE(data, 0);
      if (tag === SYS_TRANSFER || tag === SYS_CREATE_ACCOUNT) {
        // Both fund lamports out of accounts[0].
        if (ix.accounts[0] === signer) {
          const lamports = readU64LE(data, 4);
          if (lamports === null) return { ok: false, reason: 'malformed system instruction' };
          lamportsOut += lamports;
        }
      } else {
        // Assign, WithdrawNonce, CreateAccountWithSeed, … — nothing a plain
        // trade needs, and Assign(our wallet) would hand the account away.
        return { ok: false, reason: `unexpected system instruction tag ${tag}` };
      }
    } else if (ix.programId === TOKEN_PROGRAM) {
      const forbidden = TOKEN_FORBIDDEN.get(data[0]);
      if (forbidden) return { ok: false, reason: `token ${forbidden} instruction not allowed` };
    } else if (ix.programId === PUMP_PROGRAM) {
      if (data.length >= 24 && PUMP_BUY_DISC.every((b, i) => data[i] === b)) {
        // buy(amount, max_sol_cost): max_sol_cost is the most SOL the program
        // may pull from us — count it against the cap so a tampered
        // transaction can't buy with our whole balance.
        lamportsOut += readU64LE(data, 16);
      }
    }
  }

  if (lamportsOut > cap) {
    return { ok: false, reason: `transaction can spend ${lamportsOut} lamports; cap is ${cap}` };
  }
  return { ok: true };
}

/**
 * Normalize a @solana/web3.js VersionedTransaction (legacy or v0 message)
 * into the shape guardTransaction checks.
 */
export function normalizeWeb3Message(message) {
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  return {
    feePayer: keys[0],
    hasLookups: (message.addressTableLookups?.length ?? 0) > 0,
    instructions: message.compiledInstructions.map((ix) => ({
      programId: keys[ix.programIdIndex],
      accounts: [...ix.accountKeyIndexes].map((i) => keys[i]),
      data: ix.data,
    })),
  };
}
