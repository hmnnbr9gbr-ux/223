import fs from 'node:fs';
import path from 'node:path';

// Market tape recorder: writes every launch (and every trade on recently
// launched tokens) to data/tape-YYYY-MM-DD.jsonl in a compact format the
// backtester replays. Recording only young tokens bounds file growth — dead
// launches stop producing lines within minutes.

export class Recorder {
  constructor({ trackMinutes = 10 } = {}, logger) {
    this.log = logger;
    this.trackMs = trackMinutes * 60_000;
    this.recent = new Map(); // mint -> createdAt
    this.stream = null;
    this.day = null;
  }

  ensureStream(now) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.stream?.end();
      fs.mkdirSync('data', { recursive: true });
      const file = path.join('data', `tape-${day}.jsonl`);
      this.stream = fs.createWriteStream(file, { flags: 'a' });
      this.day = day;
      this.log?.info(`recording market tape → ${file}`);
    }
    return this.stream;
  }

  onCreate(msg, now = Date.now()) {
    this.recent.set(msg.mint, now);
    this.ensureStream(now).write(JSON.stringify({
      k: 'c', at: now, m: msg.mint, n: msg.name, s: msg.symbol,
      c: msg.traderPublicKey, ds: Number(msg.solAmount ?? 0),
      vs: Number(msg.vSolInBondingCurve ?? 0), vt: Number(msg.vTokensInBondingCurve ?? 0),
      bc: msg.bondingCurveKey,
    }) + '\n');
  }

  onTrade(msg, now = Date.now()) {
    const created = this.recent.get(msg.mint);
    if (created === undefined || now - created > this.trackMs) return;
    this.ensureStream(now).write(JSON.stringify({
      k: 't', at: now, m: msg.mint, x: msg.txType,
      sol: Number(msg.solAmount ?? 0), tok: Number(msg.tokenAmount ?? 0),
      w: msg.traderPublicKey,
      vs: Number(msg.vSolInBondingCurve ?? 0), vt: Number(msg.vTokensInBondingCurve ?? 0),
    }) + '\n');
  }

  prune(now = Date.now()) {
    for (const [mint, at] of this.recent) if (now - at > this.trackMs) this.recent.delete(mint);
  }

  stop() { this.stream?.end(); }
}

/** Convert a tape line back into the live message shapes the engine uses. */
export function fromTapeLine(line) {
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (r.k === 'c') {
    return { kind: 'create', at: r.at, msg: {
      mint: r.m, name: r.n, symbol: r.s, traderPublicKey: r.c, solAmount: r.ds,
      vSolInBondingCurve: r.vs, vTokensInBondingCurve: r.vt, bondingCurveKey: r.bc, txType: 'create',
    } };
  }
  if (r.k === 't') {
    return { kind: 'trade', at: r.at, msg: {
      mint: r.m, txType: r.x, solAmount: r.sol, tokenAmount: r.tok,
      traderPublicKey: r.w, vSolInBondingCurve: r.vs, vTokensInBondingCurve: r.vt, pool: 'pump',
    } };
  }
  return null;
}
