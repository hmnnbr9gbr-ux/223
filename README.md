# pumpfun-bot

A pump.fun momentum trading bot with a **paper-trading mode as the default**: it
consumes the live PumpPortal market-data feed, applies a "confirmation momentum"
strategy with hard risk limits, and either simulates fills against the real
bonding curve (paper) or executes real trades through PumpPortal's
local-transaction API with a key that never leaves your machine (live).

## Read this before running it

The on-chain numbers for pump.fun are brutal and you should know them going in:

- **>50% of new tokens are sniped by bots in the same block they're created.**
  This bot deliberately does not try to win that race — it waits ~10s and only
  buys tokens showing real, distributed demand.
- **95%+ of tokens never graduate** and the median small buyer finishes down
  60–100%. A round trip through this bot costs roughly **3–5%** (1% pump.fun fee
  each way + 0.5% PumpPortal fee each way + priority fees + slippage), so a
  strategy has to clear that bar *on average* just to break even.
- Most retail trading bots lose money. That is why paper mode is the default:
  **run it for days and let the trade log prove the strategy out (or not) with
  fake money before a single real lamport is at risk.**

This bot contains no manipulation features by design: no bundled buys, no
multi-wallet games, no fake volume, no wash trading. It watches, buys, manages
risk, and sells — with your own single wallet.

## Quick start (paper mode — no wallet, ~$1.50 one-time for market data)

Heads-up on the one unavoidable cost: PumpPortal's free WebSocket only streams
*token creations*. The per-token **trade stream — which this strategy needs to
see demand — requires a PumpPortal API key funded with ≥0.02 SOL (~$1.50)**.
Create one at [pumpportal.fun](https://pumpportal.fun), fund it, and export it.
(This data key is separate from any trading wallet; live trading via
`trade-local` does not use it.) Without the key the bot runs, watches launches,
and warns loudly that it can never enter.

```bash
npm install
export PUMPBOT_PORTAL_KEY="your-pumpportal-api-key"
npm run paper
```

You'll see the live firehose of new tokens being watched, entries when a token
passes the filters, and exits with P&L in SOL. Every trade is appended to
`logs/trades-<timestamp>.jsonl` for later analysis. `Ctrl+C` prints a session
summary.

Run the unit tests (bonding-curve math + strategy state machine):

```bash
npm test
```

## The strategy

**Entry — "confirmation momentum".** For each newly created token the bot
watches the first `watch.windowSec` (90s) and enters only if ALL of these hold:

| Filter | Default | Why |
|---|---|---|
| `minAgeSec` | 10s | skip the block-0 sniper zone entirely |
| `maxDevBuySol` | 2.0 | oversized dev buys correlate with dump-on-you launches |
| `minUniqueBuyers` | 8 | demand must be distributed, not one wallet |
| `minNetInflowSol` | 1.5 | real net SOL must be flowing in (buys minus sells) |
| `maxTopBuyerShare` | 40% | one wallet dominating inflow ≈ bundler/whale bait |
| dev hasn't sold | — | a creator selling during the watch window is disqualifying |

**Exit — first trigger wins.**

| Rule | Default |
|---|---|
| Creator sells anything | exit immediately |
| Stop-loss | −25% |
| Take-profit | +60% |
| Trailing stop | 25% off peak, armed after +40% |
| Max hold | 5 minutes |

**Risk limits (checked before every entry).**

| Limit | Default |
|---|---|
| Position size | 0.03 SOL (~$2.25 at SOL=$75) |
| Max concurrent positions | 2 |
| Daily realized-loss limit | 0.15 SOL — bot stops entering for the day |
| Daily spend cap | 0.5 SOL |

Everything above lives in `config.json`. Copy it to `config.local.json`
(gitignored) and run with `--config config.local.json` if you want private
tweaks.

## Live mode

Only after paper results convince you. Live mode needs:

1. The optional deps (installed automatically by `npm install`):
   `@solana/web3.js`, `bs58`.
2. A funded Solana wallet. **Use a fresh burner wallet holding only what you're
   prepared to lose** — never your main wallet.
3. The wallet's base58 secret key in an environment variable (never in a file,
   never committed):

```bash
export PUMPBOT_PRIVATE_KEY="your-base58-secret-key"
npm run live
```

How a live order flows: the bot POSTs the trade intent to
`pumpportal.fun/api/trade-local`, receives an *unsigned* transaction, signs it
locally with your key, and submits it to the RPC in `live.rpcUrl`. Your key is
read from the environment and never sent anywhere.

Live-mode caveats:

- The public mainnet RPC in the default config is rate-limited and slow; a free
  Helius/QuickNode endpoint will land your transactions materially faster.
- Fills are estimated from curve state at send time (exact accounting would
  require parsing confirmed transactions); treat live P&L in the log as an
  approximation and your wallet balance as the truth.
- PumpPortal charges 0.5% per trade on top of pump.fun's 1%.

## Architecture

```
src/
  index.js          engine: wires feed → trackers → executor → portfolio
  feed.js           PumpPortal WebSocket client (auto-reconnect, per-mint subs)
  strategy.js       TokenTracker state machine: WATCHING → HOLDING → DONE
  curve.js          bonding-curve math (constant product on virtual reserves)
  portfolio.js      bankroll accounting + risk gate
  executors/
    paper.js        simulated fills w/ pessimistic fee+slippage model
    live.js         PumpPortal trade-local + local signing (lazy-loaded deps)
  logger.js         console + JSONL trade log
test/               node:test suites for curve math and strategy logic
```

## Tuning ideas once you have paper data

- Tighten `minNetInflowSol` / `minUniqueBuyers` and compare hit rate vs. number
  of trades — the JSONL log has everything needed to backtest filter variants.
- Lower `maxHoldSec`: most pump.fun tokens are dead within 2–3 minutes.
- If every exit is `timeout` or `stop-loss`, the honest conclusion is the one
  the research predicted — stop before going live.
