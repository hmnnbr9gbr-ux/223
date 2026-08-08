import fs from 'node:fs';
import { fromTapeLine } from './recorder.js';
import { price } from './curve.js';

// Tape miner: reconstruct each token's early life from a recorded tape and
// test which launch-moment features actually predict a pump. This is the
// hunt for a real, data-backed edge — not a hand-guessed filter.
//
//   npm run analyze -- data/tape-*.jsonl [--horizon 60] [--feature-sec 15]
//
// For every launch we compute features from its first FEATURE_SEC seconds,
// then label the outcome by the max price reached within HORIZON seconds
// (relative to the price at the end of the feature window). We report, for
// each feature, how strongly it separates pumps from duds.

const DEFAULT_FEATURE_SEC = 15;
const DEFAULT_HORIZON_SEC = 90;
const PUMP_THRESHOLD = 1.30; // +30% from feature-window price counts as a pump

export function buildTokens(events) {
  const tokens = new Map();
  for (const ev of events) {
    if (ev.kind === 'create') {
      tokens.set(ev.msg.mint, {
        mint: ev.msg.mint, name: ev.msg.name, symbol: ev.msg.symbol,
        creator: ev.msg.traderPublicKey, createdAt: ev.at,
        devBuySol: Number(ev.msg.solAmount ?? 0),
        vSol0: Number(ev.msg.vSolInBondingCurve ?? 0), vTok0: Number(ev.msg.vTokensInBondingCurve ?? 0),
        trades: [],
      });
    } else if (ev.kind === 'trade') {
      tokens.get(ev.msg.mint)?.trades.push(ev);
    }
  }
  return tokens;
}

function featuresFor(tok, featureSec, horizonSec) {
  const fEnd = tok.createdAt + featureSec * 1000;
  const hEnd = tok.createdAt + horizonSec * 1000;
  const early = tok.trades.filter((e) => e.at <= fEnd);
  if (early.length < 2) return null; // no real early activity to judge

  const buyers = new Set();
  let buys = 0, sells = 0, buySol = 0, sellSol = 0, topBuy = 0;
  let firstBuyLatencyMs = null;
  const buyBySender = new Map();
  for (const e of early) {
    const sol = Number(e.msg.solAmount ?? 0);
    if (e.msg.txType === 'buy') {
      buys++; buySol += sol; buyers.add(e.msg.traderPublicKey);
      buyBySender.set(e.msg.traderPublicKey, (buyBySender.get(e.msg.traderPublicKey) ?? 0) + sol);
      if (firstBuyLatencyMs === null) firstBuyLatencyMs = e.at - tok.createdAt;
    } else { sells++; sellSol += sol; }
  }
  for (const v of buyBySender.values()) topBuy = Math.max(topBuy, v);

  // price at end of feature window (last known reserves)
  const lastEarly = early.at(-1).msg;
  const pFeat = price(Number(lastEarly.vSolInBondingCurve), Number(lastEarly.vTokensInBondingCurve));
  if (!(pFeat > 0)) return null;

  // outcome: max price within horizon, after the feature window
  let pMax = pFeat;
  for (const e of tok.trades) {
    if (e.at <= fEnd || e.at > hEnd) continue;
    const p = price(Number(e.msg.vSolInBondingCurve), Number(e.msg.vTokensInBondingCurve));
    if (p > pMax) pMax = p;
  }
  const creatorSoldEarly = early.some((e) => e.msg.txType === 'sell' && e.msg.traderPublicKey === tok.creator);

  return {
    mint: tok.mint,
    // features (all measured within the feature window)
    uniqueBuyers: buyers.size,
    netInflowSol: buySol - sellSol,
    buySellRatio: sells > 0 ? buys / sells : buys,
    topBuyerShare: buySol > 0 ? topBuy / buySol : 0,
    firstBuyLatencyMs: firstBuyLatencyMs ?? featureSec * 1000,
    devBuySol: tok.devBuySol,
    tradeCount: early.length,
    creatorSoldEarly: creatorSoldEarly ? 1 : 0,
    // outcome
    maxGain: pMax / pFeat,
    pumped: pMax / pFeat >= PUMP_THRESHOLD ? 1 : 0,
  };
}

// Correlation of a numeric feature with the pump label (point-biserial ~ Pearson).
function correlate(rows, key) {
  const xs = rows.map((r) => r[key]);
  const ys = rows.map((r) => r.pumped);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const denom = Math.sqrt(sxx * syy);
  return denom === 0 ? 0 : sxy / denom;
}

// Lift from a threshold split: P(pump | feature>=thr) vs base rate.
function bestSplit(rows, key, higherIsBullish = true) {
  const base = rows.reduce((a, r) => a + r.pumped, 0) / rows.length;
  const values = [...new Set(rows.map((r) => r[key]))].sort((a, b) => a - b);
  let best = null;
  for (const thr of values) {
    const side = rows.filter((r) => (higherIsBullish ? r[key] >= thr : r[key] <= thr));
    if (side.length < Math.max(20, rows.length * 0.05)) continue; // need a meaningful cohort
    const rate = side.reduce((a, r) => a + r.pumped, 0) / side.length;
    const lift = base > 0 ? rate / base : 0;
    if (!best || lift > best.lift) best = { thr, cohort: side.length, rate, lift };
  }
  return best ? { key, dir: higherIsBullish ? '>=' : '<=', ...best, base } : null;
}

export function analyze(rows) {
  const numericKeys = ['uniqueBuyers', 'netInflowSol', 'buySellRatio', 'topBuyerShare',
    'firstBuyLatencyMs', 'devBuySol', 'tradeCount', 'creatorSoldEarly'];
  const corr = numericKeys.map((k) => ({ key: k, r: correlate(rows, k) }))
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  // Test each feature in its intuitive bullish direction AND the inverse; keep the better split.
  const splits = [];
  for (const k of numericKeys) {
    const hi = bestSplit(rows, k, true);
    const lo = bestSplit(rows, k, false);
    for (const s of [hi, lo]) if (s) splits.push(s);
  }
  splits.sort((a, b) => b.lift - a.lift);
  return { corr, splits };
}

function main() {
  const args = process.argv.slice(2);
  const featureSec = Number(args[args.indexOf('--feature-sec') + 1]) || DEFAULT_FEATURE_SEC;
  const horizonSec = Number(args[args.indexOf('--horizon') + 1]) || DEFAULT_HORIZON_SEC;
  const files = args.filter((a) => !a.startsWith('--') && a.endsWith('.jsonl'));
  if (files.length === 0) { console.error('usage: npm run analyze -- data/tape-*.jsonl [--feature-sec 15] [--horizon 90]'); process.exit(1); }

  const events = [];
  for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) { const e = line && fromTapeLine(line); if (e) events.push(e); }
  events.sort((a, b) => a.at - b.at);

  const tokens = buildTokens(events);
  const rows = [];
  for (const tok of tokens.values()) { const r = featuresFor(tok, featureSec, horizonSec); if (r) rows.push(r); }

  console.log(`tape: ${events.length} events, ${tokens.size} launches`);
  console.log(`analyzable tokens (>=2 early trades): ${rows.length}`);
  if (rows.length < 30) { console.log('\nToo few tokens for stable stats — record a longer tape (aim for 500+ launches).'); return; }

  const base = (rows.reduce((a, r) => a + r.pumped, 0) / rows.length * 100).toFixed(1);
  console.log(`base pump rate (+${((PUMP_THRESHOLD - 1) * 100).toFixed(0)}% within ${horizonSec}s of the ${featureSec}s mark): ${base}%\n`);

  const { corr, splits } = analyze(rows);
  console.log('FEATURE CORRELATION WITH PUMP (point-biserial r, sorted by strength):');
  for (const c of corr) console.log(`  ${c.key.padEnd(18)} r = ${c.r >= 0 ? '+' : ''}${c.r.toFixed(3)}`);

  console.log('\nTOP PREDICTIVE SPLITS (highest lift over base rate):');
  const seen = new Set();
  for (const s of splits) {
    if (seen.has(s.key)) continue; seen.add(s.key); // one best rule per feature
    console.log(`  ${s.key} ${s.dir} ${round(s.thr).padStart(8)}  →  pump ${(s.rate * 100).toFixed(1)}%  (${s.lift.toFixed(2)}x base)  n=${s.cohort}`);
  }
  console.log('\nRead: lift > 1 = bullish signal, < 1 = bearish. Turn the strongest rules into');
  console.log('config filters, then confirm with backtest --grid across MULTIPLE days of tape.');
}

function round(x) { return Math.abs(x) >= 1000 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(4); }

const isCli = process.argv[1] && process.argv[1].endsWith('analyze.js');
if (isCli) main();
