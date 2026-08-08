import fs from 'node:fs';
import { Feed } from './feed.js';
import { RpcFeed } from './rpcfeed.js';
import { ChainFeed } from './chainfeed.js';
import { TokenTracker, Decision } from './strategy.js';
import { Portfolio } from './portfolio.js';
import { PaperExecutor } from './executors/paper.js';
import { LiveExecutor } from './executors/live.js';
import { Logger } from './logger.js';
import { WalletBook } from './walletbook.js';
import { MetaDetector } from './meta.js';
import { Recorder } from './recorder.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--leaderboard') args.leaderboard = true;
  }
  return args;
}

function printLeaderboard(book) {
  const rows = book.top(20, { minClosed: 3, minPnlSol: -Infinity });
  if (rows.length === 0) {
    console.log(`walletbook has ${book.size()} wallets but none with 3+ closed trades yet — let the bot run longer.`);
    return;
  }
  console.log(`top wallets observed (${book.size()} total tracked):`);
  for (const w of rows) {
    console.log(
      `${w.addr}  pnl ${w.pnlSol >= 0 ? '+' : ''}${w.pnlSol.toFixed(3)} SOL  ` +
      `closed ${w.closed}  winrate ${(w.winRate * 100).toFixed(0)}%  buys ${w.buys}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = JSON.parse(fs.readFileSync(args.config ?? 'config.json', 'utf8'));
  if (args.mode) cfg.mode = args.mode;

  const book = new WalletBook();
  if (args.leaderboard) { printLeaderboard(book); return; }

  const log = Logger.forSession();
  const live = cfg.mode === 'live';
  log.info(`pumpfun-bot starting | mode=${cfg.mode} | buy=${cfg.buyAmountSol} SOL | ` +
    `entry: ${cfg.entry.minUniqueBuyers}+ buyers & ${cfg.entry.minNetInflowSol}+ SOL net inflow within ${cfg.watch.windowSec}s | ` +
    `meta=${cfg.meta?.enabled ? 'on' : 'off'} copy=${cfg.copy?.enabled ? 'on' : 'off'}`);
  if (live) {
    log.warn('LIVE MODE: this will spend real SOL. Ctrl+C now if that is not what you want.');
  } else {
    log.info('paper mode: live market data, simulated fills, no real money at risk');
  }

  const executor = live ? new LiveExecutor(cfg, log) : new PaperExecutor(cfg, log);
  if (live) await executor.init();

  const portfolio = new Portfolio(cfg, log);
  const meta = new MetaDetector(cfg.meta ?? {});
  const dataSource = cfg.dataSource ?? 'chain'; // 'chain' (free, full) | 'rpc' (free, reserves) | 'portal' (paid)
  const useRpc = dataSource === 'rpc';
  const useChain = dataSource === 'chain';
  const portalKey = process.env.PUMPBOT_PORTAL_KEY ?? null;

  // Discovery always uses PumpPortal's FREE new-token stream (no key needed).
  const feed = new Feed(log, { apiKey: portalKey });

  // Price / trade data source.
  let rpcFeed = null;
  let chainFeed = null;
  let copyEnabled = cfg.copy?.enabled ?? false;
  const rpcWsUrl = cfg.rpcWsUrl ?? 'wss://api.mainnet-beta.solana.com';
  if (useChain) {
    log.info('data source: FREE on-chain program logs — full trade stream with buyer identity, no key');
    chainFeed = new ChainFeed(log, rpcWsUrl);
    log.warn('public RPCs rate-limit log firehoses; a free Helius/QuickNode WSS in config.rpcWsUrl is strongly recommended.');
  } else if (useRpc) {
    log.info('data source: FREE on-chain RPC (bonding-curve reserves) — no key needed');
    rpcFeed = new RpcFeed(log, rpcWsUrl);
    if (copyEnabled) {
      copyEnabled = false;
      log.warn('copy trading + wallet scoring need per-trade identity — OFF in reserve mode.');
      log.warn('Use dataSource:"chain" (free) or "portal" (paid) to enable them.');
    }
    log.warn('reserve mode gives price + SOL inflow but not buyer identity; entries use reserve-momentum filters.');
  } else {
    if (!portalKey) {
      log.warn('portal data mode needs PUMPBOT_PORTAL_KEY (funded >=0.02 SOL) for trade/account streams.');
      log.warn('Without it the bot can NEVER enter. dataSource:"chain" gives the same data free.');
    }
    feed.on('degraded', (message) => {
      log.error(`feed is DEGRADED (creations only, no trade data): ${message}`);
      log.error('entries are impossible — set a funded PUMPBOT_PORTAL_KEY or switch dataSource to "chain".');
    });
  }

  // Tape recorder: raw launches + young-token trades, for the backtester/tuner.
  const recorder = (cfg.recorder?.enabled ?? true) && !useRpc ? new Recorder(cfg.recorder ?? {}, log) : null;

  const trackers = new Map(); // mint -> TokenTracker
  const busy = new Set(); // mints with an order in flight
  let leaders = new Set(copyEnabled ? cfg.copy.wallets ?? [] : []);

  const drop = (mint) => {
    const t = trackers.get(mint);
    trackers.delete(mint);
    if (useRpc) { if (t?.bondingCurveKey) rpcFeed.unwatchCurve(t.bondingCurveKey); }
    else if (!useChain) feed.unwatchToken(mint); // chain mode: one global sub, nothing to unwind
  };

  const enter = async (t, { source = 'scan', buyAmountSol = cfg.buyAmountSol, leader = null } = {}) => {
    if (busy.has(t.mint) || t.state === 'HOLDING' || t.state === 'DONE') return;
    const reject = portfolio.rejectEntry(buyAmountSol);
    if (reject) return; // keep watching; limits may free up
    busy.add(t.mint);
    try {
      const fill = await executor.buy(t, buyAmountSol);
      t.openPosition(fill);
      t.source = source;
      portfolio.onBuy(t.mint, t.symbol, fill);
      const demand = useRpc
        ? { reserveTicks: t.reserveTicks, netInflowSol: +t.reserveNetInflowSol.toFixed(3) }
        : { buyers: t.uniqueBuyers, netInflowSol: +t.netInflowSol.toFixed(3) };
      log.trade({
        action: 'BUY', mode: cfg.mode, source, leader, mint: t.mint, symbol: t.symbol,
        metaHot: t.metaHot || undefined,
        costSol: +fill.costSol.toFixed(6), tokens: Math.round(fill.tokens),
        price: fill.price, ...demand,
        ageSec: +t.ageSec.toFixed(1), sig: fill.sig,
      });
    } catch (err) {
      log.error(`buy failed ${t.symbol}: ${err.message}`);
      if (source === 'scan') drop(t.mint);
    } finally {
      busy.delete(t.mint);
    }
  };

  const exit = async (t) => {
    if (busy.has(t.mint) || t.state !== 'HOLDING') return;
    busy.add(t.mint);
    try {
      const result = await executor.sell(t, t.position.tokens);
      const pnl = portfolio.onSell(t.mint, result.proceedsSol);
      t.state = 'DONE';
      log.trade({
        action: 'SELL', mode: cfg.mode, source: t.source, mint: t.mint, symbol: t.symbol,
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
    if (decision === Decision.ENTER) enter(t);
    else if (decision === Decision.EXIT) exit(t);
    else if (decision === Decision.DROP) drop(t.mint);
  };

  // Copy-trading: mirror a leader's buy on bonding-curve tokens; follow their sell.
  const onLeaderTrade = (msg) => {
    if (!copyEnabled) return;
    const held = trackers.get(msg.mint);
    if (msg.txType === 'buy') {
      if (held?.state === 'HOLDING' || (msg.pool && msg.pool !== 'pump')) return;
      let t = held;
      if (!t) {
        // Synthetic tracker: the account-trade message carries curve state.
        t = new TokenTracker({ ...msg, solAmount: 0 }, cfg);
        t.creator = null; // unknown for tokens we didn't see launch
        trackers.set(t.mint, t);
        feed.watchToken(t.mint);
      }
      enter(t, { source: 'copy', buyAmountSol: cfg.copy.buyAmountSol ?? cfg.buyAmountSol, leader: msg.traderPublicKey });
    } else if (msg.txType === 'sell' && cfg.copy.followSells) {
      if (held?.state === 'HOLDING' && held.source === 'copy') {
        held.exit('leader-sold');
        exit(held);
      }
    }
  };

  feed.on('newToken', (msg) => {
    recorder?.onCreate(msg);
    const wave = cfg.meta?.enabled ? meta.onLaunch(msg.name, msg.symbol) : { hot: false };
    if (trackers.size >= cfg.watch.maxTrackedTokens) return; // shed load, never queue stale tokens
    const t = new TokenTracker(msg, cfg);
    t.metaHot = wave.hot;
    if (wave.hot) log.info(`meta wave "${wave.word}" — relaxed entry for ${t.symbol} (${t.mint.slice(0, 8)}…)`);
    trackers.set(t.mint, t);
    if (useRpc) rpcFeed.watchCurve(t.mint, t.bondingCurveKey);
    else if (!useChain) feed.watchToken(t.mint);
  });

  // Full per-trade path (buyer identity -> unique-buyer filter, copy, scoring).
  // Fed by the paid portal stream OR the free chain feed — identical shape.
  const onTradeMsg = (msg) => {
    recorder?.onTrade(msg);
    book.onTrade(msg); // score every wallet we can see, always
    if (leaders.has(msg.traderPublicKey)) onLeaderTrade(msg);
    const t = trackers.get(msg.mint);
    if (t) act(t, t.onTrade(msg));
  };
  feed.on('trade', onTradeMsg);
  if (useChain) chainFeed.on('trade', onTradeMsg);

  // Reserve path: curve updates only (price + inflow, no buyer identity).
  if (useRpc) {
    rpcFeed.on('reserve', (u) => {
      const t = trackers.get(u.mint);
      if (t) act(t, t.onReserve(u));
    });
  }

  const refreshLeaders = () => {
    if (!copyEnabled) return;
    const manual = cfg.copy.wallets ?? [];
    let auto = [];
    if (cfg.copy.auto?.enabled) {
      auto = book.top(cfg.copy.auto.top, {
        minClosed: cfg.copy.auto.minClosedTrades,
        minPnlSol: cfg.copy.auto.minPnlSol,
      }).map((w) => w.addr);
    }
    const next = new Set([...manual, ...auto]);
    const changed = next.size !== leaders.size || [...next].some((a) => !leaders.has(a));
    if (changed) {
      leaders = next;
      // Portal mode needs explicit account subscriptions; the chain feed
      // already carries every trade, so the leaders set alone is enough.
      if (!useChain) feed.setWatchedAccounts([...leaders]);
      log.info(`copy leaders now: ${leaders.size ? [...leaders].map((a) => a.slice(0, 8) + '…').join(', ') : 'none yet (auto-discovery keeps scoring)'}`);
    }
  };

  if (copyEnabled) {
    feed.on('open', refreshLeaders);
    setInterval(refreshLeaders, (cfg.copy?.auto?.refreshMin ?? 10) * 60_000);
    setInterval(() => { book.prune(); book.save(); }, 30_000);
  }

  // Safety net: evaluate time-based exits/drops even for tokens that go silent.
  setInterval(() => {
    for (const t of trackers.values()) act(t, t.onTick());
  }, 1000);
  if (recorder) setInterval(() => recorder.prune(), 60_000);

  // Status heartbeat.
  setInterval(() => {
    const src = useRpc ? `curves ${rpcFeed.watchCount}`
      : useChain ? `chain events ${chainFeed.eventCount} | scored ${book.size()} wallets`
      : `scored ${book.size()} wallets`;
    log.info(`status | watching ${trackers.size} tokens | ${src} | ${portfolio.summary()}`);
  }, 60_000);

  process.on('SIGINT', () => {
    log.info('shutting down');
    if (copyEnabled) book.save();
    log.info(`FINAL | ${portfolio.summary()}`);
    if (portfolio.openPositions.size > 0) {
      log.warn(`open positions remain: ${[...portfolio.openPositions.keys()].join(', ')}` +
        (live ? ' — sell them manually or restart the bot.' : ''));
    }
    feed.stop();
    rpcFeed?.stop();
    chainFeed?.stop();
    recorder?.stop();
    process.exit(0);
  });

  feed.connect();
  rpcFeed?.connect();
  chainFeed?.connect();
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
