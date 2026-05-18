/**
 * Tests for lib/budget.js — budget tracking.
 * Run: node tests/budget.test.mjs
 */

import assert from 'node:assert/strict';
import { BudgetTracker } from '../lib/budget.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

console.log('budget.js tests\n');

// ── Turn tracking ─────────────────────────────────────────────────

test('incrementTurn increments by 1', () => {
  const b = new BudgetTracker({ maxTurns: 20 });
  assert.equal(b.turnsUsed, 0);
  b.incrementTurn();
  assert.equal(b.turnsUsed, 1);
  b.incrementTurn();
  assert.equal(b.turnsUsed, 2);
});

test('isExhausted when turns hit max', () => {
  const b = new BudgetTracker({ maxTurns: 3, turnsUsed: 2 });
  assert.ok(!b.isExhausted());
  b.incrementTurn();
  assert.ok(b.isExhausted());
});

test('extendTurns adds more turns', () => {
  const b = new BudgetTracker({ maxTurns: 3, turnsUsed: 3 });
  assert.ok(b.isExhausted());
  b.extendTurns(5);
  assert.equal(b.maxTurns, 8);
  assert.ok(!b.isExhausted());
});

// ── Token tracking ────────────────────────────────────────────────

test('addTokens accumulates token usage', () => {
  const b = new BudgetTracker({ tokenBudget: 10000 });
  b.addTokens(500);
  assert.equal(b.tokensUsed, 500);
  b.addTokens(300);
  assert.equal(b.tokensUsed, 800);
});

test('isExhausted when tokens hit budget', () => {
  const b = new BudgetTracker({ tokenBudget: 1000, tokensUsed: 999 });
  assert.ok(!b.isExhausted());
  b.addTokens(1);
  assert.ok(b.isExhausted());
});

test('zero tokenBudget = unlimited (never exhausted by tokens)', () => {
  const b = new BudgetTracker({ tokenBudget: 0, tokensUsed: 999999 });
  assert.ok(!b.isExhausted()); // only tokens, not turns
});

test('extendTokens adds more token budget', () => {
  const b = new BudgetTracker({ tokenBudget: 1000, tokensUsed: 1000 });
  assert.ok(b.isExhausted());
  b.extendTokens(500);
  assert.equal(b.tokenBudget, 1500);
  assert.ok(!b.isExhausted());
});

test('isTokenWarning at 80%', () => {
  const b = new BudgetTracker({ tokenBudget: 1000, tokensUsed: 799 });
  assert.ok(!b.isTokenWarning());
  b.addTokens(1); // 800 = 80%
  assert.ok(b.isTokenWarning());
});

test('isTokenWarning with no budget → false', () => {
  const b = new BudgetTracker({ tokenBudget: 0, tokensUsed: 999999 });
  assert.ok(!b.isTokenWarning());
});

// ── Wall-clock tracking ───────────────────────────────────────────

test('startActiveClock sets activeStartedAt', () => {
  const b = new BudgetTracker();
  assert.equal(b.activeStartedAt, null);
  b.startActiveClock('2026-05-18T18:00:00Z');
  assert.equal(b.activeStartedAt, '2026-05-18T18:00:00Z');
});

test('startActiveClock is idempotent', () => {
  const b = new BudgetTracker();
  b.startActiveClock('2026-05-18T18:00:00Z');
  b.startActiveClock('2026-05-18T19:00:00Z'); // should be no-op
  assert.equal(b.activeStartedAt, '2026-05-18T18:00:00Z');
});

test('stopActiveClock accumulates time and clears activeStartedAt', () => {
  const b = new BudgetTracker();
  // Set a start time 60 seconds ago
  const past = new Date(Date.now() - 60_000).toISOString();
  b.startActiveClock(past);
  const elapsed = b.stopActiveClock();
  assert.ok(elapsed >= 59); // allow small timing variance
  assert.ok(elapsed <= 65);
  assert.equal(b.activeStartedAt, null);
  assert.equal(b.timeUsedSeconds, elapsed);
});

test('stopActiveClock without starting → no-op', () => {
  const b = new BudgetTracker({ timeUsedSeconds: 100 });
  const result = b.stopActiveClock();
  assert.equal(result, 100);
  assert.equal(b.timeUsedSeconds, 100);
});

test('tickWallClock returns total without stopping', () => {
  const b = new BudgetTracker({ timeUsedSeconds: 50 });
  const past = new Date(Date.now() - 30_000).toISOString();
  b.startActiveClock(past);
  const total = b.tickWallClock();
  assert.ok(total >= 79); // 50 + ~30
  assert.ok(total <= 85);
  // Clock should still be running
  assert.ok(b.activeStartedAt !== null);
});

test('isExhausted when time budget exceeded', () => {
  const b = new BudgetTracker({ timeBudget: 60, timeUsedSeconds: 59 });
  // Start a clock 2 seconds ago
  const past = new Date(Date.now() - 2_000).toISOString();
  b.startActiveClock(past);
  assert.ok(b.isExhausted());
});

test('zero timeBudget = unlimited (never exhausted by time)', () => {
  const b = new BudgetTracker({ timeBudget: 0, timeUsedSeconds: 99999 });
  const past = new Date(Date.now() - 60_000).toISOString();
  b.startActiveClock(past);
  assert.ok(!b.isExhausted()); // time not limited
});

// ── Display ───────────────────────────────────────────────────────

test('getDisplay with all budgets', () => {
  const b = new BudgetTracker({ maxTurns: 20, turnsUsed: 3, tokenBudget: 100000, tokensUsed: 15200, timeBudget: 3600, timeUsedSeconds: 120 });
  const display = b.getDisplay();
  assert.ok(display.includes('3/20 turns'));
  assert.ok(display.includes('tokens'));
  assert.ok(display.includes('time'));
});

test('getDisplay with unlimited budgets', () => {
  const b = new BudgetTracker({ maxTurns: 20, turnsUsed: 5, tokenBudget: 0, tokensUsed: 3000, timeBudget: 0 });
  const display = b.getDisplay();
  assert.ok(display.includes('5/20 turns'));
  assert.ok(display.includes('3.0K tokens'));
  // No time shown if no time used
});

// ── Serialization ──────────────────────────────────────────────────

test('toStatusFields and fromStatusFields round-trip', () => {
  const b = new BudgetTracker({ maxTurns: 20, turnsUsed: 5, tokenBudget: 50000, tokensUsed: 10000, timeBudget: 3600, timeUsedSeconds: 300 });
  const fields = b.toStatusFields();
  const b2 = BudgetTracker.fromStatusFields(fields);
  assert.equal(b2.maxTurns, 20);
  assert.equal(b2.turnsUsed, 5);
  assert.equal(b2.tokenBudget, 50000);
  assert.equal(b2.tokensUsed, 10000);
  assert.equal(b2.timeBudget, 3600);
  assert.equal(b2.timeUsedSeconds, 300);
});

// ── Summary ───────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);