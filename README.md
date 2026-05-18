# openclaw-goal-command

Closed-loop `/goal` command plugin for OpenClaw. Synthesizes the best ideas from four reference implementations:

| Feature | Source |
|---------|--------|
| Judge model (fail-open, parse guard) | Hermes |
| Completion audit | Claude-Goal |
| Triple budget (turns + tokens + wall-clock) | Codex + Claude-Goal |
| Subgoals | Hermes |
| Abstract/concrete classification | brasco05 |
| Obsidian sync | brasco05 |
| Validation evidence | brasco05 |
| `agent_end` hook for auto-continuation | Original |

## Features

- **Judge system** — auxiliary LLM call after every agent turn evaluates whether the goal is done; fail-open (judge errors → continue)
- **Parse failure guard** — 3 consecutive parse failures → auto-pause (configurable)
- **Triple budget** — turn budget, token budget, wall-clock budget; all configurable, all optional (0 = unlimited)
- **Subgoals** — `/goal sub add/remove/clear`; all must be satisfied for DONE
- **8 states** — SPEC_COACH, ACTIVE, PAUSED, BUDGET_LIMITED, BLOCKED, DONE, FAILED, CLEARED
- **Goal classification** — abstract goals route to spec-coach mode; concrete goals go straight to execution; supports EN, DE, RU
- **Completion audit** — injected into every continuation prompt to prevent premature DONE
- **Obsidian sync** — `/goal sync` writes project notes to Obsidian vault
- **Auto-continuation** — `agent_end` hook calls judge and injects continuation prompt via `enqueueNextTurnInjection`

## Commands

```
/goal <objective>                     — Start a new goal
/goal status [runId]                  — Show current goal state
/goal pause                           — Pause the goal loop
/goal resume [--turns N] [--tokens N]  — Resume + extend budget
/goal clear                           — Drop the goal entirely
/goal sub <criterion>                 — Add a subgoal
/goal sub remove <N>                  — Remove subgoal by index
/goal sub clear                       — Remove all subgoals
/goal budget [--turns N] [--tokens N] — View/modify budget
/goal sync [runId]                    — Sync to Obsidian project notes
```

## Configuration

Add to your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "openclaw-goal-command": {
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

Config options (under `goalCommand`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxTurns` | number | 20 | Maximum continuation turns before BUDGET_LIMITED |
| `judgeModel` | string | null | Judge model override (null = session model) |
| `judgeTimeout` | number | 30 | Judge API timeout in seconds |
| `judgeMaxTokens` | number | 4096 | Judge max output tokens |
| `maxConsecutiveParseFailures` | number | 3 | Consecutive judge parse failures before auto-pause |
| `defaultTokenBudget` | number | 0 | Default token budget (0 = unlimited) |
| `defaultTimeBudget` | number | 0 | Default wall-clock budget in seconds (0 = unlimited) |
| `obsidianRoot` | string | "OpenClaw" | Obsidian sync root directory |
| `obsidianSync` | boolean | true | Enable Obsidian sync |
| `classificationLang` | string | "auto" | Language for classification heuristics |

## State Machine

```
SPEC_COACH ──→ ACTIVE ──→ DONE
     │            │          ▲
     │            ├─→ PAUSED ┘│
     │            │           │
     │            ├─→ BUDGET_LIMITED ──→ (resume extends)
     │            │
     │            ├─→ BLOCKED (waiting for user)
     │            │
     │            └─→ FAILED
     │
     └──────→ CLEARED
```

## Architecture

```
goal-command/
├── index.js              # Command handler + agent_end hook
├── lib/
│   ├── budget.js         # Triple budget tracker (turns, tokens, wall-clock)
│   ├── classify.js       # Abstract vs concrete goal classification
│   ├── judge.js          # Judge LLM call + response parser + parse guard
│   ├── obsidian.js       # Obsidian vault sync
│   ├── prompts.js        # All prompt templates
│   └── state.js          # 8-state machine + GoalRun class + run dir persistence
├── tests/
│   ├── budget.test.mjs
│   ├── classify.test.mjs
│   ├── closed-loop.test.mjs
│   └── judge.test.mjs
├── openclaw.plugin.json
└── package.json
```

## Judge Loop

After every agent turn, the `agent_end` hook:

1. Checks for an active goal run
2. Increments turn budget
3. Checks budget exhaustion → transitions to BUDGET_LIMITED
4. Calls the judge LLM with goal + last response + subgoals
5. On parse failure: increments counter; 3+ consecutive → auto-pause
6. On verdict `done`: transitions to DONE, writes validation.md
7. On verdict `continue`: injects continuation prompt via `enqueueNextTurnInjection`

Fail-open: any judge error → continue (broken judge ≠ stuck progress).

## Comparison with Reference Implementations

| Feature | Hermes | Claude-Goal | Codex | brasco05 | **This** |
|---------|--------|-------------|-------|----------|----------|
| Judge model | ✅ | ❌ (audit) | ❌ (budget) | ❌ | ✅ |
| Subgoals | ✅ | ❌ | ❌ | ❌ | ✅ |
| Parse failure guard | ✅ | ❌ | ❌ | ❌ | ✅ |
| Turn budget | ✅ (20) | ✅ | ✅ | ❌ | ✅ |
| Token budget | ❌ | ✅ | ✅ | ❌ | ✅ |
| Wall-clock budget | ❌ | ✅ | ✅ | ❌ | ✅ |
| Completion audit | ❌ | ✅ | ❌ | ❌ | ✅ |
| Classification | ❌ | ❌ | ❌ | ✅ (DE) | ✅ (EN+DE+RU) |
| Obsidian sync | ❌ | ❌ | ❌ | ✅ | ✅ |
| Validation evidence | ❌ | ✅ | ❌ | ✅ | ✅ |
| Auto-continuation | ✅ (Python) | ✅ | ✅ (Rust) | ✅ (JS) | ✅ (hook) |
| 8 states | ❌ (5) | ❌ (4) | ✅ (4) | ❌ (5) | ✅ |

## License

MIT