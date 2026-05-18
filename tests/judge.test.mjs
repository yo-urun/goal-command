/**
 * Tests for lib/judge.js — judge response parsing.
 * Run: node tests/judge.test.mjs
 */

import assert from 'node:assert/strict';
import { parseJudgeResponse, shouldAutoPause } from '../lib/judge.js';

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

console.log('judge.js tests\n');

// ── parseJudgeResponse ────────────────────────────────────────────

test('valid JSON response → parsed correctly', () => {
  const result = parseJudgeResponse('{"done": false, "reason": "2 errors remain"}');
  assert.deepEqual(result, { done: false, reason: '2 errors remain', parse_failed: false });
});

test('valid done response → parsed correctly', () => {
  const result = parseJudgeResponse('{"done": true, "reason": "All tests pass"}');
  assert.deepEqual(result, { done: true, reason: 'All tests pass', parse_failed: false });
});

test('JSON in code fence → parsed correctly', () => {
  const raw = '```json\n{"done": false, "reason": "not yet"}\n```';
  const result = parseJudgeResponse(raw);
  assert.deepEqual(result, { done: false, reason: 'not yet', parse_failed: false });
});

test('JSON with extra text → parsed from middle', () => {
  const raw = 'Here is my evaluation:\n{"done": true, "reason": "goal achieved"}\nThank you.';
  const result = parseJudgeResponse(raw);
  assert.deepEqual(result, { done: true, reason: 'goal achieved', parse_failed: false });
});

test('empty response → parse_failed', () => {
  const result = parseJudgeResponse('');
  assert.equal(result.parse_failed, true);
  assert.equal(result.done, false);
});

test('null/whitespace response → parse_failed', () => {
  const result = parseJudgeResponse('   \n  ');
  assert.equal(result.parse_failed, true);
});

test('non-JSON text → parse_failed', () => {
  const result = parseJudgeResponse('The goal is not done yet because 2 tests are failing.');
  assert.equal(result.parse_failed, true);
});

test('JSON with wrong shape → parse_failed', () => {
  const result = parseJudgeResponse('{"status": "in_progress", "msg": "not done"}');
  assert.equal(result.parse_failed, true);
});

test('JSON with done as string → parse_failed', () => {
  const result = parseJudgeResponse('{"done": "yes", "reason": "done"}');
  assert.equal(result.parse_failed, true);
});

test('code fence without json label → parsed correctly', () => {
  const raw = '```\n{"done": true, "reason": "complete"}\n```';
  const result = parseJudgeResponse(raw);
  assert.deepEqual(result, { done: true, reason: 'complete', parse_failed: false });
});

// ── shouldAutoPause ───────────────────────────────────────────────

test('shouldAutoPause: 0 failures → no pause', () => {
  assert.ok(!shouldAutoPause(0, 3));
});

test('shouldAutoPause: 2 failures → no pause', () => {
  assert.ok(!shouldAutoPause(2, 3));
});

test('shouldAutoPause: 3 failures → pause', () => {
  assert.ok(shouldAutoPause(3, 3));
});

test('shouldAutoPause: 5 failures → pause', () => {
  assert.ok(shouldAutoPause(5, 3));
});

test('shouldAutoPause: custom threshold', () => {
  assert.ok(!shouldAutoPause(4, 5));
  assert.ok(shouldAutoPause(5, 5));
});

// ── Summary ───────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);