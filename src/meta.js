// Meta (narrative-wave) detector. Pump.fun runs on themes: when a narrative
// hits, dozens of same-keyword tokens launch within minutes. Early tokens in a
// *fresh* wave are the ones with a crowd behind them, so the strategy relaxes
// its entry filters for tokens matching a currently-hot keyword.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'coin', 'token', 'sol', 'solana', 'pump',
  'fun', 'meme', 'official', 'new', 'first', 'baby', 'mini', 'big',
]);

export class MetaDetector {
  constructor({ windowMin = 30, hotCount = 4 } = {}) {
    this.windowMs = windowMin * 60_000;
    this.hotCount = hotCount;
    this.seen = []; // { at, words:Set }
  }

  static words(name = '', symbol = '') {
    const text = `${name} ${symbol}`.toLowerCase();
    return new Set(
      (text.match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !STOPWORDS.has(word) && !/^\d+$/.test(word)),
    );
  }

  prune(now) {
    const cutoff = now - this.windowMs;
    while (this.seen.length > 0 && this.seen[0].at < cutoff) this.seen.shift();
  }

  /**
   * Record a launch and report whether it belongs to a hot wave.
   * Hotness counts PRIOR launches only, so the wave must already exist —
   * the very tokens that start a wave don't get the relaxed filters.
   */
  onLaunch(name, symbol, now = Date.now()) {
    this.prune(now);
    const words = MetaDetector.words(name, symbol);
    const counts = new Map();
    for (const entry of this.seen) {
      for (const w of entry.words) if (words.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    this.seen.push({ at: now, words });
    let hotWord = null;
    for (const [w, c] of counts) if (c + 1 >= this.hotCount) { hotWord = w; break; }
    return { hot: hotWord !== null, word: hotWord };
  }
}
