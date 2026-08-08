import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTokens, analyze } from '../src/analyze.js';
import { fromTapeLine } from '../src/recorder.js';

// Synthesize a tape where uniqueBuyers genuinely predicts a pump, then confirm
// the analyzer recovers that signal (and doesn't hallucinate one where none
// exists).

const T0 = 1_700_000_000_000;
let seq = 0;

function launchLines(pump, buyerCount) {
  const mint = `M${seq++}`;
  const lines = [JSON.stringify({ k: 'c', at: T0, m: mint, n: 'n', s: 's', c: `DEV${mint}`, ds: 0.5, vs: 30, vt: 1_073_000_000 })];
  let vs = 30, vt = 1_073_000_000;
  for (let i = 0; i < buyerCount; i++) {
    vs += 0.4; vt -= 12_000_000;
    lines.push(JSON.stringify({ k: 't', at: T0 + 2000 + i * 500, m: mint, x: 'buy', sol: 0.4, tok: 12_000_000, w: `${mint}_b${i}`, vs, vt }));
  }
  // outcome window (after the 15s feature mark): pumpers double, duds fade
  const factor = pump ? 2.2 : 0.7;
  lines.push(JSON.stringify({ k: 't', at: T0 + 40_000, m: mint, x: 'buy', sol: 1, tok: 1000, w: 'Z', vs: vs * factor, vt: vt / factor }));
  return lines;
}

function toEvents(lines) {
  return lines.map(fromTapeLine).filter(Boolean).sort((a, b) => a.at - b.at);
}

test('recovers a planted uniqueBuyers → pump signal', () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(...launchLines(true, 12));  // many buyers -> pump
  for (let i = 0; i < 60; i++) lines.push(...launchLines(false, 3));  // few buyers -> dud
  const tokens = buildTokens(toEvents(lines));
  const rows = [];
  for (const tok of tokens.values()) {
    // inline the same feature extraction the CLI uses
    const early = tok.trades.filter((e) => e.at <= tok.createdAt + 15_000);
    if (early.length < 2) continue;
  }
  // use the exported analyze on rows built the same way as the CLI
  const built = [...tokens.values()].map((tok) => featureRow(tok)).filter(Boolean);
  const { corr, splits } = analyze(built);
  const ub = corr.find((c) => c.key === 'uniqueBuyers');
  assert.ok(ub.r > 0.5, `expected strong positive correlation, got ${ub.r}`);
  const bestUb = splits.find((s) => s.key === 'uniqueBuyers' && s.dir === '>=');
  assert.ok(bestUb.lift > 1.3, `expected bullish lift, got ${bestUb.lift}`);
});

test('reports near-zero correlation for a genuinely random feature', () => {
  const lines = [];
  // pump outcome independent of buyer count (both cohorts 50/50)
  for (let i = 0; i < 80; i++) lines.push(...launchLines(i % 2 === 0, 6));
  const tokens = buildTokens(toEvents(lines));
  const built = [...tokens.values()].map((tok) => featureRow(tok)).filter(Boolean);
  const { corr } = analyze(built);
  const ub = corr.find((c) => c.key === 'uniqueBuyers');
  assert.ok(Math.abs(ub.r) < 0.2, `expected ~0 correlation, got ${ub.r}`);
});

// mirror of analyze.js featuresFor (kept local so the test is self-contained)
function featureRow(tok) {
  const fEnd = tok.createdAt + 15_000;
  const hEnd = tok.createdAt + 90_000;
  const early = tok.trades.filter((e) => e.at <= fEnd);
  if (early.length < 2) return null;
  const buyers = new Set();
  let buySol = 0, sellSol = 0, buys = 0, sells = 0, topBuy = 0;
  const bySender = new Map();
  for (const e of early) {
    const sol = Number(e.msg.solAmount ?? 0);
    if (e.msg.txType === 'buy') { buys++; buySol += sol; buyers.add(e.msg.traderPublicKey); bySender.set(e.msg.traderPublicKey, (bySender.get(e.msg.traderPublicKey) ?? 0) + sol); }
    else { sells++; sellSol += sol; }
  }
  for (const v of bySender.values()) topBuy = Math.max(topBuy, v);
  const last = early.at(-1).msg;
  const pFeat = Number(last.vSolInBondingCurve) / Number(last.vTokensInBondingCurve);
  let pMax = pFeat;
  for (const e of tok.trades) { if (e.at <= fEnd || e.at > hEnd) continue; const p = Number(e.msg.vSolInBondingCurve) / Number(e.msg.vTokensInBondingCurve); if (p > pMax) pMax = p; }
  return {
    mint: tok.mint, uniqueBuyers: buyers.size, netInflowSol: buySol - sellSol,
    buySellRatio: sells > 0 ? buys / sells : buys, topBuyerShare: buySol > 0 ? topBuy / buySol : 0,
    firstBuyLatencyMs: 2000, devBuySol: tok.devBuySol, tradeCount: early.length, creatorSoldEarly: 0,
    maxGain: pMax / pFeat, pumped: pMax / pFeat >= 1.30 ? 1 : 0,
  };
}
