'use strict';

// The registered projects, as the dashboard chat sees them (2026-10-25). The chat used to get bare repo paths from list_roots and could not say which
// project a path belonged to, so queue_reviewed_task filed a task about the chat plugin repo into agent-manager's own queue. This module reads
// projects.json and answers three questions: which projects exist (listProjects), which one does a name mean (resolveProject), and which single
// project does a piece of text talk about (projectForText). Pure apart from reading the registry; never throws.
//
// PROJECT = { label, repoRoot, pipelineDir, domainsPath, pool, active }

const fs = require('fs');
const path = require('path');

function real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); }
}

function defaultRegistryPath() {
  return process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH || path.join(__dirname, '..', 'projects.json');
}

// Entries without a repoRoot are skipped; entries are de-duplicated by the realpath of repoRoot (projects.json lists agent-manager twice under two
// path aliases). `pool` is true only for pool:true; `active` when repoRoot is activeRepoRoot (default: the configured pipeline repo).
function listProjects({ registryPath, activeRepoRoot } = {}) {
  let entries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath || defaultRegistryPath(), 'utf8'));
    if (Array.isArray(parsed)) entries = parsed;
  } catch { /* missing or unreadable registry: no projects */ }
  let activeReal = null;
  try { activeReal = real(activeRepoRoot || require('./config.js').getConfig().repoRoot); } catch { /* no config: nothing is active */ }
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object' || typeof e.repoRoot !== 'string' || !e.repoRoot) continue;
    const repoReal = real(e.repoRoot);
    if (seen.has(repoReal)) continue;
    seen.add(repoReal);
    const pipelineDir = typeof e.pipelineDir === 'string' && e.pipelineDir ? e.pipelineDir : e.repoRoot;
    out.push({
      label: typeof e.label === 'string' && e.label ? e.label : path.basename(repoReal),
      repoRoot: e.repoRoot,
      pipelineDir,
      domainsPath: typeof e.domainsPath === 'string' && e.domainsPath ? e.domainsPath : path.join(pipelineDir, 'task-domains.json'),
      pool: e.pool === true,
      active: activeReal !== null && repoReal === activeReal,
    });
  }
  return out;
}

// `arg` is a label (any case) or a repo root. { project } or { error: 'unknown project "x" -- valid projects: a, b' }.
function resolveProject(arg, projects) {
  const list = Array.isArray(projects) ? projects : [];
  const text = typeof arg === 'string' ? arg.trim() : '';
  if (text) {
    const lower = text.toLowerCase();
    const byLabel = list.find((p) => p.label.toLowerCase() === lower);
    if (byLabel) return { project: byLabel };
    const asReal = real(text);
    const byRoot = list.find((p) => real(p.repoRoot) === asReal);
    if (byRoot) return { project: byRoot };
  }
  return { error: `unknown project "${text}" -- valid projects: ${list.map((p) => p.label).join(', ') || '(none registered)'}` };
}

// The single project whose repoRoot contains EVERY absolute path mentioned in `text` (longest repoRoot wins for a path inside nested roots).
// null when the text names no absolute path inside any project, or names paths from more than one project.
function projectForText(text, projects) {
  const list = Array.isArray(projects) ? projects : [];
  const paths = String(text == null ? '' : text).match(/\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+/g) || [];
  // Both spellings of a root count (the registry may list an alias path; the text may use either).
  const roots = [];
  for (const p of list) for (const root of new Set([real(p.repoRoot), path.resolve(p.repoRoot)])) roots.push({ p, root });
  roots.sort((a, b) => b.root.length - a.root.length);
  const owners = new Set();
  for (const raw of paths) {
    const hit = roots.find(({ root }) => raw === root || raw.startsWith(root + '/'));
    if (hit) owners.add(hit.p);
  }
  return owners.size === 1 ? [...owners][0] : null;
}

module.exports = { listProjects, resolveProject, projectForText };
