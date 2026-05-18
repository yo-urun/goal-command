/**
 * Budget tracking — turn, token, and wall-clock budget management.
 *
 * Implements the triple-budget system from Codex + Claude-Goal:
 * - Turn budget: max number of continuation turns
 * - Token budget: optional max token usage (0 = unlimited)
 * - Wall-clock budget: optional max active time in seconds (0 = unlimited)
 *
 * Wall-clock time only accumulates during ACTIVE state (pauses stop the clock).
 *
 * @module budget
 */

/**
 * Budget tracker for a goal run.
 * Tracks turn usage, token usage, and wall-clock time.
 */
export class BudgetTracker {
  /**
   * @param {Object} opts
   * @param {number} [opts.maxTurns=20] - Maximum turns allowed
   * @param {number} [opts.tokenBudget=0] - Token budget (0 = unlimited)
   * @param {number} [opts.timeBudget=0] - Wall-clock budget in seconds (0 = unlimited)
   * @param {number} [opts.turnsUsed=0] - Initial turns used (for resume)
   * @param {number} [opts.tokensUsed=0] - Initial tokens used (for resume)
   * @param {number} [opts.timeUsedSeconds=0] - Initial time used in seconds (for resume)
   * @param {string|null} [opts.activeStartedAt=null] - ISO timestamp when active time started
   */
  constructor(opts = {}) {
    this.maxTurns = opts.maxTurns ?? 20;
    this.tokenBudget = opts.tokenBudget ?? 0;
    this.timeBudget = opts.timeBudget ?? 0;

    this.turnsUsed = opts.turnsUsed ?? 0;
    this.tokensUsed = opts.tokensUsed ?? 0;
    this.timeUsedSeconds = opts.timeUsedSeconds ?? 0;

    // Wall-clock tracking
    this.activeStartedAt = opts.activeStartedAt || null;
  }

  /**
   * Increment the turn counter by 1.
   * @returns {number} New turns used count
   */
  incrementTurn() {
    this.turnsUsed += 1;
    return this.turnsUsed;
  }

  /**
   * Add token usage.
   * @param {number} n - Number of tokens to add
   * @returns {number} New tokens used count
   */
  addTokens(n) {
    this.tokensUsed += n;
    return this.tokensUsed;
  }

  /**
   * Record the start of active time (when goal becomes ACTIVE or resumes).
   * If already tracking, this is a no-op.
   * @param {string} [timestamp] - ISO timestamp; defaults to now
   */
  startActiveClock(timestamp) {
    if (this.activeStartedAt) return; // already running
    this.activeStartedAt = timestamp || new Date().toISOString();
  }

  /**
   * Accumulate wall-clock time since last startActiveClock() and stop the clock.
   * Called when goal is paused or state changes away from ACTIVE.
   * @returns {number} Total time used in seconds after accumulation
   */
  stopActiveClock() {
    if (!this.activeStartedAt) return this.timeUsedSeconds;
    const start = new Date(this.activeStartedAt).getTime();
    const elapsed = Math.max(0, (Date.now() - start) / 1000);
    this.timeUsedSeconds += elapsed;
    this.activeStartedAt = null;
    return this.timeUsedSeconds;
  }

  /**
   * Tick the wall-clock — accumulate any elapsed active time.
   * Useful for periodic checks without stopping the clock.
   * @returns {number} Total time used in seconds (including current active period)
   */
  tickWallClock() {
    if (!this.activeStartedAt) return this.timeUsedSeconds;
    const start = new Date(this.activeStartedAt).getTime();
    const elapsed = Math.max(0, (Date.now() - start) / 1000);
    return this.timeUsedSeconds + elapsed;
  }

  /**
   * Check if any budget is exhausted.
   * @returns {boolean} `true` if the budget is exhausted
   */
  isExhausted() {
    if (this.maxTurns > 0 && this.turnsUsed >= this.maxTurns) return true;
    if (this.tokenBudget > 0 && this.tokensUsed >= this.tokenBudget) return true;
    const totalTime = this.tickWallClock();
    if (this.timeBudget > 0 && totalTime >= this.timeBudget) return true;
    return false;
  }

  /**
   * Check if token usage is at 80%+ (soft limit warning).
   * @returns {boolean}
   */
  isTokenWarning() {
    if (this.tokenBudget <= 0) return false;
    return this.tokensUsed >= this.tokenBudget * 0.8;
  }

  /**
   * Extend the turn budget by adding more turns.
   * @param {number} extra - Additional turns to add
   */
  extendTurns(extra) {
    this.maxTurns += extra;
  }

  /**
   * Extend the token budget by adding more tokens.
   * @param {number} extra - Additional tokens to add
   */
  extendTokens(extra) {
    this.tokenBudget += extra;
  }

  /**
   * Extend the time budget by adding more seconds.
   * @param {number} extraSeconds - Additional seconds to add
   */
  extendTime(extraSeconds) {
    this.timeBudget += extraSeconds;
  }

  /**
   * Get a human-readable budget display string.
   * @returns {string} e.g. "3/20 turns | 15.2K/100K tokens (15%) | 2m/60m time (3%)"
   */
  getDisplay() {
    const parts = [];

    // Turns
    parts.push(`${this.turnsUsed}/${this.maxTurns} turns`);

    // Tokens
    if (this.tokenBudget > 0) {
      const pct = Math.round((this.tokensUsed / this.tokenBudget) * 100);
      parts.push(`${fmtTokens(this.tokensUsed)}/${fmtTokens(this.tokenBudget)} tokens (${pct}%)`);
    } else {
      parts.push(`${fmtTokens(this.tokensUsed)} tokens`);
    }

    // Wall-clock
    const totalTime = this.tickWallClock();
    if (this.timeBudget > 0) {
      const pct = Math.round((totalTime / this.timeBudget) * 100);
      parts.push(`${fmtSeconds(totalTime)}/${fmtSeconds(this.timeBudget)} time (${pct}%)`);
    } else if (totalTime > 0) {
      parts.push(`${fmtSeconds(totalTime)} time`);
    }

    return parts.join(' | ');
  }

  /**
   * Serialize budget state for status.md persistence.
   * @returns {Object}
   */
  toStatusFields() {
    return {
      turns_used: this.turnsUsed,
      max_turns: this.maxTurns,
      tokens_used: this.tokensUsed,
      token_budget: this.tokenBudget,
      time_used_seconds: Math.round(this.tickWallClock()),
      max_time_seconds: this.timeBudget,
      active_started_at: this.activeStartedAt,
    };
  }

  /**
   * Create a BudgetTracker from status.md fields.
   * @param {Object} fields - Parsed status.md budget fields
   * @returns {BudgetTracker}
   */
  static fromStatusFields(fields) {
    return new BudgetTracker({
      maxTurns: fields.max_turns ?? 20,
      tokenBudget: fields.token_budget ?? 0,
      timeBudget: fields.max_time_seconds ?? 0,
      turnsUsed: fields.turns_used ?? 0,
      tokensUsed: fields.tokens_used ?? 0,
      timeUsedSeconds: fields.time_used_seconds ?? 0,
      activeStartedAt: fields.active_started_at ?? null,
    });
  }
}

/**
 * Format token count as human-readable (e.g. 15200 → "15.2K").
 * @param {number} n
 * @returns {string}
 */
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Format seconds as human-readable duration (e.g. 120 → "2m", 3700 → "1h1m").
 * @param {number} seconds
 * @returns {string}
 */
function fmtSeconds(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remainder = s % 60;
  if (m < 60) return remainder > 0 ? `${m}m${remainder}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m`;
}