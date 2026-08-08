// Decode pump.fun anchor events straight from transaction logs
// ("Program data: <base64>" lines emitted by the pump.fun program).
//
// TradeEvent layout (verified live against mainnet, Aug 2026):
//   0x00 discriminator        8  = bd db 7f d3 4e e6 61 ee ("vdt/007mYe4")
//   0x08 mint            pubkey 32
//   0x28 solAmount          u64 (lamports)
//   0x30 tokenAmount        u64 (6-decimals raw)
//   0x38 isBuy               u8
//   0x39 user            pubkey 32
//   0x59 timestamp          i64
//   0x61 virtualSolReserves u64
//   0x69 virtualTokenReserves u64
//   ...  trailing fields (real reserves, fee breakdown) vary by program
//        version — we only read the stable prefix.

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const TRADE_EVENT_DISC = Uint8Array.from([0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee]);

const LAMPORTS = 1e9;
const TOKEN_UNITS = 1e6;
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58-encode a byte array (dependency-free, fine for 32-byte keys). */
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out || '1';
}

/**
 * Decode one "Program data:" payload. Returns a PumpPortal-shaped trade
 * message, or null if the payload is not a TradeEvent.
 */
export function decodeTradeEvent(buf) {
  if (!buf || buf.length < 0x71) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== TRADE_EVENT_DISC[i]) return null;
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return {
    mint: base58(view.subarray(0x08, 0x28)),
    txType: view[0x38] ? 'buy' : 'sell',
    solAmount: Number(view.readBigUInt64LE(0x28)) / LAMPORTS,
    tokenAmount: Number(view.readBigUInt64LE(0x30)) / TOKEN_UNITS,
    traderPublicKey: base58(view.subarray(0x39, 0x59)),
    timestamp: Number(view.readBigInt64LE(0x59)),
    vSolInBondingCurve: Number(view.readBigUInt64LE(0x61)) / LAMPORTS,
    vTokensInBondingCurve: Number(view.readBigUInt64LE(0x69)) / TOKEN_UNITS,
    pool: 'pump',
  };
}

/** Extract all trade events from a transaction's log lines. */
export function tradesFromLogs(logs) {
  const out = [];
  for (const line of logs ?? []) {
    if (!line.startsWith('Program data: ')) continue;
    let buf;
    try { buf = Buffer.from(line.slice(14), 'base64'); } catch { continue; }
    const t = decodeTradeEvent(buf);
    if (t) out.push(t);
  }
  return out;
}

/** Encode a TradeEvent for tests (inverse of decodeTradeEvent's prefix). */
export function encodeTradeEvent({ mintBytes, solAmount, tokenAmount, isBuy, userBytes, timestamp, vSol, vTok }) {
  const buf = Buffer.alloc(0x71);
  TRADE_EVENT_DISC.forEach((b, i) => { buf[i] = b; });
  Buffer.from(mintBytes).copy(buf, 0x08);
  buf.writeBigUInt64LE(BigInt(Math.round(solAmount * LAMPORTS)), 0x28);
  buf.writeBigUInt64LE(BigInt(Math.round(tokenAmount * TOKEN_UNITS)), 0x30);
  buf[0x38] = isBuy ? 1 : 0;
  Buffer.from(userBytes).copy(buf, 0x39);
  buf.writeBigInt64LE(BigInt(timestamp), 0x59);
  buf.writeBigUInt64LE(BigInt(Math.round(vSol * LAMPORTS)), 0x61);
  buf.writeBigUInt64LE(BigInt(Math.round(vTok * TOKEN_UNITS)), 0x69);
  return buf;
}
