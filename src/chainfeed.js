import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { PUMP_PROGRAM, tradesFromLogs } from './pumpevents.js';

// FREE full trade feed with buyer identity: one logsSubscribe on the pump.fun
// program via any Solana RPC. Every bonding-curve trade on the platform flows
// through here — mint, side, size, buyer wallet, reserves — decoded locally
// from the program's own event logs. This is the same per-trade data the paid
// stream sells, read straight from the chain.

export class ChainFeed extends EventEmitter {
  constructor(logger, wsUrl) {
    super();
    this.log = logger;
    this.wsUrl = wsUrl;
    this.ws = null;
    this.backoffMs = 1000;
    this.stopped = false;
    this.eventCount = 0;
  }

  connect() {
    this.stopped = false;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.backoffMs = 1000;
      this.log.info(`chain feed connected (${this.wsUrl.replace(/\?.*/, '')}) — full pump.fun trade stream`);
      this.ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'processed' }],
      }));
      this.emit('open');
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const value = msg.params?.result?.value;
      if (!value || value.err) return; // not a notification, or failed tx
      for (const trade of tradesFromLogs(value.logs)) {
        this.eventCount++;
        this.emit('trade', trade);
      }
    });

    this.ws.on('close', () => {
      if (this.stopped) return;
      this.log.warn(`chain feed closed, reconnecting in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
    this.ws.on('error', (err) => this.log.error(`chain feed error: ${err.message}`));
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}
