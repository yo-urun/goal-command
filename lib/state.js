/**
 * State machine — manages goal run lifecycle, status.md read/write,
 * and run directory operations.
 *
 * 8 states: SPEC_COACH, ACTIVE, PAUSED, BUDGET_LIMITED, BLOCKED, DONE, FAILED, CLEARED
 *
 * @module state
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Valid goal states.
 * @type {string[]}
 */
export const GOAL_STATES = [
  'SPEC_COACH',
  'ACTIVE',
  'PAUSED',
  'BUDGET_LIMITED',
  'BLOCKED',
  'DONE',
  'FAILED',
  'CLEARED',
];

/**
 * Terminal states — once reached, the goal loop stops.
 * @type {Set<string>}
 */
export const TERMINAL_STATES = new Set(['DONE', 'FAILED', 'CLEARED']);

/**
 * Active-eligible states — wall-clock time accumulates only in these.
 * @type {Set<string>}
 */
export const ACTIVE_STATES = new Set(['SPEC_COACH', 'ACTIVE']);

/**
 * Generate a run ID from current timestamp and a slug.
 * @param {string} goal - Goal text to slugify
 * @returns {string} e.g. "2026-05-18-180500-fix-lint-errors"
 */
export function generateRunId(goal) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = slugify(goal);
  return `${stamp}-${slug}`;
}

/**
 * Slugify a string for use in filenames.
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
  return String(input || 'goal')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'goal';
}

/**
 * Get the base directory for goal runs within the workspace.
 * @param {string} workspaceDir - Agent workspace directory
 * @returns {string}
 */
export function getRunsBaseDir(workspaceDir) {
  return path.join(workspaceDir, 'goals', 'runs');
}

/**
 * Find the latest run directory (sorted by name = chronologically).
 * @param {string} baseDir - The goals/runs directory
 * @returns {Promise<string|null>} Path to latest run dir, or null
 */
export async function latestRunDir(baseDir) {
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const latest = dirs.at(-1);
    return latest ? path.join(baseDir, latest) : null;
  } catch {
    return null;
  }
}

/**
 * Read a file, returning empty string if not found.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * GoalRun — represents an active goal run and its state.
 */
export class GoalRun {
  /**
   * @param {Object} opts
   * @param {string} opts.runId - Run identifier
   * @param {string} opts.runDir - Absolute path to run directory
   * @param {string} opts.goal - Goal text
   * @param {string} opts.state - Current state (one of GOAL_STATES)
   * @param {string} opts.mode - "spec" or "execution"
   * @param {string} opts.project - Project name (default "TBD")
   * @param {string} opts.createdAt - ISO timestamp
   * @param {string} opts.channel - Channel identifier
   * @param {string} opts.sessionKey - Session key
   * @param {string[]} [opts.subgoals=[]] - Subgoals list
   * @param {Object} [opts.budgetFields={}] - Budget fields from status.md
   * @param {Object} [opts.judgeFields={}] - Judge fields from status.md
   */
  constructor(opts = {}) {
    this.runId = opts.runId || '';
    this.runDir = opts.runDir || '';
    this.goal = opts.goal || '';
    this.state = opts.state || 'ACTIVE';
    this.mode = opts.mode || 'execution';
    this.project = opts.project || 'TBD';
    this.createdAt = opts.createdAt || new Date().toISOString();
    this.updatedAt = opts.updatedAt || new Date().toISOString();
    this.pausedAt = opts.pausedAt || null;
    this.resumedAt = opts.resumedAt || null;
    this.channel = opts.channel || '';
    this.sessionKey = opts.sessionKey || '';

    this.subgoals = opts.subgoals || [];
    this.budgetFields = opts.budgetFields || {};
    this.judgeFields = opts.judgeFields || {};
  }

  /**
   * Check if this run is in a terminal state.
   * @returns {boolean}
   */
  isTerminal() {
    return TERMINAL_STATES.has(this.state);
  }

  /**
   * Check if this run is in an active (time-accumulating) state.
   * @returns {boolean}
   */
  isActive() {
    return ACTIVE_STATES.has(this.state);
  }

  /**
   * Transition to a new state.
   * @param {string} newState - Must be one of GOAL_STATES
   * @throws {Error} If the state is invalid
   */
  setState(newState) {
    if (!GOAL_STATES.includes(newState)) {
      throw new Error(`Invalid goal state: ${newState}. Must be one of: ${GOAL_STATES.join(', ')}`);
    }
    this.state = newState;
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Add a subgoal.
   * @param {string} text - Subgoal text
   */
  addSubgoal(text) {
    this.subgoals.push(text);
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Remove a subgoal by 1-based index.
   * @param {number} index - 1-based index
   * @returns {boolean} `true` if removed
   */
  removeSubgoal(index) {
    if (index < 1 || index > this.subgoals.length) return false;
    this.subgoals.splice(index - 1, 1);
    this.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Clear all subgoals.
   */
  clearSubgoals() {
    this.subgoals = [];
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Write status.md to the run directory.
   * @param {Object} [budgetFields={}] - Budget tracker fields
   * @param {Object} [judgeFields={}] - Judge evaluation fields
   */
  async writeStatus(budgetFields = {}, judgeFields = {}) {
    this.budgetFields = { ...this.budgetFields, ...budgetFields };
    this.judgeFields = { ...this.judgeFields, ...judgeFields };
    this.updatedAt = new Date().toISOString();

    const content = renderStatusMd(this);
    await writeFile(path.join(this.runDir, 'status.md'), content, 'utf8');
  }

  /**
   * Append an entry to decision_log.md.
   * @param {string} entry - Decision log entry text
   */
  async appendDecision(entry) {
    const logPath = path.join(this.runDir, 'decision_log.md');
    const timestamp = new Date().toISOString();
    const line = `- ${timestamp}: ${entry}\n`;
    await writeFile(logPath, line, { flag: 'a', encoding: 'utf8' });
  }

  /**
   * Write validation.md on goal completion.
   * @param {string} goalText - Goal text
   * @param {string} evidence - Evidence text
   * @param {boolean} [autoVerified=false] - Whether this was auto-verified by judge
   */
  async writeValidation(goalText, evidence, autoVerified = false) {
    const timestamp = new Date().toISOString();
    let content = `# Validation\n\n## Completion Audit — ${timestamp}\n\n### Objective\n${goalText}\n\n### Deliverables Checklist\n${evidence}\n\n### Result\n`;
    if (autoVerified) {
      content += '✓ Auto-verified by judge, no manual audit performed.\n';
    } else {
      content += '✓ All requirements verified with concrete evidence.\n';
    }
    await writeFile(path.join(this.runDir, 'validation.md'), content, 'utf8');
  }
}

/**
 * Create a new goal run with all required files.
 *
 * @param {string} workspaceDir - Agent workspace directory
 * @param {string} goal - Goal text
 * @param {string} mode - "spec" or "execution"
 * @param {Object} ctx - Command context (channel, sessionKey)
 * @param {Object} budgetOpts - Initial budget options
 * @returns {Promise<{ runId: string, runDir: string, state: string, goalRun: GoalRun }>}
 */
export async function createRun(workspaceDir, goal, mode, ctx, budgetOpts = {}) {
  const runId = generateRunId(goal);
  const runDir = path.join(getRunsBaseDir(workspaceDir), runId);
  const state = mode === 'spec' ? 'SPEC_COACH' : 'ACTIVE';
  const createdAt = new Date().toISOString();

  await mkdir(runDir, { recursive: true });

  const budgetSection = renderBudgetSection({
    turns_used: 0,
    max_turns: budgetOpts.maxTurns ?? 20,
    tokens_used: 0,
    token_budget: budgetOpts.tokenBudget ?? 0,
    time_used_seconds: 0,
    max_time_seconds: budgetOpts.timeBudget ?? 0,
    active_started_at: state === 'ACTIVE' ? createdAt : null,
  });

  const judgeSection = renderJudgeSection({
    last_verdict: 'none',
    last_reason: '',
    consecutive_parse_failures: 0,
  });

  const files = {
    'goal.md': `# Goal\n\n${goal}\n\n## Contract\n- End states allowed: DONE, BLOCKED, FAILED.\n- Do not report DONE until Definition of Done is validated with concrete evidence.\n- Do not stop after creating a plan. Continue with tool execution unless blocked.\n- If the goal is underspecified, ask only the minimum blocking questions and keep state BLOCKED.\n`,
    'status.md': `# Status\n\n- state: ${state}\n- mode: ${mode}\n- runId: ${runId}\n- project: TBD\n- createdAt: ${createdAt}\n- updatedAt: ${createdAt}\n- pausedAt: null\n- resumedAt: null\n- channel: ${ctx.channel || 'unknown'}\n- sessionKey: ${ctx.sessionKey || 'unknown'}\n\n${budgetSection}\n\n${judgeSection}\n\n## Subgoals\n\n(No subgoals defined)\n`,
    'decision_log.md': `# Decision Log\n\n- ${createdAt}: Goal command created this run.\n- ${createdAt}: Initial classification: ${mode === 'spec' ? 'abstract/needs spec-coach' : 'concrete/execution-ready'}.\n`,
    'validation.md': `# Validation\n\nPending. Goal is not DONE until this file contains concrete validation evidence.\n`,
    'feature_spec.md': mode === 'spec'
      ? `# Feature Spec\n\n## Raw Goal\n${goal}\n\n## Status\nSPEC_COACH — answer the blocking Spec-Coach questions before implementation.\n\n## Open Questions\nPending.\n`
      : `# Feature Spec\n\nPending. Create or refine this before implementation if the goal is non-trivial.\n`,
    'plan.md': `# Plan\n\nPending. Create this before execution if the goal is non-trivial.\n`,
  };

  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(path.join(runDir, name), content, 'utf8')
    )
  );

  const goalRun = new GoalRun({
    runId,
    runDir,
    goal,
    state,
    mode,
    channel: ctx.channel || '',
    sessionKey: ctx.sessionKey || '',
    createdAt,
  });

  return { runId, runDir, state, goalRun };
}

/**
 * Load a GoalRun from an existing run directory.
 *
 * @param {string} runDir - Absolute path to run directory
 * @returns {Promise<GoalRun>}
 */
export async function loadGoalRun(runDir) {
  const status = await readOptional(path.join(runDir, 'status.md'));
  const goal = await readOptional(path.join(runDir, 'goal.md'));

  const getField = (re) => {
    const m = status.match(re);
    return m?.[1]?.trim() || '';
  };

  const state = getField(/- state:\s*([^\n]+)/i) || 'UNKNOWN';
  const mode = getField(/- mode:\s*([^\n]+)/i) || 'execution';
  const runId = getField(/- runId:\s*([^\n]+)/i) || path.basename(runDir);
  const project = getField(/- project:\s*([^\n]+)/i) || 'TBD';
  const createdAt = getField(/- createdAt:\s*([^\n]+)/i) || '';
  const updatedAt = getField(/- updatedAt:\s*([^\n]+)/i) || '';
  const pausedAt = getField(/- pausedAt:\s*([^\n]+)/i) || null;
  const resumedAt = getField(/- resumedAt:\s*([^\n]+)/i) || null;
  const channel = getField(/- channel:\s*([^\n]+)/i) || '';
  const sessionKey = getField(/- sessionKey:\s*([^\n]+)/i) || '';

  // Parse budget fields
  const budgetFields = {
    turns_used: Number(getField(/- turns_used:\s*([^\n]+)/i)) || 0,
    max_turns: Number(getField(/- max_turns:\s*([^\n]+)/i)) || 20,
    tokens_used: Number(getField(/- tokens_used:\s*([^\n]+)/i)) || 0,
    token_budget: Number(getField(/- token_budget:\s*([^\n]+)/i)) || 0,
    time_used_seconds: Number(getField(/- time_used_seconds:\s*([^\n]+)/i)) || 0,
    max_time_seconds: Number(getField(/- max_time_seconds:\s*([^\n]+)/i)) || 0,
    active_started_at: getField(/- active_started_at:\s*([^\n]+)/i) || null,
  };

  // Parse judge fields
  const judgeFields = {
    last_verdict: getField(/- last_verdict:\s*([^\n]+)/i) || 'none',
    last_reason: getField(/- last_reason:\s*([^\n]+)/i) || '',
    consecutive_parse_failures: Number(getField(/- consecutive_parse_failures:\s*([^\n]+)/i)) || 0,
  };

  // Parse subgoals
  const subgoals = parseSubgoals(status);

  // Extract goal text (strip markdown heading)
  const goalText = goal.replace(/^#\s+Goal\s*\n*/i, '').split('\n')[0]?.trim() || '';

  return new GoalRun({
    runId,
    runDir,
    goal: goalText,
    state,
    mode,
    project,
    createdAt,
    updatedAt,
    pausedAt,
    resumedAt,
    channel,
    sessionKey,
    subgoals,
    budgetFields,
    judgeFields,
  });
}

/**
 * Parse subgoals from status.md content.
 * @param {string} statusMd - Content of status.md
 * @returns {string[]}
 */
export function parseSubgoals(statusMd) {
  const lines = statusMd.split('\n');
  const subgoals = [];
  let inSubgoals = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+Subgoals/i.test(trimmed)) {
      inSubgoals = true;
      continue;
    }
    if (inSubgoals) {
      if (/^##\s+/.test(trimmed)) break; // next section
      const match = trimmed.match(/^-\s+\d+\.\s+(.*)/);
      if (match) {
        subgoals.push(match[1].trim());
      }
    }
  }
  return subgoals;
}

// ── Rendering helpers ───────────────────────────────────────────

/**
 * Render the status.md content for a GoalRun.
 * @param {GoalRun} goalRun
 * @returns {string}
 */
function renderStatusMd(goalRun) {
  const budgetSection = renderBudgetSection(goalRun.budgetFields);
  const judgeSection = renderJudgeSection(goalRun.judgeFields);
  const subgoalsSection = renderSubgoalsSection(goalRun.subgoals);

  return `# Status

- state: ${goalRun.state}
- mode: ${goalRun.mode}
- runId: ${goalRun.runId}
- project: ${goalRun.project}
- createdAt: ${goalRun.createdAt}
- updatedAt: ${goalRun.updatedAt}
- pausedAt: ${goalRun.pausedAt || 'null'}
- resumedAt: ${goalRun.resumedAt || 'null'}
- channel: ${goalRun.channel || 'unknown'}
- sessionKey: ${goalRun.sessionKey || 'unknown'}

${budgetSection}

${judgeSection}

${subgoalsSection}
`;
}

/**
 * Render the budget section for status.md.
 * @param {Object} b - Budget fields
 * @returns {string}
 */
function renderBudgetSection(b) {
  return `## Budget

- turns_used: ${b.turns_used ?? 0}
- max_turns: ${b.max_turns ?? 20}
- tokens_used: ${b.tokens_used ?? 0}
- token_budget: ${b.token_budget ?? 0}
- time_used_seconds: ${b.time_used_seconds ?? 0}
- max_time_seconds: ${b.max_time_seconds ?? 0}
- active_started_at: ${b.active_started_at || 'null'}`;
}

/**
 * Render the judge section for status.md.
 * @param {Object} j - Judge fields
 * @returns {string}
 */
function renderJudgeSection(j) {
  return `## Judge

- last_verdict: ${j.last_verdict ?? 'none'}
- last_reason: ${j.last_reason ?? ''}
- consecutive_parse_failures: ${j.consecutive_parse_failures ?? 0}`;
}

/**
 * Render the subgoals section for status.md.
 * @param {string[]} subgoals
 * @returns {string}
 */
function renderSubgoalsSection(subgoals) {
  if (!subgoals || subgoals.length === 0) {
    return '## Subgoals\n\n(No subgoals defined)';
  }
  const items = subgoals.map((s, i) => `- ${i + 1}. ${s}`).join('\n');
  return `## Subgoals\n\n${items}`;
}