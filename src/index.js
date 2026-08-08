import fs from 'node:fs';
import { Feed } from './feed.js';
import { TokenTracker, Decision } from './strategy.js';
import { Portfolio } from './portfolio.js';
import { PaperExecutor } from './executors/paper.js';
import { LiveExecutor } from './executors/live.js';
import { Logger } from './logger.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--config') args.config = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = JSON.parse(fs.readFileSync(args.config ?? 'config.json', 'utf8'));
  if (args.mode) cfg.mode = args.mode;

  const log = Logger.forSession();
  const live = cfg.mode === 'live';
  log.info(`pumpfun-bot starting | mode=${cfg.mode} | buy=${cfg.buyAmountSol} SOL | ` +
    `entry: ${cfg.entry.minUniqueBuyers}+ buyers & ${cfg.entry.minNetInflowSol}+ SOL net inflow within ${cfg.watch.windowSec}s`);
  if (live) {
    log.warn('LIVE MODE: this will spend real SOL. Ctrl+C now if that is not what you want.');
  } else {
    log.info('paper mode: live market data, simulated fills, no real money at risk');
  }

  const executor = live ? new LiveExecutor(cfg, log) : new PaperExecutor(cfg, log);
  if (live) await executor.init();

  const portfolio = new Portfolio(cfg, log);
  const portalKey = process.env.PUMPBOT_PORTAL_KEY ?? null;
  if (!portalKey) {
    log.warn('no PUMPBOT_PORTAL_KEY set — PumpPortal requires an API key funded with >=0.02 SOL for');
    log.warn('per-token trade streams. Without one the bot sees launches but can NEVER enter a trade.');
    log.warn('Get a key at pumpportal.fun, fund it, then: export PUMPBOT_PORTAL_KEY=<key>');
  }
  const feed = new Feed(log, { apiKey: portalKey });
  feed.on('degraded', (message) => {
    log.error(`feed is DEGRADED (creations only, no trade data): ${message}`);
    log.error('entries are impossible in this state — set a funded PUMPBOT_PORTAL_KEY and restart.');
  });
  const trackers = new Map(); // mint -> TokenTracker
  let busy = new Set(); // mints with an order in flight

  const drop = (mint) => {
    trackers.delete(mint);
    feed.unwatchToken(mint);
  };

  const tryEnter = async (t) => {
    if (busy.has(t.mint) || t.state !== 'WATCHING') return;
    const reject = portfolio.rejectEntry(cfg.buyAmountSol);
    if (reject) return; // keep watching; limits may free up
    busy.add(t.mint);
    try {
      const fill = await executor.buy(t, cfg.buyAmountSol);
      t.openPosition(fill);
      portfolio.onBuy(t.mint, t.symbol, fill);
      log.trade({
        action: 'BUY', mode: cfg.mode, mint: t.mint, symbol: t.symbol,
        costSol: +fill.costSol.toFixed(6), tokens: Math.round(fill.tokens),
        price: fill.price, buyers: t.uniqueBuyers, netInflowSol: +t.netInflowSol.toFixed(3),
        ageSec: +t.ageSec.toFixed(1), sig: fill.sig,
      });
    } catch (err) {
      log.error(`buy failed ${t.symbol}: ${err.message}`);
      drop(t.mint);
    } finally {
      busy.delete(t.mint);
    }
  };

  const tryExit = async (t) => {
    if (busy.has(t.mint) || t.state !== 'HOLDING') return;
    busy.add(t.mint);
    try {
      const result = await executor.sell(t, t.position.tokens);
      const pnl = portfolio.onSell(t.mint, result.proceedsSol);
      t.state = 'DONE';
      log.trade({
        action: 'SELL', mode: cfg.mode, mint: t.mint, symbol: t.symbol,
        reason: t.exitReason, proceedsSol: +result.proceedsSol.toFixed(6),
        pnlSol: +pnl.toFixed(6), sig: result.sig,
      });
      log.info(portfolio.summary());
    } catch (err) {
      log.error(`sell failed ${t.symbol}: ${err.message} (will retry on next tick)`);
      t.state = 'HOLDING';
    } finally {
      busy.delete(t.mint);
    }
    if (t.state === 'DONE') drop(t.mint);
  };

  const act = (t, decision) => {
    if (decision === Decision.ENTER) tryEnter(t);
    else if (decision === Decision.EXIT) tryExit(t);
    else if (decision === Decision.DROP) drop(t.mint);
  };

  feed.on('newToken', (msg) => {
    if (trackers.size >= cfg.watch.maxTrackedTokens) return; // shed load, never queue stale tokens
    const t = new TokenTracker(msg, cfg);
    trackers.set(t.mint, t);
    feed.watchToken(t.mint);
  });

  feed.on('trade', (msg) => {
    const t = trackers.get(msg.mint);
    if (t) act(t, t.onTrade(msg));
  });

  // Safety net: evaluate time-based exits/drops even for tokens that go silent.
  setInterval(() => {
    for (const t of trackers.values()) act(t, t.onTick());
  }, 1000);

  // Status heartbeat.
  setInterval(() => {
    log.info(`status | watching ${trackers.size} tokens | ${portfolio.summary()}`);
  }, 60_000);

  process.on('SIGINT', () => {
    log.info('shutting down');
    log.info(`FINAL | ${portfolio.summary()}`);
    if (portfolio.openPositions.size > 0) {
      log.warn(`open positions remain: ${[...portfolio.openPositions.keys()].join(', ')}` +
        (live ? ' — sell them manually or restart the bot.' : ''));
    }
    feed.stop();
    process.exit(0);
  });

  feed.connect();
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
