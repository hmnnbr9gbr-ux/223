import fs from 'node:fs';
import { TokenTracker, Decision } from './strategy.js';
import { PaperExecutor } from './executors/paper.js';
import { MetaDetector } from './meta.js';
import { fromTapeLine } from './recorder.js';

// Replay a recorded market tape through the strategy at full speed, then
// grid-search entry/exit parameters to find what would have actually made
// money. The tuner's verdict comes from real market data, not vibes.
//
//   npm run backtest -- data/tape-2026-08-08.jsonl            (current config)
//   npm run backtest -- data/tape-*.jsonl --grid              (parameter search)

const noopLog = { info() {}, warn() {}, error() {}, trade() {} };

export function runBacktest(events, cfg) {
  const executor = new PaperExecutor(cfg, noopLog);
  const meta = cfg.meta?.enabled ? new MetaDetector(cfg.meta) : null;
  const trackers = new Map();
  const stats = {
    launches: 0, trades: 0, wins: 0, losses: 0, pnlSol: 0,
    spentSol: 0, byReason: {}, openAtEnd: 0,
  };
  let openCount = 0;
  let lastSweep = 0;

  const tryEnter = async (t, at) => {
    if (openCount >= cfg.maxConcurrentPositions || t.state !== 'WATCHING') return;
    const fill = await executor.buy(t, cfg.buyAmountSol);
    t.openPosition(fill, at);
    openCount++;
    stats.spentSol += fill.costSol;
  };

  const doExit = async (t) => {
    const result = await executor.sell(t, t.position.tokens);
    const pnl = result.proceedsSol - t.position.costSol;
    stats.trades++;
    stats.pnlSol += pnl;
    if (pnl >= 0) stats.wins++; else stats.losses++;
    const r = (stats.byReason[t.exitReason] ??= { n: 0, pnlSol: 0 });
    r.n++;
    r.pnlSol += pnl;
    t.state = 'DONE';
    openCount--;
    trackers.delete(t.mint);
  };

  const act = async (t, decision, at) => {
    if (decision === Decision.ENTER) await tryEnter(t, at);
    else if (decision === Decision.EXIT) await doExit(t);
    else if (decision === Decision.DROP) trackers.delete(t.mint);
  };

  return (async () => {
    for (const ev of events) {
      // Sweep time-based exits/drops once per simulated second.
      if (ev.at - lastSweep >= 1000) {
        lastSweep = ev.at;
        for (const t of [...trackers.values()]) await act(t, t.onTick(ev.at), ev.at);
      }
      if (ev.kind === 'create') {
        stats.launches++;
        if (trackers.size >= (cfg.watch.maxTrackedTokens ?? 60) + openCount) continue;
        const t = new TokenTracker(ev.msg, cfg, ev.at);
        if (meta) t.metaHot = meta.onLaunch(ev.msg.name, ev.msg.symbol, ev.at).hot;
        trackers.set(t.mint, t);
      } else if (ev.kind === 'trade') {
        const t = trackers.get(ev.msg.mint);
        if (t) await act(t, t.onTrade(ev.msg, ev.at), ev.at);
      }
    }
    // Force-close leftovers at last price so the report is complete.
    for (const t of [...trackers.values()]) {
      if (t.state === 'HOLDING') { t.exitReason = 'end-of-tape'; stats.openAtEnd++; await doExit(t); }
    }
    return stats;
  })();
}

export function loadTape(files) {
  const events = [];
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      const ev = fromTapeLine(line);
      if (ev) events.push(ev);
    }
  }
  events.sort((a, b) => a.at - b.at);
  return events;
}

const GRID = {
  'entry.minUniqueBuyers': [4, 6, 8, 12],
  'entry.minNetInflowSol': [0.8, 1.5, 2.5],
  'exit.takeProfitPct': [40, 60, 100],
  'exit.stopLossPct': [20, 25, 35],
  'exit.maxHoldSec': [120, 300],
};

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)] = value;
}

export async function gridSearch(events, baseCfg, grid = GRID) {
  const keys = Object.keys(grid);
  const combos = keys.reduce((acc, k) => acc.flatMap((c) => grid[k].map((v) => [...c, [k, v]])), [[]]);
  const results = [];
  for (const combo of combos) {
    const cfg = structuredClone(baseCfg);
    for (const [k, v] of combo) setPath(cfg, k, v);
    const stats = await runBacktest(events, cfg);
    results.push({ params: Object.fromEntries(combo), ...stats });
  }
  results.sort((a, b) => b.pnlSol - a.pnlSol);
  return results;
}

function fmt(stats) {
  const wr = stats.trades ? ((stats.wins / stats.trades) * 100).toFixed(0) : '0';
  return `trades ${stats.trades} | winrate ${wr}% | pnl ${stats.pnlSol >= 0 ? '+' : ''}${stats.pnlSol.toFixed(4)} SOL | spent ${stats.spentSol.toFixed(3)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const doGrid = args.includes('--grid');
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('usage: npm run backtest -- data/tape-*.jsonl [--grid]');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  const events = loadTape(files);
  const spanMin = events.length ? ((events.at(-1).at - events[0].at) / 60_000).toFixed(1) : 0;
  console.log(`tape: ${events.length} events over ${spanMin} min from ${files.length} file(s)`);

  if (!doGrid) {
    const stats = await runBacktest(events, cfg);
    console.log(`\ncurrent config → ${fmt(stats)}`);
    console.log(`launches seen: ${stats.launches} | still open at end: ${stats.openAtEnd}`);
    for (const [reason, r] of Object.entries(stats.byReason)) {
      console.log(`  ${reason.padEnd(14)} n=${String(r.n).padStart(4)}  pnl ${r.pnlSol >= 0 ? '+' : ''}${r.pnlSol.toFixed(4)}`);
    }
    return;
  }

  console.log('grid search running (216 combos)…');
  const results = await gridSearch(events, cfg);
  console.log('\nTOP 10 CONFIGS BY PNL:');
  for (const r of results.slice(0, 10)) {
    console.log(`${fmt(r)}\n    ${JSON.stringify(r.params)}`);
  }
  const bottom = results.at(-1);
  console.log(`\nworst combo (so you see the spread): ${fmt(bottom)}`);
  console.log('\nApply a winner by editing config.json — then verify it forward in paper mode.');
  console.log('WARNING: top-of-grid is optimistically biased (overfitting). Trust configs that');
  console.log('rank high across MULTIPLE days of tape, not one lucky afternoon.');
}

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').at(-1));
if (isCli) main().catch((e) => { console.error(e); process.exit(1); });
