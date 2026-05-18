/**
 * Integration tests — tests the full /goal command flow.
 * Run: node tests/closed-loop.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function ensureOpenClawMock() {
  const mockDir = path.join(repoDir, 'node_modules', 'openclaw', 'plugin-sdk');
  await mkdir(mockDir, { recursive: true });
  await writeFile(
    path.join(repoDir, 'node_modules', 'openclaw', 'package.json'),
    JSON.stringify({ type: 'module' }),
    'utf8'
  );
  await writeFile(
    path.join(mockDir, 'plugin-entry'),
    "export function definePluginEntry(entry) { return entry; }\n",
    'utf8'
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
    registerHook(events, handler) {
      // Store for potential testing; no-op in unit tests
      this._hooks = this._hooks || [];
      this._hooks.push({ events, handler });
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
    channel: 'test',
    sessionKey: 'session:test',
    config: {},
  });
}

async function testConcreteGoalStartsActiveMode() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'goal-command-test-'));
  try {
    const plugin = await loadPlugin();
    const api = createApi(workspace);
    plugin.register(api);

    const result = await startGoal(
      api.command,
      api,
      'create a file named done.txt with text ok; Definition of Done: file exists and contains ok'
    );

    assert.equal(result.continueAgent, true);
    assert.match(result.text, /ACTIVE \(concrete goal\)/);
    assert.equal(api.injections.length, 1);
    const injection = api.injections[0];
    assert.equal(injection.placement, 'prepend_context');
    assert.match(injection.text, /Goal Mode activated/);
    assert.match(injection.text, /terminal state: DONE, BLOCKED, or FAILED/);

    const runDir = result.text.match(/Run: (.+)$/m)?.[1];
    assert.ok(runDir, 'run dir is returned');
    const status = await readFile(path.join(runDir, 'status.md'), 'utf8');
    const goal = await readFile(path.join(runDir, 'goal.md'), 'utf8');
    const validation = await readFile(path.join(runDir, 'validation.md'), 'utf8');

    assert.match(status, /- state: ACTIVE/);
    assert.match(goal, /End states allowed: DONE, BLOCKED, FAILED/);
    assert.match(goal, /Do not report DONE until Definition of Done is validated/);
    assert.match(validation, /Pending/);

    console.log('  ✓ Concrete goal starts in ACTIVE mode');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testAbstractGoalRoutesToSpecCoach() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'goal-command-test-'));
  try {
    const plugin = await loadPlugin();
    const api = createApi(workspace);
    plugin.register(api);

    const result = await startGoal(api.command, api, 'improve my app');

    assert.equal(result.continueAgent, true);
    assert.match(result.text, /SPEC_COACH \(abstract goal\)/);
    assert.equal(api.injections.length, 1);
    assert.match(api.injections[0].text, /Spec-Coach Mode activated/);
    assert.match(api.injections[0].text, /Do not implement yet/);

    const runDir = result.text.match(/Run: (.+)$/m)?.[1];
    assert.ok(runDir, 'run dir is returned');
    const status = await readFile(path.join(runDir, 'status.md'), 'utf8');
    const spec = await readFile(path.join(runDir, 'feature_spec.md'), 'utf8');

    assert.match(status, /- state: SPEC_COACH/);
    assert.match(spec, /SPEC_COACH/);

    console.log('  ✓ Abstract goal starts in SPEC_COACH mode');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testStatusCommand() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'goal-command-test-'));
  try {
    const plugin = await loadPlugin();
    const api = createApi(workspace);
    plugin.register(api);

    // Start a goal first
    await startGoal(api.command, api, 'fix lint errors in src/');

    // Check status
    const result = await startGoal(api.command, api, 'status');
    assert.match(result.text, /- state: ACTIVE/);

    console.log('  ✓ /goal status shows current state');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testPauseAndResume() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'goal-command-test-'));
  try {
    const plugin = await loadPlugin();
    const api = createApi(workspace);
    plugin.register(api);

    await startGoal(api.command, api, 'fix lint errors in src/');

    // Pause
    const pauseResult = await startGoal(api.command, api, 'pause');
    assert.match(pauseResult.text, /Goal paused/);

    // Resume
    const resumeResult = await startGoal(api.command, api, 'resume');
    assert.match(resumeResult.text, /Goal resumed/);
    assert.match(resumeResult.text, /ACTIVE/);

    console.log('  ✓ /goal pause and /goal resume work');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testSubgoals() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'goal-command-test-'));
  try {
    const plugin = await loadPlugin();
    const api = createApi(workspace);
    plugin.register(api);

    await startGoal(api.command, api, 'fix lint errors in src/');

    // Add subgoal
    const addResult = await startGoal(api.command, api, 'sub Also fix warnings in tests/');
    assert.match(addResult.text, /Subgoal added/);

    // List subgoals
    const listResult = await startGoal(api.command, api, 'sub');
    assert.match(listResult.text, /Also fix warnings/);

    // Remove subgoal
    const removeResult = await startGoal(api.command, api, 'sub remove 1');
    assert.match(removeResult.text, /Removed subgoal/);

    console.log('  ✓ /goal sub add, list, remove work');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testClear() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'goal-command-test-'));
  try {
    const plugin = await loadPlugin();
    const api = createApi(workspace);
    plugin.register(api);

    await startGoal(api.command, api, 'fix lint errors');

    const clearResult = await startGoal(api.command, api, 'clear');
    assert.match(clearResult.text, /Goal cleared/);

    console.log('  ✓ /goal clear works');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

console.log('closed-loop goal-command tests\n');

await testConcreteGoalStartsActiveMode();
await testAbstractGoalRoutesToSpecCoach();
await testStatusCommand();
await testPauseAndResume();
await testSubgoals();
await testClear();

console.log('\nAll closed-loop tests passed!');