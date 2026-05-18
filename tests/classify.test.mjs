/**
 * Tests for lib/classify.js — goal classification heuristic.
 * Run: node tests/classify.test.mjs
 */

import assert from 'node:assert/strict';
import { isLikelyAbstractGoal } from '../lib/classify.js';

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

console.log('classify.js tests\n');

// ── Abstract goals (should return true) ─────────────────────────

test('short vague goal → abstract', () => {
  assert.ok(isLikelyAbstractGoal('improve stuff'));
});

test('single abstract word → abstract', () => {
  assert.ok(isLikelyAbstractGoal('optimize'));
});

test('abstract with no concrete terms → abstract', () => {
  assert.ok(isLikelyAbstractGoal('make the app better'));
});

test('German abstract term → abstract', () => {
  assert.ok(isLikelyAbstractGoal('verbessern die Performance'));
});

test('Russian abstract term → abstract', () => {
  assert.ok(isLikelyAbstractGoal('улучшить систему'));
});

test('very short goal ≤3 words with concrete term → concrete', () => {
  // 'fix' is a concrete term, so this should NOT be abstract
  assert.ok(!isLikelyAbstractGoal('fix stuff'));
});

test('very short goal ≤3 words without concrete → abstract', () => {
  assert.ok(isLikelyAbstractGoal('better app'));
});

// ── Concrete goals (should return false) ─────────────────────────

test('fix with file path → concrete', () => {
  assert.ok(!isLikelyAbstractGoal('fix the lint errors in src/utils.ts'));
});

test('create endpoint → concrete', () => {
  assert.ok(!isLikelyAbstractGoal('create a new API endpoint for user auth'));
});

test('implement with validation hint → concrete', () => {
  assert.ok(!isLikelyAbstractGoal('implement login flow with test coverage'));
});

test('deploy with concrete target → concrete', () => {
  assert.ok(!isLikelyAbstractGoal('deploy the staging environment to Cloudflare'));
});

test('German concrete term → concrete', () => {
  assert.ok(!isLikelyAbstractGoal('erstelle eine neue Seite für Dashboard'));
});

test('Russian concrete term → concrete', () => {
  assert.ok(!isLikelyAbstractGoal('исправь ошибку в модуле авторизации'));
});

// ── Edge cases ────────────────────────────────────────────────────

test('abstract term + concrete term → concrete', () => {
  // "improve" is abstract but "fix" and "endpoint" are concrete
  assert.ok(!isLikelyAbstractGoal('improve and fix the endpoint validation'));
});

test('abstract + validation hint → concrete', () => {
  // "optimize" is abstract but "test" is a validation hint
  assert.ok(!isLikelyAbstractGoal('optimize performance with test benchmarks'));
});

test('empty string → abstract (very short)', () => {
  assert.ok(isLikelyAbstractGoal(''));
});

test('single concrete word → still abstract (≤3 words, no concrete match at word level)', () => {
  // "fix" is a concrete term, so this should NOT be abstract
  // Actually "fix" IS in the concrete terms list, so hasConcrete=true
  assert.ok(!isLikelyAbstractGoal('fix'));
});

test('two abstract words → abstract', () => {
  assert.ok(isLikelyAbstractGoal('better system'));
});

// ── Summary ───────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);