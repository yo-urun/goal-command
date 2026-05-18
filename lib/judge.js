/**
 * Judge system — calls an LLM to evaluate whether a goal is done.
 *
 * Implements:
 * - Judge prompt construction (with and without subgoals)
 * - LLM API call (stub for now — TODO: wire to actual LLM)
 * - Response parsing with fail-open logic
 * - Parse failure guard (3 consecutive failures → auto-pause)
 *
 * @module judge
 */

import { JUDGE_SYSTEM_PROMPT, renderJudgeUserPrompt } from './prompts.js';

/**
 * Default judge configuration values.
 * @type {Object}
 */
const DEFAULTS = {
  judgeModel: null,          // null = use session model
  judgeTimeout: 30,          // seconds
  judgeMaxTokens: 4096,
  maxConsecutiveParseFailures: 3,
};

/**
 * Try to parse the judge's JSON response.
 * Handles common LLM output issues: markdown code fences, extra text, etc.
 *
 * @param {string} raw - Raw LLM response text
 * @returns {{ done: boolean, reason: string, parse_failed: boolean }}
 */
export function parseJudgeResponse(raw) {
  if (!raw || !raw.trim()) {
    return { done: false, reason: 'Empty judge response', parse_failed: true };
  }

  let text = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Try to find a JSON object in the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { done: false, reason: 'No JSON object found in judge response', parse_failed: true };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.done === 'boolean' && typeof parsed.reason === 'string') {
      return { done: parsed.done, reason: parsed.reason, parse_failed: false };
    }
    // Has JSON but wrong shape
    return { done: false, reason: `Judge JSON missing 'done' or 'reason': ${jsonMatch[0].slice(0, 100)}`, parse_failed: true };
  } catch (e) {
    return { done: false, reason: `Judge JSON parse error: ${e.message}`, parse_failed: true };
  }
}

/**
 * Call the judge model to evaluate whether the goal is done.
 *
 * Current implementation: STUB — returns "continue" so the architecture works.
 * The actual LLM call needs to be wired to OpenClaw's API.
 *
 * Fail-open logic:
 * - API error / timeout → continue (judge broken ≠ progress stuck)
 * - Empty response → continue with parse_failed: true
 * - Non-JSON response → continue with parse_failed: true
 * - Valid JSON → use verdict
 *
 * @param {string} goal - The goal text
 * @param {string} lastResponse - The agent's most recent response
 * @param {string[]} [subgoals=[]] - Optional subgoals list
 * @param {Object} config - Plugin config (judgeModel, judgeTimeout, etc.)
 * @returns {Promise<{ verdict: 'done'|'continue', reason: string, parse_failed: boolean }>}
 */
export async function callJudge(goal, lastResponse, subgoals = [], config = {}) {
  const cfg = { ...DEFAULTS, ...config };

  // Empty goal → skip judge
  if (!goal || !goal.trim()) {
    return { verdict: 'skipped', reason: 'empty goal', parse_failed: false };
  }

  // Empty response → definitely not done yet
  if (!lastResponse || !lastResponse.trim()) {
    return { verdict: 'continue', reason: 'empty response (nothing to evaluate)', parse_failed: false };
  }

  // Build the judge prompt
  const userPrompt = renderJudgeUserPrompt(goal, lastResponse, subgoals);

  // Call the judge via the host LLM runtime.
  // Two paths:
  // 1. api.runtime.llm.complete is available (preferred — no direct network access)
  // 2. Fallback: return 'continue' and log a warning (plugin not yet in a runtime context)
  //
  // Fail-open: any error → continue (judge broken ≠ progress stuck)

  const llm = cfg._llmRuntime; // injected by the plugin host during registration
  if (!llm) {
    // No LLM runtime available (e.g. in unit tests or before plugin init)
    return {
      verdict: 'continue',
      reason: 'judge: LLM runtime not available (will evaluate once plugin is loaded)',
      parse_failed: false,
    };
  }

  try {
    const result = await llm.complete({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      purpose: 'goal-command.judge',
      maxTokens: cfg.judgeMaxTokens || 4096,
      temperature: 0,
      ...(cfg.judgeModel ? { model: cfg.judgeModel } : {}),
    });

    const raw = result.text || result.content || '';
    const parsed = parseJudgeResponse(raw);

    if (parsed.parse_failed) {
      return { verdict: 'continue', reason: parsed.reason, parse_failed: true };
    }

    return {
      verdict: parsed.done ? 'done' : 'continue',
      reason: parsed.reason,
      parse_failed: false,
    };
  } catch (err) {
    // LLM call failed → fail-open, continue
    return { verdict: 'continue', reason: `judge error: ${err.message}`, parse_failed: false };
  }
}

/**
 * Check if consecutive parse failures exceed the threshold and should trigger auto-pause.
 *
 * @param {number} consecutiveFailures - Current count of consecutive parse failures
 * @param {number} [maxFailures=3] - Threshold for auto-pause (default: 3)
 * @returns {boolean} `true` if the goal should be auto-paused
 */
export function shouldAutoPause(consecutiveFailures, maxFailures = 3) {
  return consecutiveFailures >= maxFailures;
}