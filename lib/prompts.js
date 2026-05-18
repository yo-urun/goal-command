/**
 * Prompt templates — judge system prompt, judge user prompt,
 * continuation prompt, and spec-coach prompt.
 *
 * All templates support optional subgoals and completion audit instructions.
 * @module prompts
 */

// ── Judge Prompts ────────────────────────────────────────────────

/**
 * Judge system prompt (from Hermes, adapted).
 * Instructs the LLM to evaluate whether a goal is done.
 * @type {string}
 */
export const JUDGE_SYSTEM_PROMPT = `You are a strict judge evaluating whether an autonomous agent has achieved a user's stated goal. You receive the goal text, any additional criteria (subgoals), and the agent's most recent response. Your only job is to decide whether the goal is fully satisfied.

A goal is DONE only when:
- The response explicitly confirms the goal was completed, OR
- The response clearly shows the final deliverable was produced, OR
- The response explains the goal is unachievable/blocked/needs user input (treat as DONE with reason describing the block).

Otherwise the goal is NOT done — CONTINUE.

When subgoals exist, ALL must be satisfied for DONE.

Reply ONLY with a single JSON object on one line:
{"done": <true|false>, "reason": "<one-sentence rationale>"}`;

/**
 * Render the judge user prompt (with or without subgoals).
 *
 * @param {string} goal - The goal text
 * @param {string} lastResponse - Agent's most recent response
 * @param {string[]} [subgoals=[]] - Optional subgoals
 * @returns {string}
 */
export function renderJudgeUserPrompt(goal, lastResponse, subgoals = []) {
  const subgoalsBlock = subgoals.length > 0
    ? renderSubgoalsBlockForJudge(subgoals)
    : '(No additional criteria)';

  return `Goal:
${goal}

Additional criteria (all must also be satisfied for DONE):
${subgoalsBlock}

Agent's most recent response:
${lastResponse}

Current time: ${new Date().toISOString()}

Is the goal satisfied?`;
}

/**
 * Render the subgoals block for the judge prompt.
 * When subgoals exist, includes strict evidence requirements.
 *
 * @param {string[]} subgoals
 * @returns {string}
 */
function renderSubgoalsBlockForJudge(subgoals) {
  const items = subgoals.map((s, i) => `- ${i + 1}. ${s}`).join('\n');
  return `${items}

Decision: For each criterion, find concrete evidence in the agent's response. If ANY criterion lacks specific evidence, the goal is NOT done — return CONTINUE.`;
}

// ── Continuation Prompts ─────────────────────────────────────────

/**
 * Completion audit instructions — injected into EVERY continuation turn.
 * From Claude-Goal's approach: constant reminder to prevent premature DONE.
 * @type {string}
 */
const COMPLETION_AUDIT_BLOCK = `Before deciding the goal is achieved, perform a completion audit:
1. Restate the objective as concrete deliverables.
2. Map every requirement to concrete evidence (file paths, test results, command output).
3. Identify any missing, incomplete, or weakly verified requirements.
4. Treat uncertainty as not achieved — continue verification or work.`;

/**
 * Render the continuation prompt (with or without subgoals).
 *
 * @param {string} goal - The goal text
 * @param {string} [reason=''] - Judge's reason for continuing
 * @param {string[]} [subgoals=[]] - Optional subgoals
 * @param {Object} [budget={}] - Budget display info
 * @returns {string}
 */
export function renderContinuationPrompt(goal, reason = '', subgoals = [], budget = {}) {
  const subgoalsBlock = subgoals.length > 0
    ? renderSubgoalsBlockForContinuation(subgoals)
    : '';

  const budgetLine = budget.display
    ? `\nBudget: ${budget.display}`
    : '';

  const reasonLine = reason
    ? `\nJudge reason: ${reason}`
    : '';

  return `[Continuing toward your standing goal]
Goal: ${goal}${reasonLine}${budgetLine}${subgoalsBlock}

Continue working toward this goal. Take the next concrete step.
Avoid repeating work that is already done.
If you believe the goal is complete, state so explicitly and stop.
If you are blocked and need input from the user, say so clearly and stop.

${COMPLETION_AUDIT_BLOCK}`;
}

/**
 * Render the subgoals block for the continuation prompt.
 * @param {string[]} subgoals
 * @returns {string}
 */
function renderSubgoalsBlockForContinuation(subgoals) {
  const items = subgoals.map((s, i) => `- ${i + 1}. ${s}`).join('\n');
  return `\n\nSubgoals (all must be satisfied):\n${items}`;
}

// ── Spec-Coach Prompt ───────────────────────────────────────────

/**
 * Render the spec-coach prompt for abstract goals.
 *
 * @param {string} goal - The goal text
 * @param {string} runDir - Run directory path
 * @returns {string}
 */
export function renderSpecCoachPrompt(goal, runDir) {
  return `Spec-Coach Mode activated for an abstract /goal. Do not implement yet.

Raw goal: ${goal}
Run directory: ${runDir}

Protocol:
1. Read/update feature_spec.md and status.md.
2. Ask 3-5 strict blocking questions that turn the goal into a buildable spec.
3. Questions must cover: exact outcome, target project/surface, Definition of Done, constraints/out-of-scope, validation method.
4. Do not start coding, subagents, shell commands for implementation, or external actions.
5. Update status.md with state: SPEC_COACH and write the questions into feature_spec.md.
6. End by asking the user for the missing answers.

The goal is to prevent open-loop work by forcing a clear spec before execution.`;
}

// ── Goal Loop Prompt (Initial Injection) ────────────────────────

/**
 * Render the initial goal loop prompt for concrete goals.
 *
 * @param {string} goal - The goal text
 * @param {string} runDir - Run directory path
 * @returns {string}
 */
export function renderGoalLoopPrompt(goal, runDir) {
  return `Goal Mode activated. Treat this as a closed-loop objective, not a normal chat request.

CRITICAL EXECUTION CONTRACT:
- Do not answer with only a definition, explanation, checklist, or plan.
- Do not stop while status.md says ACTIVE.
- ACTIVE means: start executing now, using tools/subagents as needed.
- Your turn is incomplete until status.md is updated to exactly one terminal state: DONE, BLOCKED, or FAILED.
- If you need to ask the user a blocking question, mark status.md as BLOCKED first and write the blocker into validation.md.
- If validation fails after bounded debugging, mark status.md as FAILED and write the evidence.
- Only mark DONE after the Definition of Done is validated with concrete evidence.

Goal: ${goal}
Run directory: ${runDir}

Protocol:
1. Read the run files first: goal.md, status.md, feature_spec.md, plan.md, validation.md, decision_log.md.
2. Establish a Goal Contract and Definition of Done. If critical info is missing, ask the minimum blocking question and mark the run BLOCKED in status.md before replying.
3. For non-trivial work, create/update feature_spec.md and plan.md in the run directory before implementation.
4. Execute the work in the same turn whenever safely possible. Use tools/subagents instead of merely describing what should happen.
5. Validate with concrete evidence before DONE: test/build/lint/status/diff/screenshot/log inspection, or a named external blocker.
6. If validation fails, debug in a bounded loop. Do not restart from vague planning; record each failed attempt in decision_log.md.
7. Before DONE, sync project context (use /goal sync if available, otherwise update Obsidian markdown files directly).
8. Update status.md, validation.md, decision_log.md before final response.
9. Final response must include: terminal state, validation evidence, files changed, and remaining blockers if any.

${COMPLETION_AUDIT_BLOCK}

Forbidden final states:
- "I created the plan" while status is ACTIVE.
- "Ready to execute" without tool execution.
- "Let me know if you want me to continue" unless status is BLOCKED with the exact missing input.
- DONE without validation evidence.`;
}

// ── Resume Prompt ───────────────────────────────────────────────

/**
 * Render the resume prompt for a paused/budget-limited/blocked goal.
 *
 * @param {string} goal - The goal text
 * @param {string} runDir - Run directory path
 * @param {string} state - Current goal state
 * @param {Object} [budget={}] - Budget display info
 * @returns {string}
 */
export function renderResumePrompt(goal, runDir, state, budget = {}) {
  const budgetLine = budget.display ? `\nBudget: ${budget.display}` : '';

  if (state === 'SPEC_COACH') {
    return `Resume Spec-Coach Mode from run directory: ${runDir}\nRead status.md and feature_spec.md first. Continue asking/refining until the spec is buildable. Do not implement yet.`;
  }

  return `Resume Goal Mode from run directory: ${runDir}${budgetLine}
Read goal.md, status.md, feature_spec.md, plan.md, validation.md, and decision_log.md first.
If status is ACTIVE, execute now; do not answer with only a plan or definition.
Continue until status.md is DONE, BLOCKED, or FAILED.
Before DONE, validate with concrete evidence and sync the run to Obsidian OpenClaw/ project context.`;
}