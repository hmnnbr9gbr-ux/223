# Security notes

This document describes the threat model of pumpfun-bot, the protections in
place, and the residual risks you accept by running it. It was produced by a
security review of the full codebase (Aug 2026).

## Threat model

The bot touches three trust boundaries:

1. **Untrusted market data.** Everything arriving over the PumpPortal
   WebSocket and the Solana RPC log stream — token names, symbols, trade
   sizes, wallet addresses — is chosen by anonymous strangers, including the
   scammers the strategy tries to filter out.
2. **A third-party transaction builder.** In live mode, PumpPortal's
   `trade-local` API builds the transaction and this bot signs it. Whoever
   controls that response controls what you are asked to sign.
3. **Your wallet key.** Present only in live mode, only via the
   `PUMPBOT_PRIVATE_KEY` environment variable.

## Protections in place

### Key handling
- The secret key is read from the environment, never from a file and never
  written anywhere. It is used only to sign locally; it is never sent over
  the network.
- `.gitignore` excludes `.env`, `*.key`, `config.local.json`, `logs/`, and
  `data/` so private material and trading history can't be committed by
  accident. A history scan found no committed secrets.
- **Run live mode with a fresh burner wallet holding only what you are
  prepared to lose.** Nothing in this repo can protect a key you export into
  a compromised shell environment.

### Signing guard (`src/txguard.js`)
The bot never blind-signs what `trade-local` returns. Before signing, the
decoded transaction must pass all of:

- fee payer is our wallet;
- no address-table lookups (they would hide accounts from offline review);
- every top-level instruction targets an allowlisted program (System,
  ComputeBudget, SPL Token, Associated Token, pump.fun, PumpSwap AMM);
- System instructions are limited to `CreateAccount`/`Transfer` — `Assign`
  and friends are refused;
- SPL Token `Approve`/`ApproveChecked`/`SetAuthority` are refused;
- total lamports that can leave the wallet — System transfers and rent we
  fund, plus the `max_sol_cost` of any pump.fun `buy` instruction — is capped
  at the trade amount plus slippage, fees, and a small margin.

A transaction failing any check is dropped with a logged reason.

**Residual risk:** instructions *inside* the allowlisted programs other than
the parsed ones aren't deeply decoded (e.g. a PumpSwap AMM swap's own
parameters), so a malicious builder could still burn the capped per-trade
amount on a worthless fill. The guard's job is to make wallet *drains*
impossible, not to validate trade quality. Keep the burner wallet small.

### Log hygiene (`src/logger.js`)
Token names and symbols are attacker-chosen and get interpolated into console
output. The logger strips control characters (ANSI escapes, carriage returns,
C1 codes, line separators) so a hostile token name can't spoof log lines or
drive your terminal. JSONL trade logs are safe by construction
(`JSON.stringify` escapes control characters).

### Feed parsing
- `src/pumpevents.js` length-checks and discriminator-checks every decoded
  event; malformed payloads are skipped.
- Numeric fields from feeds are coerced with `Number(...)` and guarded
  (`!(x > 0)`), so `NaN`/garbage fails closed — filters don't pass, entries
  don't fire.
- Memory on the platform-wide firehose is bounded: tracked tokens capped by
  `watch.maxTrackedTokens`, wallet book pruned to fixed sizes, tape recorder
  only follows young tokens.

### StreamHub template (`creator-hub/`)
The renderer HTML-escapes every CONFIG value before it reaches `innerHTML`,
restricts link URLs to `https:`/`http:`/`mailto:`/`#` (no `javascript:`),
sanity-checks theme colors, and opens links with `rel="noopener"`. A config
pasted from an untrusted source renders as text, not code.

## Operational guidance

- Paper mode needs no key and is the default — prove the strategy there.
- For live mode: burner wallet, minimal balance, funded just-in-time.
- Prefer a private RPC (Helius/QuickNode) over the public endpoint; put the
  URL in `config.local.json` (gitignored) if it embeds an access token —
  the feeds already redact query strings when logging URLs.
- The PumpPortal data key rides in the WS URL query string (their API
  design); treat it as low-value and rotate it if leaked.
- Live P&L in the log is an estimate; your wallet balance is the truth.

## Reporting

If you find a vulnerability, open a GitHub issue without exploit details and
request a private channel, or contact the repository owner directly.
