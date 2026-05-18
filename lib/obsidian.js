/**
 * Obsidian sync — syncs goal run data to Obsidian project notes.
 *
 * Fixed from original brasco05 implementation:
 * - Removed German-only bias in default templates
 * - English-first with i18n support
 * - Uses Obsidian root from plugin config
 *
 * @module obsidian
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readOptional, slugify } from './state.js';

const DEFAULT_OBSIDIAN_SUBDIR = 'OpenClaw';

/**
 * Get the Obsidian root directory.
 * @param {string} workspaceDir - Agent workspace directory
 * @param {Object} config - Plugin config
 * @returns {string} Absolute path to Obsidian root
 */
export function getObsidianRoot(workspaceDir, config = {}) {
  const configured = config?.obsidianRoot;
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(workspaceDir, configured || DEFAULT_OBSIDIAN_SUBDIR);
}

/**
 * Strip markdown title line.
 * @param {string} markdown
 * @returns {string}
 */
function stripTitle(markdown) {
  return markdown.replace(/^#\s+[^\n]+\n*/u, '').trim();
}

/**
 * Get the first meaningful (non-heading, non-pending) line.
 * @param {string} markdown
 * @param {string} [fallback='Not documented.']
 * @returns {string}
 */
function firstMeaningfulLine(markdown, fallback = 'Not documented.') {
  const line = stripTitle(markdown)
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('##') && !item.toLowerCase().startsWith('pending'));
  return line || fallback;
}

/**
 * Generate marker start comment.
 * @param {string} name
 * @returns {string}
 */
function markerStart(name) {
  return `<!-- OPENCLAW:${name}:START -->`;
}

/**
 * Generate marker end comment.
 * @param {string} name
 * @returns {string}
 */
function markerEnd(name) {
  return `<!-- OPENCLAW:${name}:END -->`;
}

/**
 * Escape special regex characters.
 * @param {string} input
 * @returns {string}
 */
function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace or append an auto-managed section in markdown content.
 * @param {string} content - Original markdown
 * @param {string} name - Section name
 * @param {string} body - Section body
 * @returns {string}
 */
function replaceAutoSection(content, name, body) {
  const start = markerStart(name);
  const end = markerEnd(name);
  const section = `${start}\n${body.trim()}\n${end}`;
  if (content.includes(start) && content.includes(end)) {
    const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'm');
    return content.replace(pattern, section);
  }
  return `${content.trim()}\n\n${section}\n`;
}

/**
 * Get existing auto-managed lines from a section.
 * @param {string} content - Markdown content
 * @param {string} name - Section name
 * @returns {string[]}
 */
function existingAutoLines(content, name) {
  const start = markerStart(name);
  const end = markerEnd(name);
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return [];
  return content.slice(startIndex + start.length, endIndex)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Deduplicate and preserve order of lines.
 * @param {string[]} lines
 * @returns {string[]}
 */
function uniqueLines(lines) {
  const seen = new Set();
  return lines.filter((line) => {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Extract list items matching a pattern from markdown.
 * @param {string} markdown
 * @param {RegExp} matcher
 * @returns {string[]}
 */
function extractListItems(markdown, matcher) {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) && matcher.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '- '));
}

/**
 * Generate an Obsidian wiki link.
 * @param {string} pathWithoutExtension
 * @param {string} label
 * @returns {string}
 */
function wikiLink(pathWithoutExtension, label) {
  return `[[${pathWithoutExtension}|${label}]]`;
}

/**
 * Clean a project name for use in filenames.
 * @param {string} input
 * @returns {string}
 */
function cleanProjectName(input) {
  return String(input)
    .replace(/[#[\]*/`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Inbox';
}

/**
 * Detect the project name from run files.
 * @param {Object} run - Loaded run data
 * @returns {string}
 */
function detectProject(run) {
  const combined = `${run.status}\n${run.goal}\n${run.spec}\n${run.plan}`;
  const explicit = combined.match(/(?:project|projekt):\s*([^\n]+)/i)?.[1]?.trim();
  if (explicit && !/^tbd$/i.test(explicit)) return cleanProjectName(explicit);

  const knownProjects = [
    'Caresys', 'AI-Accountant', 'MindGraph', 'Analytics Rocket',
    'MarketingApp', 'Hermes Agent', 'OpenClaw', 'CloudRift NemoClaw',
  ];
  const match = knownProjects.find((project) =>
    combined.toLowerCase().includes(project.toLowerCase())
  );
  return match || 'Inbox';
}

/**
 * Ensure the Obsidian directory structure exists.
 * Creates: root, Projects/, Goals/, Archive/ plus default index pages.
 *
 * @param {string} root - Obsidian root directory
 */
async function ensureObsidianStructure(root) {
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(path.join(root, 'Projects'), { recursive: true }),
    mkdir(path.join(root, 'Goals'), { recursive: true }),
    mkdir(path.join(root, 'Archive'), { recursive: true }),
  ]);

  // English-first default pages
  const defaults = {
    'OpenClaw.md': '# OpenClaw\n\nDashboard for agent context, projects, goals, and learnings.\n\n- [[Projects]]\n- [[Goals]]\n- [[Learnings]]\n- [[Decisions]]\n',
    'Projects.md': '# Projects\n\nProject overview. Project pages are the source of truth.\n',
    'Goals.md': '# Goals\n\nActive and completed goal runs.\n',
    'Learnings.md': '# Learnings\n\nOnly long-term relevant, curated learnings.\n',
    'Decisions.md': '# Decisions\n\nImportant decisions with project context.\n',
  };

  await Promise.all(
    Object.entries(defaults).map(async ([name, content]) => {
      const file = path.join(root, name);
      const existing = await readOptional(file);
      if (!existing) await writeFile(file, content, 'utf8');
    })
  );
}

/**
 * Load all run files from a run directory.
 * @param {string} runDir
 * @returns {Promise<Object>}
 */
async function loadRun(runDir) {
  const status = await readOptional(path.join(runDir, 'status.md'));
  const runId = status.match(/- runId:\s*([^\n]+)/i)?.[1]?.trim() || path.basename(runDir);
  return {
    runDir,
    runId,
    goal: await readOptional(path.join(runDir, 'goal.md')),
    status,
    spec: await readOptional(path.join(runDir, 'feature_spec.md')),
    plan: await readOptional(path.join(runDir, 'plan.md')),
    validation: await readOptional(path.join(runDir, 'validation.md')),
    decisions: await readOptional(path.join(runDir, 'decision_log.md')),
  };
}

/**
 * Sync a goal run to Obsidian project notes.
 *
 * Creates/updates:
 * - Goal note in Goals/
 * - Project page in Projects/
 * - Index pages (Projects.md, Goals.md)
 * - Dashboard (OpenClaw.md)
 * - Learnings and Decisions if applicable
 *
 * @param {Object} ctx - Command context
 * @param {string} runDir - Run directory to sync
 * @param {string} workspaceDir - Agent workspace directory
 * @param {Object} [config={}] - Plugin config
 * @returns {Promise<{ root: string, project: string, projectPath: string, goalPath: string, state: string }>}
 */
export async function syncRunToObsidian(ctx, runDir, workspaceDir, config = {}) {
  const root = getObsidianRoot(workspaceDir, config);
  await ensureObsidianStructure(root);

  const run = await loadRun(runDir);
  const project = detectProject(run);
  const date = run.runId.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || new Date().toISOString().slice(0, 10);
  const state = run.status.match(/- state:\s*([^\n]+)/i)?.[1]?.trim() || 'UNKNOWN';
  const goalTitle = firstMeaningfulLine(run.goal, run.runId)
    .replace(/^#\s*Goal\s*/i, '')
    .trim() || run.runId;
  const goalSlug = `${date}-${slugify(`${project}-${goalTitle}`)}`;
  const goalNoteName = `${goalSlug}.md`;
  const projectFileName = `${cleanProjectName(project)}.md`;
  const projectPath = path.join(root, 'Projects', projectFileName);
  const goalPath = path.join(root, 'Goals', goalNoteName);
  const projectLink = wikiLink(`Projects/${projectFileName.replace(/\.md$/u, '')}`, project);
  const goalLink = wikiLink(`Goals/${goalNoteName.replace(/\.md$/u, '')}`, goalTitle.slice(0, 80));
  const syncedAt = new Date().toISOString();

  // Write goal note (English-first)
  const goalNote = `# ${goalTitle}\\n\n- Project: ${projectLink}\n- Status: ${state}\n- RunId: ${run.runId}\n- RunDir: \`${run.runDir}\`\n- Sync: ${syncedAt}\n\n## Objective\n${stripTitle(run.goal) || 'Not documented.'}\n\n## Specification\n${stripTitle(run.spec) || 'Not documented.'}\n\n## Plan / Progress\n${stripTitle(run.plan) || 'Not documented.'}\n\n## Validation\n${stripTitle(run.validation) || 'No validation documented.'}\n\n## Decisions\n${stripTitle(run.decisions) || 'No decisions documented.'}\n`;
  await writeFile(goalPath, goalNote, 'utf8');

  // Update project page
  const existingProject = await readOptional(projectPath) ||
    `# ${project}\n\nSource of truth for ${project}. Manual notes outside OpenClaw auto-sections are preserved.\n`;

  const recentGoals = uniqueLines([
    `- ${date}: ${goalLink} — ${state}`,
    ...existingAutoLines(existingProject, 'recent-goals'),
  ]).slice(0, 20);

  const projectCurrent = [
    `Last update: ${date}`,
    `Status: ${state}`,
    `Last goal: ${goalLink}`,
    `Summary: ${firstMeaningfulLine(run.validation, firstMeaningfulLine(run.spec, goalTitle))}`,
  ].join('\n');

  let projectContent = replaceAutoSection(existingProject, 'current-status', projectCurrent);
  projectContent = replaceAutoSection(projectContent, 'recent-goals', recentGoals.join('\n'));
  await writeFile(projectPath, projectContent, 'utf8');

  // Update Projects index
  const projectsIndex = await readOptional(path.join(root, 'Projects.md'));
  const projectRows = uniqueLines([
    `- ${projectLink} — last ${date}, ${state}`,
    ...existingAutoLines(projectsIndex, 'project-index').filter(
      (line) => !line.includes(`[[Projects/${projectFileName.replace(/\.md$/u, '')}|`)
    ),
  ]).sort((a, b) => a.localeCompare(b));
  await writeFile(
    path.join(root, 'Projects.md'),
    replaceAutoSection(projectsIndex, 'project-index', projectRows.join('\n')),
    'utf8'
  );

  // Update Goals index
  const goalsIndex = await readOptional(path.join(root, 'Goals.md'));
  const goalRows = uniqueLines([
    `- ${date}: ${goalLink} — ${projectLink} — ${state}`,
    ...existingAutoLines(goalsIndex, 'goal-index'),
  ]).slice(0, 100);
  await writeFile(
    path.join(root, 'Goals.md'),
    replaceAutoSection(goalsIndex, 'goal-index', goalRows.join('\n')),
    'utf8'
  );

  // Update dashboard
  const dashboard = await readOptional(path.join(root, 'OpenClaw.md'));
  const dashboardBody = [
    `Last sync: ${syncedAt}`,
    `Last project: ${projectLink}`,
    `Last goal: ${goalLink}`,
  ].join('\n');
  await writeFile(
    path.join(root, 'OpenClaw.md'),
    replaceAutoSection(dashboard, 'dashboard', dashboardBody),
    'utf8'
  );

  // Extract learnings
  const learningItems = extractListItems(
    `${run.spec}\n${run.validation}\n${run.decisions}`,
    /learning|erkenntnis|fallstrick|solution memory|урок|вывод/i
  );
  if (learningItems.length > 0) {
    const learnings = await readOptional(path.join(root, 'Learnings.md'));
    const rows = uniqueLines([
      ...learningItems.map((item) => `${item} (${projectLink}, ${date})`),
      ...existingAutoLines(learnings, 'learning-index'),
    ]).slice(0, 100);
    await writeFile(
      path.join(root, 'Learnings.md'),
      replaceAutoSection(learnings, 'learning-index', rows.join('\n')),
      'utf8'
    );
  }

  // Extract decisions
  const decisionItems = extractListItems(
    run.decisions,
    /decision|entscheidung|entschied|beschlossen|решени[ея]/i
  );
  if (decisionItems.length > 0) {
    const decisions = await readOptional(path.join(root, 'Decisions.md'));
    const rows = uniqueLines([
      ...decisionItems.map((item) => `${item} (${projectLink}, ${date})`),
      ...existingAutoLines(decisions, 'decision-index'),
    ]).slice(0, 100);
    await writeFile(
      path.join(root, 'Decisions.md'),
      replaceAutoSection(decisions, 'decision-index', rows.join('\n')),
      'utf8'
    );
  }

  return { root, project, projectPath, goalPath, state };
}