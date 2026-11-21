'use strict';

// filing-projects.js -- the registered projects a filed task may target, and the lookup that resolves a --project id to one of them.
//
// Mirrors the registry reading in src/pool-projects.js (same PROJECTS_PATH rule, same realpath dedupe), but does NOT drop the active
// project and does NOT require `pool: true`: any registered project with a repoRoot and pipelineDir is a valid filing target.
// A project's id is its projects.json `label`, falling back to the basename of its repoRoot (the same rule pool-projects.js uses).

const fs = require('fs');
const path = require('path');

const PROJECTS_PATH = process.env.AGENT_MANAGER_PROJECTS_PATH || path.join(__dirname, '..', 'projects.json');

function real(p) {
  if (!p) return '';
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function readProjects(projectsPath = PROJECTS_PATH) {
  try {
    const list = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function projectId(entry) {
  return entry.label || path.basename(entry.repoRoot);
}

// Keeps every entry with a repoRoot and pipelineDir, deduped by realpath(pipelineDir) (first occurrence wins).
// With no argument it reads projects.json.
function filingTargets(entries = readProjects()) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (!e || !e.repoRoot || !e.pipelineDir) continue;
    const pipe = real(e.pipelineDir);
    if (seen.has(pipe)) continue;
    seen.add(pipe);
    out.push(e);
  }
  return out;
}

// Returns the target whose id is `id`. Throws when id is missing or unknown; both messages list every registered id.
function resolveFilingProject(id, targets) {
  const ids = targets.map(projectId).join(', ');
  if (!id) throw new Error('--project is required. Registered project ids: ' + ids);
  const hit = targets.find((t) => projectId(t) === id);
  if (!hit) throw new Error('Unknown project "' + id + '". Registered project ids: ' + ids);
  return hit;
}

module.exports = { projectId, filingTargets, resolveFilingProject };
