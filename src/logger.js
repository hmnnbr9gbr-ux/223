import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = 'logs';

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export class Logger {
  constructor({ tradeLogFile = null } = {}) {
    this.tradeLogFile = tradeLogFile;
    if (tradeLogFile) fs.mkdirSync(path.dirname(tradeLogFile), { recursive: true });
  }

  static forSession() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return new Logger({ tradeLogFile: path.join(LOG_DIR, `trades-${stamp}.jsonl`) });
  }

  info(msg) { console.log(`${ts()} | ${msg}`); }
  warn(msg) { console.warn(`${ts()} | WARN | ${msg}`); }
  error(msg) { console.error(`${ts()} | ERROR | ${msg}`); }

  trade(event) {
    const record = { at: new Date().toISOString(), ...event };
    this.info(`TRADE | ${event.action} ${event.symbol ?? event.mint} | ${JSON.stringify(event)}`);
    if (this.tradeLogFile) fs.appendFileSync(this.tradeLogFile, JSON.stringify(record) + '\n');
  }
}
