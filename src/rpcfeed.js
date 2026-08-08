import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { decodeCurve } from './pumpcurve.js';

// FREE real-time price/inflow feed: subscribes to pump.fun bonding-curve
// accounts on a standard Solana RPC WebSocket (accountSubscribe) and decodes
// reserves locally. No PumpPortal metered key needed.
//
// What it gives you: vSol / vTok on every curve change -> price, net SOL
// inflow, and the graduation flag. What it does NOT give: per-trade buyer
// identity (no unique-buyer count, no whale share, no copy-trading). Those
// need transaction parsing or the paid trade stream.

export class RpcFeed extends EventEmitter {
  constructor(logger, wsUrl) {
    super();
    this.log = logger;
    this.wsUrl = wsUrl;
    this.ws = null;
    this.subs = new Map(); // bondingCurveKey -> mint
    this.subIdByReq = new Map(); // jsonrpc request id -> bondingCurveKey
    this.serverSubId = new Map(); // server subscription id -> bondingCurveKey
    this.pendingUnsub = new Map(); // bondingCurveKey -> true (unsub requested before id known)
    this.nextId = 1;
    this.backoffMs = 1000;
    this.stopped = false;
  }

  connect() {
    this.stopped = false;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.backoffMs = 1000;
      this.log.info(`rpc feed connected (${this.wsUrl.replace(/\?.*/, '')})`);
      for (const key of this.subs.keys()) this.sendSubscribe(key);
      this.emit('open');
    });

    this.ws.on('message', (raw) => this.onMessage(raw));
    this.ws.on('close', () => {
      if (this.stopped) return;
      this.serverSubId.clear();
      this.subIdByReq.clear();
      this.log.warn(`rpc feed closed, reconnecting in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
    this.ws.on('error', (err) => this.log.error(`rpc feed error: ${err.message}`));
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Subscription confirmation: { id, result: <serverSubId> }
    if (msg.id != null && typeof msg.result === 'number') {
      const key = this.subIdByReq.get(msg.id);
      this.subIdByReq.delete(msg.id);
      if (!key) return;
      if (this.pendingUnsub.delete(key)) { this.sendUnsubscribe(msg.result); return; }
      this.serverSubId.set(msg.result, key);
      return;
    }

    // Account notification
    if (msg.method === 'accountNotification') {
      const subId = msg.params?.subscription;
      const key = this.serverSubId.get(subId);
      const b64 = msg.params?.result?.value?.data?.[0];
      if (!key || !b64) return;
      const mint = this.subs.get(key);
      if (!mint) return;
      try {
        const c = decodeCurve(Buffer.from(b64, 'base64'));
        this.emit('reserve', { mint, bondingCurveKey: key, vSol: c.vSol, vTok: c.vTok, complete: c.complete });
      } catch { /* not a curve account / partial write */ }
    }
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendSubscribe(key) {
    const id = this.nextId++;
    this.subIdByReq.set(id, key);
    this.send({ jsonrpc: '2.0', id, method: 'accountSubscribe', params: [key, { encoding: 'base64', commitment: 'processed' }] });
  }

  sendUnsubscribe(serverSubId) {
    this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'accountUnsubscribe', params: [serverSubId] });
  }

  watchCurve(mint, bondingCurveKey) {
    if (!bondingCurveKey || this.subs.has(bondingCurveKey)) return;
    this.subs.set(bondingCurveKey, mint);
    this.sendSubscribe(bondingCurveKey);
  }

  unwatchCurve(bondingCurveKey) {
    if (!this.subs.delete(bondingCurveKey)) return;
    let serverId = null;
    for (const [sid, key] of this.serverSubId) if (key === bondingCurveKey) { serverId = sid; break; }
    if (serverId != null) { this.serverSubId.delete(serverId); this.sendUnsubscribe(serverId); }
    else this.pendingUnsub.set(bondingCurveKey, true); // id not back yet; unsub on confirm
  }

  get watchCount() { return this.subs.size; }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}
