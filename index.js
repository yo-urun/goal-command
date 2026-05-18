/**
 * OpenClaw Goal Command Plugin — main entry point.
 *
 * Registers the /goal command and routes subcommands to lib/ modules.
 *
 * @module openclaw-goal-command
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { isLikelyAbstractGoal } from './lib/classify.js';
import { callJudge, shouldAutoPause } from './lib/judge.js';
import { BudgetTracker } from './lib/budget.js';
import {
  GOAL_STATES,
  createRun,
  loadGoalRun,
  latestRunDir,
  getRunsBaseDir,
  readOptional,
  GoalRun,
} from './lib/state.js';
import {
  renderGoalLoopPrompt,
  renderSpecCoachPrompt,
  renderContinuationPrompt,
  renderResumePrompt,
} from './lib/prompts.js';
import { syncRunToObsidian } from './lib/obsidian.js';

/**
 * Resolve the agent workspace directory from the API and config.
 * @param {Object} api - OpenClaw plugin API
 * @param {Object} cfg - Plugin config
 * @returns {string}
 */
function workspaceDir(api, cfg) {
  return api.runtime.agent.resolveAgentWorkspaceDir(cfg);
}

/**
 * Get the plugin config section for goalCommand.
 * @param {Object} ctx - Command context
 * @returns {Object}
 */
function getGoalConfig(ctx) {
  return ctx.config?.goalCommand || {};
}

/**
 * Parse `--turns N` and `--tokens N` flags from a string.
 * @param {string} text
 * @returns {{ turns: number|null, tokens: number|null }}
 */
function parseBudgetFlags(text) {
  const turnsMatch = text.match(/--turns\s+(\d+)/);
  const tokensMatch = text.match(/--tokens\s+(\d+)/);
  return {
    turns: turnsMatch ? parseInt(turnsMatch[1], 10) : null,
    tokens: tokensMatch ? parseInt(tokensMatch[1], 10) : null,
  };
}

export default definePluginEntry({
  id: 'openclaw-goal-command',
  name: 'Goal Command',
  description: 'Closed-loop /goal command with judge model, budget tracking, subgoals, and Obsidian sync.',
  register(api) {
    // ── agent_end hook: judge evaluation after every agent turn ──
    api.registerHook(['agent_end'], async (event, ctx) => {
      try {
        const wsDir = api.runtime.agent.resolveAgentWorkspaceDir(ctx.config);
        const baseDir = getRunsBaseDir(wsDir);
        const dir = await latestRunDir(baseDir);
        if (!dir) return; // no active goal

        const statusContent = await readOptional(path.join(dir, 'status.md'));
        if (!statusContent) return;

        const goalRun = await loadGoalRun(dir);

        // Only evaluate for active (non-terminal) goals
        if (goalRun.isTerminal()) return;
        if (goalRun.state !== 'ACTIVE') return;

        const budget = BudgetTracker.fromStatusFields(goalRun.budgetFields);

        // Check budget exhaustion
        budget.incrementTurn();
        if (budget.isExhausted()) {
          goalRun.state = 'BUDGET_LIMITED';
          budget.stopActiveClock();
          await goalRun.writeStatus(budget.toStatusFields());
          return;
        }

        // Call judge
        const goalText = goalRun.goal;
        const lastResponse = event.finalMessage || '';
        const goalConfig = ctx.config?.goalCommand || {};

        const judgeResult = await callJudge(goalText, lastResponse, goalRun.subgoals, goalConfig);

        // Track parse failures
        const newFailures = judgeResult.parse_failed
          ? (goalRun.judgeFields.consecutive_parse_failures || 0) + 1
          : 0;
        goalRun.judgeFields = {
          last_verdict: judgeResult.verdict,
          last_reason: judgeResult.reason,
          consecutive_parse_failures: newFailures,
        };

        // Auto-pause on consecutive parse failures
        if (shouldAutoPause(newFailures, goalConfig.maxConsecutiveParseFailures || 3)) {
          goalRun.state = 'PAUSED';
          budget.stopActiveClock();
          await goalRun.writeStatus(budget.toStatusFields());
          return;
        }

        // Judge says DONE
        if (judgeResult.verdict === 'done') {
          goalRun.state = 'DONE';
          budget.stopActiveClock();
          await goalRun.writeStatus(budget.toStatusFields());
          await goalRun.writeValidation(goalText, judgeResult.reason, true);
          return;
        }

        // Judge says CONTINUE — inject continuation prompt for next turn
        const prompt = renderContinuationPrompt(
          goalText,
          judgeResult.reason,
          goalRun.subgoals,
          { display: budget.getDisplay() },
        );

        await goalRun.writeStatus(budget.toStatusFields());

        if (ctx.sessionKey) {
          await api.enqueueNextTurnInjection({
            sessionKey: ctx.sessionKey,
            placement: 'prepend_context',
            ttlMs: 10 * 60 * 1000,
            idempotencyKey: `goal-continue:${goalRun.runId}:${Date.now()}`,
            text: prompt,
          });
        }
      } catch (err) {
        // Fail-open: judge errors should not crash the agent loop
        console.error('[goal-command] agent_end hook error:', err);
      }
    });

    api.registerCommand({
      name: 'goal',
      nativeNames: { telegram: 'goalmenu' },
      description: 'Start or manage a closed-loop goal run.',
      acceptsArgs: true,
      requireAuth: true,
      agentPromptGuidance: [
        'When /goal is invoked and continues to the agent, run a closed-loop objective until DONE, BLOCKED, or FAILED. Use the run directory and update its status files. ACTIVE means execute now, not explain or define. Do not end on an open loop or ask whether to continue unless status.md is BLOCKED with the exact missing input.',
      ],
      handler: async (ctx) => {
        const args = (ctx.args || '').trim();
        const goalConfig = getGoalConfig(ctx);
        const wsDir = workspaceDir(api, ctx.config);
        const baseDir = getRunsBaseDir(wsDir);

        // ── Help / no args ───────────────────────────────────────
        if (!args || args === 'help') {
          return {
            text: [
              'Usage:',
              '/goal <objective> — Start a new goal',
              '/goal status [runId] — Show current goal state',
              '/goal pause — Pause the goal loop',
              '/goal resume [--turns N] [--tokens N] — Resume + extend budget',
              '/goal clear — Drop the goal entirely',
              '/goal sub <criterion> — Add a subgoal',
              '/goal sub remove <N> — Remove subgoal by index',
              '/goal sub clear — Remove all subgoals',
              '/goal budget [--turns N] [--tokens N] — View/modify budget',
              '/goal sync [runId] — Sync to Obsidian project notes',
            ].join('\n'),
          };
        }

        const [action, ...rest] = args.split(/\s+/);
        const normalizedAction = action.toLowerCase();

        // ── /goal status [runId] ─────────────────────────────────
        if (normalizedAction === 'status') {
          const requested = rest.join(' ').trim();
          const dir = requested
            ? path.join(baseDir, requested)
            : await latestRunDir(baseDir);
          if (!dir) return { text: 'No goal runs found yet.' };
          try {
            const status = await readOptional(path.join(dir, 'status.md'));
            if (!status) return { text: `Run found but status.md is empty: ${dir}` };

            // Also load budget display if possible
            const goalRun = await loadGoalRun(dir);
            const budget = new BudgetTracker(goalRun.budgetFields);
            const budgetDisplay = budget.getDisplay();

            return {
              text: `${status.slice(0, 3000)}\n\nBudget display: ${budgetDisplay}`,
            };
          } catch {
            return { text: `Goal run found but status.md could not be read: ${dir}` };
          }
        }

        // ── /goal pause ─────────────────────────────────────────
        if (normalizedAction === 'pause') {
          const dir = await latestRunDir(baseDir);
          if (!dir) return { text: 'No active goal to pause.' };

          const goalRun = await loadGoalRun(dir);
          if (goalRun.isTerminal()) {
            return { text: `Goal is already in terminal state: ${goalRun.state}` };
          }
          if (goalRun.state === 'PAUSED') {
            return { text: 'Goal is already paused.' };
          }

          // Stop the active clock and update state
          const budget = BudgetTracker.fromStatusFields(goalRun.budgetFields);
          budget.stopActiveClock();

          goalRun.state = 'PAUSED';
          goalRun.pausedAt = new Date().toISOString();
          await goalRun.writeStatus(budget.toStatusFields());

          return { text: `Goal paused: ${goalRun.runId}\nBudget: ${budget.getDisplay()}` };
        }

        // ── /goal resume [--turns N] [--tokens N] ───────────────
        if (normalizedAction === 'resume') {
          const restText = rest.join(' ');
          const flags = parseBudgetFlags(restText);

          // Filter out flags to find optional runId
          const runIdPart = restText.replace(/--\w+\s+\d+/g, '').trim();
          const dir = runIdPart
            ? path.join(baseDir, runIdPart)
            : await latestRunDir(baseDir);
          if (!dir) return { text: 'No goal run to resume.' };

          const goalRun = await loadGoalRun(dir);
          if (goalRun.isTerminal()) {
            return { text: `Cannot resume: goal is in terminal state ${goalRun.state}. Use /goal clear to remove it.` };
          }

          const budget = BudgetTracker.fromStatusFields(goalRun.budgetFields);

          // Extend budget if requested
          if (flags.turns) budget.extendTurns(flags.turns);
          if (flags.tokens) budget.extendTokens(flags.tokens);

          // Transition to ACTIVE
          const prevState = goalRun.state;
          goalRun.state = goalRun.mode === 'spec' ? 'SPEC_COACH' : 'ACTIVE';
          goalRun.resumedAt = new Date().toISOString();
          budget.startActiveClock();

          await goalRun.writeStatus(budget.toStatusFields());

          // Inject continuation prompt
          if (ctx.sessionKey) {
            const prompt = renderResumePrompt(
              goalRun.goal,
              goalRun.runDir,
              goalRun.state,
              { display: budget.getDisplay() }
            );
            await api.enqueueNextTurnInjection({
              sessionKey: ctx.sessionKey,
              placement: 'prepend_context',
              ttlMs: 10 * 60 * 1000,
              idempotencyKey: `goal-resume:${goalRun.runId}:${Date.now()}`,
              text: prompt,
            });
          }

          return {
            text: `Goal resumed: ${goalRun.runId}\nState: ${prevState} → ${goalRun.state}\nBudget: ${budget.getDisplay()}`,
            continueAgent: true,
          };
        }

        // ── /goal clear ─────────────────────────────────────────
        if (normalizedAction === 'clear') {
          const dir = await latestRunDir(baseDir);
          if (!dir) return { text: 'No goal run to clear.' };

          const goalRun = await loadGoalRun(dir);
          const budget = BudgetTracker.fromStatusFields(goalRun.budgetFields);
          budget.stopActiveClock();

          goalRun.state = 'CLEARED';
          await goalRun.writeStatus(budget.toStatusFields());

          return { text: `Goal cleared: ${goalRun.runId}` };
        }

        // ── /goal sub <text|remove|clear> ────────────────────────
        if (normalizedAction === 'sub') {
          const subArgs = rest.join(' ').trim();
          const dir = await latestRunDir(baseDir);
          if (!dir) return { text: 'No goal run. Start one with /goal <objective> first.' };

          const goalRun = await loadGoalRun(dir);

          // /goal sub (no args) — list subgoals
          if (!subArgs || subArgs === 'list') {
            if (goalRun.subgoals.length === 0) {
              return { text: 'No subgoals defined. Use /goal sub <criterion> to add one.' };
            }
            const items = goalRun.subgoals.map((s, i) => `${i + 1}. ${s}`).join('\n');
            return { text: `Subgoals for ${goalRun.runId}:\n${items}` };
          }

          // /goal sub remove <N>
          const removeMatch = subArgs.match(/^remove\s+(\d+)/i);
          if (removeMatch) {
            const index = parseInt(removeMatch[1], 10);
            if (!goalRun.removeSubgoal(index)) {
              return { text: `Invalid subgoal index: ${index}. Valid range: 1-${goalRun.subgoals.length}` };
            }
            const budget = BudgetTracker.fromStatusFields(goalRun.budgetFields);
            await goalRun.writeStatus(budget.toStatusFields());
            return { text: `Removed subgoal ${index}. Remaining: ${goalRun.subgoals.length}` };
          }

          // /goal sub clear
          if (subArgs.toLowerCase() === 'clear') {
            goalRun.clearSubgoals();
            const budget = BudgetTracker.fromStatusFields(goalRun.budgetFields);
            await goalRun.writeStatus(budget.toStatusFields());
            return { text: 'All subgoals cleared.' };
          }

          // /goal sub <text> — add subgoal
          goalRun.addSubgoal(subArgs);
          const budget = BudgetTracker.fromStatusFields(goalRun.budgetFields);
          await goalRun.writeStatus(budget.toStatusFields());
          return {
            text: `Subgoal added: ${goalRun.subgoals.length}. ${subArgs}\nAll subgoals must be satisfied for DONE.`,
          };
        }

        // ── /goal budget [--turns N] [--tokens N] ────────────────
        if (normalizedAction === 'budget') {
          const restText = rest.join(' ');
          const flags = parseBudgetFlags(restText);
          const dir = await latestRunDir(baseDir);
          if (!dir) return { text: 'No goal run. Start one with /goal <objective> first.' };

          const goalRun = await loadGoalRun(dir);
          const budget = BudgetTracker.fromStatusFields(goalRun.budgetFields);

          // Modify budget if flags present
          let modified = false;
          if (flags.turns) {
            budget.extendTurns(flags.turns);
            modified = true;
          }
          if (flags.tokens) {
            budget.extendTokens(flags.tokens);
            modified = true;
          }

          if (modified) {
            await goalRun.writeStatus(budget.toStatusFields());
            return {
              text: `Budget updated: ${budget.getDisplay()}`,
            };
          }

          return {
            text: `Budget: ${budget.getDisplay()}\nState: ${goalRun.state}\nExhausted: ${budget.isExhausted()}`,
          };
        }

        // ── /goal sync [runId] ────────────────────────────────────
        if (normalizedAction === 'sync') {
          const requested = rest.join(' ').trim();
          const dir = requested
            ? path.join(baseDir, requested)
            : await latestRunDir(baseDir);
          if (!dir) return { text: 'No goal run to sync.' };

          try {
            const result = await syncRunToObsidian(ctx, dir, wsDir, goalConfig);
            return {
              text: `Obsidian sync complete.\nProject: ${result.project}\nState: ${result.state}\nProject page: ${result.projectPath}\nGoal note: ${result.goalPath}`,
            };
          } catch (e) {
            return { text: `Obsidian sync failed: ${e.message}` };
          }
        }

        // ── /goal <objective> — Start a new goal ─────────────────
        const goal = args;
        const isAbstract = isLikelyAbstractGoal(goal);
        const mode = isAbstract ? 'spec' : 'execution';

        const budgetOpts = {
          maxTurns: goalConfig.maxTurns ?? 20,
          tokenBudget: goalConfig.defaultTokenBudget ?? 0,
          timeBudget: goalConfig.defaultTimeBudget ?? 0,
        };

        const { runId, runDir, state, goalRun } = await createRun(
          wsDir, goal, mode, ctx, budgetOpts
        );

        // Start the budget clock for ACTIVE goals
        const budget = new BudgetTracker(budgetOpts);
        if (state === 'ACTIVE') {
          budget.startActiveClock();
        }

        // Inject the appropriate prompt
        if (ctx.sessionKey) {
          const prompt = mode === 'spec'
            ? renderSpecCoachPrompt(goal, runDir)
            : renderGoalLoopPrompt(goal, runDir);

          await api.enqueueNextTurnInjection({
            sessionKey: ctx.sessionKey,
            placement: 'prepend_context',
            ttlMs: 10 * 60 * 1000,
            idempotencyKey: `goal-start:${runId}`,
            text: prompt,
            metadata: { runId, runDir, mode },
          });
        }

        const stateLabel = state === 'SPEC_COACH' ? 'SPEC_COACH (abstract goal)' : 'ACTIVE (concrete goal)';
        return {
          text: `Goal started: ${runId}\nState: ${stateLabel}\nMode: ${mode}\nRun: ${runDir}\nBudget: ${budget.getDisplay()}`,
          continueAgent: true,
        };
      },
    });
  },
});