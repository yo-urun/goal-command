import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function ensureOpenClawMock() {
  const mockDir = path.join(repoDir, "node_modules", "openclaw", "plugin-sdk");
  await mkdir(mockDir, { recursive: true });
  await writeFile(
    path.join(repoDir, "node_modules", "openclaw", "package.json"),
    JSON.stringify({ type: "module" }),
    "utf8",
  );
  await writeFile(
    path.join(mockDir, "plugin-entry"),
    "export function definePluginEntry(entry) { return entry; }\n",
    "utf8",
  );
}

function createApi(workspaceDir) {
  const api = {
    command: null,
    injections: [],
    runtime: {
      agent: {
        resolveAgentWorkspaceDir() {
          return workspaceDir;
        },
      },
    },
    registerCommand(command) {
      this.command = command;
    },
    async enqueueNextTurnInjection(injection) {
      this.injections.push(injection);
    },
  };
  return api;
}

async function loadPlugin() {
  await ensureOpenClawMock();
  const moduleUrl = new URL(`../index.js?test=${Date.now()}`, import.meta.url);
  return (await import(moduleUrl.href)).default;
}

async function startGoal(command, api, args) {
  return command.handler({
    args,
    channel: "test",
    sessionKey: "session:test",
    config: {},
  });
}

async function testConcreteGoalStartsExecutionMode() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "goal-command-test-"));
  try {
    const plugin = await loadPlugin();
    const api = createApi(workspace);
    plugin.register(api);

    const result = await startGoal(
      api.command,
      api,
      "create a file named done.txt with text ok; Definition of Done: file exists and contains ok",
    );

    assert.equal(result.continueAgent, true);
    assert.match(result.text, /State: EXECUTION_READY/);
    assert.equal(api.injections.length, 1);
    const injection = api.injections[0];
    assert.equal(injection.placement, "prepend_context");
    assert.match(injection.text, /EXECUTION_READY means: start executing now/);
    assert.match(injection.text, /terminal state: DONE, BLOCKED, or FAILED/);
    assert.match(injection.text, /"Let me know if you want me to continue" unless status is BLOCKED/);

    const runDir = result.text.match(/Run: (.+)$/m)?.[1];
    assert.ok(runDir, "run dir is returned");
    const status = await readFile(path.join(runDir, "status.md"), "utf8");
    const goal = await readFile(path.join(runDir, "goal.md"), "utf8");
    const validation = await readFile(path.join(runDir, "validation.md"), "utf8");

    assert.match(status, /- state: EXECUTION_READY/);
    assert.match(status, /- nextAction: execute-now/);
    assert.match(goal, /EXECUTION_READY is not a final state/);
    assert.match(goal, /Do not report DONE until Definition of Done is validated/);
    assert.match(validation, /Pending/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testAbstractGoalRoutesToSpecCoach() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "goal-command-test-"));
  try {
    const plugin = await loadPlugin();
    const api = createApi(workspace);
    plugin.register(api);

    const result = await startGoal(api.command, api, "improve my app");

    assert.equal(result.continueAgent, true);
    assert.match(result.text, /State: NEEDS_SPEC/);
    assert.equal(api.injections.length, 1);
    assert.match(api.injections[0].text, /Spec-Coach Mode activated/);
    assert.match(api.injections[0].text, /Do not implement yet/);

    const runDir = result.text.match(/Run: (.+)$/m)?.[1];
    assert.ok(runDir, "run dir is returned");
    const status = await readFile(path.join(runDir, "status.md"), "utf8");
    const spec = await readFile(path.join(runDir, "feature_spec.md"), "utf8");

    assert.match(status, /- state: NEEDS_SPEC/);
    assert.match(status, /- nextAction: ask-blocking-spec-questions/);
    assert.match(spec, /NEEDS_SPEC/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await testConcreteGoalStartsExecutionMode();
await testAbstractGoalRoutesToSpecCoach();
console.log("closed-loop goal-command tests passed");
