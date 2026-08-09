import { buyTokensOut } from '../curve.js';
import { guardTransaction, normalizeWeb3Message } from '../txguard.js';

const TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';
const LAMPORTS = 1e9;
// Headroom on the outflow cap for pump fees, ATA rent, and tx fees.
const FEE_MARGIN_SOL = 0.01;

// Live execution via PumpPortal's local-transaction API: the API builds the
// transaction, we sign it locally with YOUR key (the key never leaves this
// process) and submit it to your own RPC.
//
// Requires: PUMPBOT_PRIVATE_KEY env var (base58 wallet secret key) and the
// optional deps installed (@solana/web3.js, bs58).

export class LiveExecutor {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    this.ready = false;
  }

  async init() {
    const secret = process.env.PUMPBOT_PRIVATE_KEY;
    if (!secret) throw new Error('live mode needs PUMPBOT_PRIVATE_KEY (base58 secret key) in the environment');
    const web3 = await import('@solana/web3.js');
    const bs58 = (await import('bs58')).default;
    this.web3 = web3;
    this.keypair = web3.Keypair.fromSecretKey(bs58.decode(secret));
    this.connection = new web3.Connection(this.cfg.live.rpcUrl, 'confirmed');
    const balance = await this.connection.getBalance(this.keypair.publicKey);
    this.log.info(`live wallet ${this.keypair.publicKey.toBase58()} | balance ${(balance / 1e9).toFixed(4)} SOL`);
    this.ready = true;
  }

  async trade(body, maxSpendSol) {
    const res = await fetch(TRADE_LOCAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`trade-local ${res.status}: ${await res.text()}`);
    const tx = this.web3.VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    // Never blind-sign what a remote service built: verify the transaction
    // only touches expected programs and can't spend more than this trade.
    const verdict = guardTransaction(normalizeWeb3Message(tx.message), {
      signer: this.keypair.publicKey.toBase58(),
      maxLamportsOut: (maxSpendSol + FEE_MARGIN_SOL) * LAMPORTS,
    });
    if (!verdict.ok) throw new Error(`REFUSED to sign trade-local transaction: ${verdict.reason}`);
    tx.sign([this.keypair]);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    return sig;
  }

  async buy(tracker, solAmount) {
    if (!this.ready) await this.init();
    const l = this.cfg.live;
    const f = this.cfg.fees;
    // Most SOL this trade may move: spend + slippage tolerance + fees + tip.
    const maxSpendSol = solAmount * (1 + (l.slippagePct + f.pumpFeePct + f.portalFeePct) / 100) + l.priorityFeeSol;
    const sig = await this.trade({
      publicKey: this.keypair.publicKey.toBase58(),
      action: 'buy',
      mint: tracker.mint,
      amount: solAmount,
      denominatedInSol: 'true',
      slippage: l.slippagePct,
      priorityFee: l.priorityFeeSol,
      pool: l.pool,
    }, maxSpendSol);
    // Approximate the fill from current curve state; exact accounting would
    // require parsing the confirmed transaction.
    const solAfterFees = solAmount * (1 - (f.pumpFeePct + f.portalFeePct) / 100);
    const tokens = buyTokensOut(tracker.vSol, tracker.vTok, solAfterFees);
    const costSol = solAmount + l.priorityFeeSol;
    this.log.info(`live BUY sent: https://solscan.io/tx/${sig}`);
    return { tokens, costSol, price: tokens > 0 ? solAfterFees / tokens : 0, sig };
  }

  async sell(tracker) {
    if (!this.ready) await this.init();
    const l = this.cfg.live;
    const sig = await this.trade({
      publicKey: this.keypair.publicKey.toBase58(),
      action: 'sell',
      mint: tracker.mint,
      amount: '100%',
      denominatedInSol: 'false',
      slippage: l.slippagePct,
      priorityFee: l.priorityFeeSol,
      pool: l.pool,
    }, l.priorityFeeSol); // a sell only spends the tip; proceeds flow in
    const p = tracker.position;
    const est = p ? p.tokens * tracker.currentPrice : 0;
    this.log.info(`live SELL sent: https://solscan.io/tx/${sig}`);
    return { proceedsSol: est, sig, estimated: true };
  }
}
