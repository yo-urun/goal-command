# Goal Command

**Turn `/goal` into a persistent execution loop instead of a planning prompt.**

Goal Command is an OpenClaw plugin that adds a closed-loop `/goal` command. It creates a durable run directory, injects execution guidance into the next agent turn, and forces the run toward exactly one terminal state: `DONE`, `BLOCKED`, or `FAILED`.

## Why It Exists

Normal agent chats often stop at:

- “Here is the plan”
- “Ready to execute”
- “Let me know if you want me to continue”

That is not enough for objective work. Goal Command makes the run state explicit and persistent so the agent must execute, validate, and close the loop.

## What It Does

When you run:

```text
/goal fix the broken checkout test and validate it passes
```

The plugin creates:

```text
goals/runs/<timestamp-slug>/
├── goal.md
├── status.md
├── feature_spec.md
├── plan.md
├── validation.md
└── decision_log.md
```

For concrete goals it sets:

```text
state: EXECUTION_READY
nextAction: execute-now
```

The injected prompt then tells the agent:

- `EXECUTION_READY` means execute now, not explain
- do not stop after creating a plan
- update status to `DONE`, `BLOCKED`, or `FAILED`
- validate before `DONE`
- write blockers/evidence into run files

## Commands

```text
/goal <objective>
/goal status [runId]
/goal resume [runId]
/goal sync [runId]
```

`/goal cancel` is currently reserved for a future version.

## Abstract vs Concrete Goals

The plugin classifies vague goals as `NEEDS_SPEC` and starts a short spec-coach flow first.

Examples:

```text
/goal improve my app
```

→ asks blocking spec questions first.

```text
/goal update the landing page headline and verify build passes
```

→ starts execution mode.

## Obsidian / Project Notes

By default, synced notes go under:

```text
<agent-workspace>/OpenClaw
```

Optional config:

```json
{
  "goalCommand": {
    "obsidianRoot": "OpenClaw"
  }
}
```

`obsidianRoot` may be workspace-relative or an absolute path.

## Safety Notes

- The plugin writes markdown run files inside the agent workspace.
- `/goal sync` writes markdown project/goal notes under the configured Obsidian root.
- It does not execute shell commands by itself.
- External/destructive work still depends on the agent’s normal approval and safety rules.
- `DONE` requires validation evidence; effort alone is not completion.

## Best Used For

- multi-step coding tasks
- debugging chains
- project cleanup
- publishing/checklist work
- anything where stopping at “plan created” would be failure

---

*by brasco05 · built for OpenClaw closed-loop execution*
