// Decode a pump.fun bonding-curve account straight from the chain, so the bot
// can read price and SOL inflow for FREE via a public Solana RPC instead of
// paying PumpPortal's metered trade stream.
//
// Layout (borsh, confirmed against pumpdotfun-sdk and the rubpy gist):
//   0x00  discriminator      8 bytes = 17 b7 f8 37 60 d8 ac 60
//   0x08  virtualTokenReserves  u64 LE  (raw, 6 decimals)
//   0x10  virtualSolReserves    u64 LE  (lamports)
//   0x18  realTokenReserves     u64 LE
//   0x20  realSolReserves       u64 LE
//   0x28  tokenTotalSupply      u64 LE
//   0x30  complete              u8 (bool)

export const CURVE_DISCRIMINATOR = Uint8Array.from([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);
const LAMPORTS_PER_SOL = 1e9;
const TOKEN_UNITS = 1e6; // pump.fun tokens use 6 decimals

/**
 * @param {Buffer|Uint8Array} buf raw account data (already base64-decoded)
 * @returns {{vTok:number, vSol:number, realTok:number, realSol:number, supply:number, complete:boolean}}
 */
export function decodeCurve(buf) {
  if (!buf || buf.length < 0x31) throw new Error(`curve account too short: ${buf?.length} bytes`);
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== CURVE_DISCRIMINATOR[i]) throw new Error('not a pump.fun bonding-curve account (bad discriminator)');
  }
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const u64 = (off) => Number(view.readBigUInt64LE(off));
  return {
    vTok: u64(0x08) / TOKEN_UNITS,
    vSol: u64(0x10) / LAMPORTS_PER_SOL,
    realTok: u64(0x18) / TOKEN_UNITS,
    realSol: u64(0x20) / LAMPORTS_PER_SOL,
    supply: u64(0x28) / TOKEN_UNITS,
    complete: view[0x30] !== 0,
  };
}

/** Encode a curve for tests (inverse of decodeCurve). */
export function encodeCurve({ vTok, vSol, realTok = 0, realSol = 0, supply = 0, complete = false }) {
  const buf = Buffer.alloc(0x31);
  CURVE_DISCRIMINATOR.forEach((b, i) => { buf[i] = b; });
  buf.writeBigUInt64LE(BigInt(Math.round(vTok * TOKEN_UNITS)), 0x08);
  buf.writeBigUInt64LE(BigInt(Math.round(vSol * LAMPORTS_PER_SOL)), 0x10);
  buf.writeBigUInt64LE(BigInt(Math.round(realTok * TOKEN_UNITS)), 0x18);
  buf.writeBigUInt64LE(BigInt(Math.round(realSol * LAMPORTS_PER_SOL)), 0x20);
  buf.writeBigUInt64LE(BigInt(Math.round(supply * TOKEN_UNITS)), 0x28);
  buf[0x30] = complete ? 1 : 0;
  return buf;
}
