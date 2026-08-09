import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = 'logs';

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Token names/symbols come from anonymous internet strangers and get
// interpolated into log lines. Strip control characters (ANSI escapes,
// carriage returns, C1 codes, line separators) so a malicious token name
// can't spoof log lines or drive the terminal.
function scrub(msg) {
  // eslint-disable-next-line no-control-regex
  return String(msg).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, '');
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

  info(msg) { console.log(`${ts()} | ${scrub(msg)}`); }
  warn(msg) { console.warn(`${ts()} | WARN | ${scrub(msg)}`); }
  error(msg) { console.error(`${ts()} | ERROR | ${scrub(msg)}`); }

  trade(event) {
    const record = { at: new Date().toISOString(), ...event };
    this.info(`TRADE | ${event.action} ${event.symbol ?? event.mint} | ${JSON.stringify(event)}`);
    if (this.tradeLogFile) fs.appendFileSync(this.tradeLogFile, JSON.stringify(record) + '\n');
  }
}
