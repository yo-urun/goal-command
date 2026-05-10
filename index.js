import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OBSIDIAN_SUBDIR = "OpenClaw";

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(input) {
  return String(input || "goal")
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "goal";
}

function workspaceDir(api, cfg) {
  return api.runtime.agent.resolveAgentWorkspaceDir(cfg);
}

function obsidianRoot(api, ctx) {
  const configured = ctx.config?.goalCommand?.obsidianRoot;
  if (configured && path.isAbsolute(configured)) return configured;
  const root = workspaceDir(api, ctx.config);
  return path.join(root, configured || DEFAULT_OBSIDIAN_SUBDIR);
}

function isLikelyAbstractGoal(goal) {
  const normalized = goal.trim().toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const abstractTerms = [
    "besser",
    "verbessern",
    "optimieren",
    "überarbeiten",
    "konzept",
    "system",
    "app",
    "plattform",
    "irgendwas",
    "schöner",
    "modern",
    "perfekt",
    "fertig",
  ];
  const concreteTerms = [
    "baue",
    "erstelle",
    "fixe",
    "behebe",
    "lege",
    "validiere",
    "teste",
    "implementiere",
    "datei",
    "endpoint",
    "button",
    "seite",
    "funktion",
    "wenn",
    "fertig wenn",
  ];

  const hasAbstractTerm = abstractTerms.some((term) => normalized.includes(term));
  const hasConcreteTerm = concreteTerms.some((term) => normalized.includes(term));
  const hasValidationHint = /\b(test|validier|prüf|fertig wenn|done wenn|akzeptanz|erfolg)\b/i.test(goal);

  if (words.length <= 3) return true;
  if (hasAbstractTerm && !hasConcreteTerm) return true;
  if (words.length <= 7 && hasAbstractTerm && !hasValidationHint) return true;
  return false;
}

async function latestRunDir(baseDir) {
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const latest = dirs.at(-1);
    return latest ? path.join(baseDir, latest) : null;
  } catch {
    return null;
  }
}

async function createRun(api, ctx, goal, mode) {
  const root = workspaceDir(api, ctx.config);
  const runId = `${nowStamp()}-${slugify(goal)}`;
  const runDir = path.join(root, "goals", "runs", runId);
  const state = mode === "spec" ? "NEEDS_SPEC" : "EXECUTION_READY";
  const createdAt = new Date().toISOString();
  await mkdir(runDir, { recursive: true });

  const files = {
    "goal.md": `# Goal\n\n${goal}\n\n## Contract\n- End states allowed: DONE, BLOCKED, FAILED.\n- EXECUTION_READY is not a final state. It means execute now.\n- Do not report DONE until Definition of Done is validated with concrete evidence.\n- Do not stop after creating a plan. Continue with tool execution unless blocked.\n- If the goal is underspecified, ask only the minimum blocking questions and keep status NEEDS_SPEC/BLOCKED.\n`,
    "status.md": `# Status\n\n- state: ${state}\n- mode: ${mode}\n- runId: ${runId}\n- project: TBD\n- createdAt: ${createdAt}\n- channel: ${ctx.channel}\n- sessionKey: ${ctx.sessionKey || "unknown"}\n- nextAction: ${state === "EXECUTION_READY" ? "execute-now" : "ask-blocking-spec-questions"}\n`, 
    "decision_log.md": `# Decision Log\n\n- ${createdAt}: Goal command created this run.\n- ${createdAt}: Initial classification: ${mode === "spec" ? "abstract/needs spec-coach" : "concrete/execution-ready"}.\n`,
    "validation.md": `# Validation\n\nPending. Goal is not DONE until this file contains concrete validation evidence.\n`,
    "feature_spec.md": mode === "spec"
      ? `# Feature Spec\n\n## Raw Goal\n${goal}\n\n## Status\nNEEDS_SPEC — answer the blocking Spec-Coach questions before implementation.\n\n## Open Questions\nPending.\n`
      : `# Feature Spec\n\nPending. The orchestrator must create or refine this before implementation if the goal is non-trivial.\n`,
    "plan.md": `# Plan\n\nPending. The orchestrator must create this before execution if the goal is non-trivial.\n`,
  };

  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(path.join(runDir, name), content, "utf8")));
  return { runId, runDir, state };
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function readStatusState(runDir) {
  const status = await readOptional(path.join(runDir, "status.md"));
  const match = status.match(/- state:\s*([^\n]+)/i);
  return match?.[1]?.trim() || "UNKNOWN";
}

function stripTitle(markdown) {
  return markdown.replace(/^#\s+[^\n]+\n*/u, "").trim();
}

function firstMeaningfulLine(markdown, fallback = "Noch nicht gepflegt.") {
  const line = stripTitle(markdown)
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("##") && !item.toLowerCase().startsWith("pending"));
  return line || fallback;
}

function markerStart(name) {
  return `<!-- OPENCLAW:${name}:START -->`;
}

function markerEnd(name) {
  return `<!-- OPENCLAW:${name}:END -->`;
}

function replaceAutoSection(content, name, body) {
  const start = markerStart(name);
  const end = markerEnd(name);
  const section = `${start}\n${body.trim()}\n${end}`;
  if (content.includes(start) && content.includes(end)) {
    const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "m");
    return content.replace(pattern, section);
  }
  return `${content.trim()}\n\n${section}\n`;
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueLines(lines) {
  const seen = new Set();
  return lines.filter((line) => {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function existingAutoLines(content, name) {
  const start = markerStart(name);
  const end = markerEnd(name);
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return [];
  return content.slice(startIndex + start.length, endIndex).split("\n").map((line) => line.trim()).filter(Boolean);
}

function detectProject(run) {
  const combined = `${run.status}\n${run.goal}\n${run.spec}\n${run.plan}`;
  const explicit = combined.match(/(?:project|projekt):\s*([^\n]+)/i)?.[1]?.trim();
  if (explicit && !/^tbd$/i.test(explicit)) return cleanProjectName(explicit);

  const knownProjects = [
    "Caresys",
    "AI-Accountant",
    "MindGraph",
    "Analytics Rocket",
    "MarketingApp",
    "Hermes Agent",
    "OpenClaw",
    "CloudRift NemoClaw",
  ];
  const match = knownProjects.find((project) => combined.toLowerCase().includes(project.toLowerCase()));
  return match || "Inbox";
}

function cleanProjectName(input) {
  return String(input)
    .replace(/[#[\]*/`|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Inbox";
}

function extractListItems(markdown, matcher) {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) && matcher.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "- "));
}

function wikiLink(pathWithoutExtension, label) {
  return `[[${pathWithoutExtension}|${label}]]`;
}

async function ensureObsidianStructure(root) {
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(path.join(root, "Projects"), { recursive: true }),
    mkdir(path.join(root, "Goals"), { recursive: true }),
    mkdir(path.join(root, "Archive"), { recursive: true }),
  ]);

  const defaults = {
    "OpenClaw.md": "# OpenClaw\n\nDashboard für Agenten-Kontext, Projekte, Goals und Learnings.\n\n- [[Projects]]\n- [[Goals]]\n- [[Learnings]]\n- [[Decisions]]\n",
    "Projects.md": "# Projects\n\nProjektübersicht. Projektseiten sind die Source of Truth.\n",
    "Goals.md": "# Goals\n\nAktive und abgeschlossene Goal-Runs.\n",
    "Learnings.md": "# Learnings\n\nNur langfristig relevante, kuratierte Learnings.\n",
    "Decisions.md": "# Decisions\n\nWichtige Entscheidungen mit Projektbezug.\n",
  };

  await Promise.all(Object.entries(defaults).map(async ([name, content]) => {
    const file = path.join(root, name);
    const existing = await readOptional(file);
    if (!existing) await writeFile(file, content, "utf8");
  }));
}

async function loadRun(runDir) {
  const status = await readOptional(path.join(runDir, "status.md"));
  const runId = status.match(/- runId:\s*([^\n]+)/i)?.[1]?.trim() || path.basename(runDir);
  return {
    runDir,
    runId,
    goal: await readOptional(path.join(runDir, "goal.md")),
    status,
    spec: await readOptional(path.join(runDir, "feature_spec.md")),
    plan: await readOptional(path.join(runDir, "plan.md")),
    validation: await readOptional(path.join(runDir, "validation.md")),
    decisions: await readOptional(path.join(runDir, "decision_log.md")),
  };
}

async function syncRunToObsidian(ctx, runDir) {
  const root = obsidianRoot(api, ctx);
  await ensureObsidianStructure(root);

  const run = await loadRun(runDir);
  const project = detectProject(run);
  const date = run.runId.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || new Date().toISOString().slice(0, 10);
  const state = run.status.match(/- state:\s*([^\n]+)/i)?.[1]?.trim() || "UNKNOWN";
  const goalTitle = firstMeaningfulLine(run.goal, run.runId).replace(/^#\s*Goal\s*/i, "").trim() || run.runId;
  const goalSlug = `${date}-${slugify(`${project}-${goalTitle}`)}`;
  const goalNoteName = `${goalSlug}.md`;
  const projectFileName = `${cleanProjectName(project)}.md`;
  const projectPath = path.join(root, "Projects", projectFileName);
  const goalPath = path.join(root, "Goals", goalNoteName);
  const projectLink = wikiLink(`Projects/${projectFileName.replace(/\.md$/u, "")}`, project);
  const goalLink = wikiLink(`Goals/${goalNoteName.replace(/\.md$/u, "")}`, goalTitle.slice(0, 80));
  const syncedAt = new Date().toISOString();

  const goalNote = `# ${goalTitle}\n\n- Projekt: ${projectLink}\n- Status: ${state}\n- RunId: ${run.runId}\n- RunDir: \`${run.runDir}\`\n- Sync: ${syncedAt}\n\n## Ziel\n${stripTitle(run.goal) || "Nicht dokumentiert."}\n\n## Spezifikation\n${stripTitle(run.spec) || "Nicht dokumentiert."}\n\n## Plan / Verlauf\n${stripTitle(run.plan) || "Nicht dokumentiert."}\n\n## Validierung\n${stripTitle(run.validation) || "Keine Validierung dokumentiert."}\n\n## Entscheidungen\n${stripTitle(run.decisions) || "Keine Entscheidungen dokumentiert."}\n`;
  await writeFile(goalPath, goalNote, "utf8");

  const existingProject = await readOptional(projectPath) || `# ${project}\n\nSource of Truth für ${project}. Manuelle Notizen bleiben außerhalb der OpenClaw-Auto-Sektionen erhalten.\n`;
  const recentGoals = uniqueLines([
    `- ${date}: ${goalLink} — ${state}`,
    ...existingAutoLines(existingProject, "recent-goals"),
  ]).slice(0, 20);
  const projectCurrent = [
    `Letztes Update: ${date}`,
    `Status: ${state}`,
    `Letztes Goal: ${goalLink}`,
    `Kurzkontext: ${firstMeaningfulLine(run.validation, firstMeaningfulLine(run.spec, goalTitle))}`,
  ].join("\n");
  let projectContent = replaceAutoSection(existingProject, "current-status", projectCurrent);
  projectContent = replaceAutoSection(projectContent, "recent-goals", recentGoals.join("\n"));
  await writeFile(projectPath, projectContent, "utf8");

  const projectsIndex = await readOptional(path.join(root, "Projects.md"));
  const projectRows = uniqueLines([
    `- ${projectLink} — zuletzt ${date}, ${state}`,
    ...existingAutoLines(projectsIndex, "project-index").filter((line) => !line.includes(`[[Projects/${projectFileName.replace(/\.md$/u, "")}|`)),
  ]).sort((a, b) => a.localeCompare(b));
  await writeFile(path.join(root, "Projects.md"), replaceAutoSection(projectsIndex, "project-index", projectRows.join("\n")), "utf8");

  const goalsIndex = await readOptional(path.join(root, "Goals.md"));
  const goalRows = uniqueLines([
    `- ${date}: ${goalLink} — ${projectLink} — ${state}`,
    ...existingAutoLines(goalsIndex, "goal-index"),
  ]).slice(0, 100);
  await writeFile(path.join(root, "Goals.md"), replaceAutoSection(goalsIndex, "goal-index", goalRows.join("\n")), "utf8");

  const dashboard = await readOptional(path.join(root, "OpenClaw.md"));
  const dashboardBody = [`- Letzter Sync: ${syncedAt}`, `- Letztes Projekt: ${projectLink}`, `- Letztes Goal: ${goalLink}`].join("\n");
  await writeFile(path.join(root, "OpenClaw.md"), replaceAutoSection(dashboard, "dashboard", dashboardBody), "utf8");

  const learningItems = extractListItems(`${run.spec}\n${run.validation}\n${run.decisions}`, /learning|lernen|erkenntnis|fallstrick|solution memory/i);
  if (learningItems.length > 0) {
    const learnings = await readOptional(path.join(root, "Learnings.md"));
    const rows = uniqueLines([
      ...learningItems.map((item) => `${item} (${projectLink}, ${date})`),
      ...existingAutoLines(learnings, "learning-index"),
    ]).slice(0, 100);
    await writeFile(path.join(root, "Learnings.md"), replaceAutoSection(learnings, "learning-index", rows.join("\n")), "utf8");
  }

  const decisionItems = extractListItems(run.decisions, /decision|entscheidung|entschied|beschlossen/i);
  if (decisionItems.length > 0) {
    const decisions = await readOptional(path.join(root, "Decisions.md"));
    const rows = uniqueLines([
      ...decisionItems.map((item) => `${item} (${projectLink}, ${date})`),
      ...existingAutoLines(decisions, "decision-index"),
    ]).slice(0, 100);
    await writeFile(path.join(root, "Decisions.md"), replaceAutoSection(decisions, "decision-index", rows.join("\n")), "utf8");
  }

  return { root, project, projectPath, goalPath, state };
}

function specCoachPrompt(goal, runDir) {
  return `Spec-Coach Mode activated for an abstract /goal. Do not implement yet.\n\nRaw goal: ${goal}\nRun directory: ${runDir}\n\nProtocol:\n1. Read/update feature_spec.md and status.md.\n2. Ask 3-5 strict blocking questions that turn the goal into a buildable spec.\n3. Questions must cover: exact outcome, target project/surface, Definition of Done, constraints/out-of-scope, validation method.\n4. Do not start coding, subagents, shell commands for implementation, or external actions.\n5. Update status.md with state: NEEDS_SPEC or BLOCKED and write the questions into feature_spec.md.\n6. End by asking the user for the missing answers.\n\nThe goal is to prevent open-loop work by forcing a clear spec before execution.`;
}

function goalLoopPrompt(goal, runDir) {
  return `Goal Mode activated. Treat this as a closed-loop objective, not a normal chat request.

CRITICAL EXECUTION CONTRACT:
- Do not answer with only a definition, explanation, checklist, or plan.
- Do not stop while status.md says EXECUTION_READY.
- EXECUTION_READY means: start executing now, using tools/subagents as needed.
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
7. Before DONE, synchronize project context to Obsidian structure OpenClaw/: update the project Source-of-Truth page, create a Goal detail note, update Projects.md and Goals.md, and only add durable learnings/decisions when relevant. If the plugin command is available, use /goal sync for this run; otherwise update those markdown files directly.
8. Update status.md, validation.md, decision_log.md, and Obsidian context before final response.
9. Final response must include: terminal state, validation evidence, files changed, and remaining blockers if any.

Forbidden final states:
- "I created the plan" while status is EXECUTION_READY.
- "Ready to execute" without tool execution.
- "Let me know if you want me to continue" unless status is BLOCKED with the exact missing input.
- DONE without validation evidence.`;
}

export default definePluginEntry({
  id: "openclaw-goal-command",
  name: "Goal Command",
  description: "Closed-loop /goal command for persistent Goal Mode runs.",
  register(api) {
    api.registerCommand({
      name: "goal",
      nativeNames: { telegram: "goalmenu" },
      description: "Start or inspect a closed-loop goal run.",
      acceptsArgs: true,
      requireAuth: true,
      agentPromptGuidance: [
        "When /goal is invoked and continues to the agent, run a closed-loop objective until DONE, BLOCKED, or FAILED. Use the run directory and update its status files. EXECUTION_READY means execute now, not explain or define. Do not end on an open loop or ask whether to continue unless status.md is BLOCKED with the exact missing input.",
      ],
      handler: async (ctx) => {
        const args = (ctx.args || "").trim();
        const baseDir = path.join(workspaceDir(api, ctx.config), "goals", "runs");

        if (!args || args === "help") {
          return {
            text: "Usage: /goal <ziel>\n/goal status [runId]\n/goal resume [runId]\n/goal sync [runId]\n/goal cancel is planned for v2.",
          };
        }

        const [action, ...rest] = args.split(/\s+/);
        const normalizedAction = action.toLowerCase();

        if (normalizedAction === "status") {
          const requested = rest.join(" ").trim();
          const dir = requested ? path.join(baseDir, requested) : await latestRunDir(baseDir);
          if (!dir) return { text: "No goal runs found yet." };
          try {
            const status = await readFile(path.join(dir, "status.md"), "utf8");
            return { text: status.slice(0, 3500) };
          } catch {
            return { text: `Goal run found but status.md could not be read: ${dir}` };
          }
        }

        if (normalizedAction === "resume") {
          const requested = rest.join(" ").trim();
          const dir = requested ? path.join(baseDir, requested) : await latestRunDir(baseDir);
          if (!dir) return { text: "No goal run to resume." };
          const state = await readStatusState(dir);
          if (ctx.sessionKey) {
            await api.enqueueNextTurnInjection({
              sessionKey: ctx.sessionKey,
              placement: "prepend_context",
              ttlMs: 10 * 60 * 1000,
              idempotencyKey: `goal-resume:${dir}:${state}`,
              text: state === "NEEDS_SPEC"
                ? `Resume Spec-Coach Mode from run directory: ${dir}\nRead status.md and feature_spec.md first. Continue asking/refining until the spec is buildable. Do not implement yet.`
                : `Resume Goal Mode from run directory: ${dir}\nRead goal.md, status.md, feature_spec.md, plan.md, validation.md, and decision_log.md first. If status is EXECUTION_READY, execute now; do not answer with only a plan or definition. Continue until status.md is DONE, BLOCKED, or FAILED. Before DONE, validate with concrete evidence and sync the run to Obsidian OpenClaw/ project context.`,
            });
          }
          return {
            text: `Resuming Goal Mode: ${dir}\nState: ${state}`,
            continueAgent: true,
          };
        }

        if (normalizedAction === "sync") {
          const requested = rest.join(" ").trim();
          const dir = requested ? path.join(baseDir, requested) : await latestRunDir(baseDir);
          if (!dir) return { text: "No goal run to sync." };
          const result = await syncRunToObsidian(ctx, dir);
          return {
            text: `Obsidian sync fertig.\nProjekt: ${result.project}\nState: ${result.state}\nProjektseite: ${result.projectPath}\nGoal-Note: ${result.goalPath}`,
          };
        }

        if (normalizedAction === "cancel") {
          return { text: "Cancel is planned for v2. For now use /stop for an active run and mark the goal status manually if needed." };
        }

        const goal = args;
        const mode = isLikelyAbstractGoal(goal) ? "spec" : "execution";
        const { runId, runDir, state } = await createRun(api, ctx, goal, mode);
        if (ctx.sessionKey) {
          await api.enqueueNextTurnInjection({
            sessionKey: ctx.sessionKey,
            placement: "prepend_context",
            ttlMs: 10 * 60 * 1000,
            idempotencyKey: `goal-start:${runId}`,
            text: mode === "spec" ? specCoachPrompt(goal, runDir) : goalLoopPrompt(goal, runDir),
            metadata: { runId, runDir, mode },
          });
        }
        return {
          text: `Goal Mode gestartet: ${runId}\nState: ${state}\nRun: ${runDir}`,
          continueAgent: true,
        };
      },
    });
  },
});
