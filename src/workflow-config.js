'use strict';

// Optional workflow file (HUB0326 piece W-C1): an authoring layer over the derived Workers graph, with groups, authored edges and labels.
//
//   { "schemaVersion": 1,
//     "groups": [ { "id": "group:<slug>", "label": "...", "children": ["<node id or group id>", ...], "collapsed": false } ],
//     "edges":  [ { "from": "<node id>", "to": "<node id>", "kind": "produces|claims|reviews|applies|triggers|refines", "label": "..." | null } ],
//     "labels": { "<node id>": "<label>" } }
//
// The file path is AGENT_MANAGER_WORKFLOW_PATH, default <repo>/workflow.json; an absent file means no authoring. It never creates or changes a lane: lanes still come only from
// src/lanes.js and lanes.json. FAIL CLOSED, in the style of src/lanes.js: a bad entry is dropped with a warning that names it and never creates or widens anything. Unlike lanes.js the
// warnings are RETURNED (no process-wide state), so a caller can show them: validateWorkflowConfig(raw) and readWorkflowConfig(env) both return { config, warnings }.
// CLI: `node src/workflow-config.js` prints { config, warnings } as one line of JSON.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const EDGE_KINDS = ['produces', 'claims', 'reviews', 'applies', 'triggers', 'refines'];
const GROUP_ID_RE = /^group:[a-z0-9][a-z0-9-]*$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LABEL = 60;
const MAX_EDGES = 500;
const MAX_LABELS = 500;

function emptyConfig() { return { schemaVersion: 1, groups: [], edges: [], labels: {} }; }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// A usable label: a non-empty string of at most MAX_LABEL characters (trimmed), else null.
function cleanLabel(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= MAX_LABEL ? s : null;
}

// Groups that sit on a cycle of group nesting (a group reaches itself through children that are group ids).
function groupsOnCycles(groups) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const onCycle = new Set();
  for (const g of groups) {
    const seen = new Set();
    const stack = g.children.filter((c) => byId.has(c));
    while (stack.length) {
      const id = stack.pop();
      if (id === g.id) { onCycle.add(g.id); break; }
      if (seen.has(id)) continue;
      seen.add(id);
      for (const c of byId.get(id).children) if (byId.has(c)) stack.push(c);
    }
  }
  return onCycle;
}

function validateGroups(raw, warnings) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { warnings.push('groups must be an array; ignoring all groups'); return []; }
  const kept = [];
  const seen = new Set();
  raw.forEach((entry, i) => {
    const where = `group #${i + 1}`;
    if (!isObject(entry)) { warnings.push(`${where} is not an object; dropped`); return; }
    if (typeof entry.id !== 'string' || !GROUP_ID_RE.test(entry.id)) { warnings.push(`${where} id ${JSON.stringify(entry.id)} must match ${GROUP_ID_RE}; dropped`); return; }
    if (seen.has(entry.id)) { warnings.push(`${where} repeats the id ${entry.id}; the first one wins, this one is dropped`); return; }
    seen.add(entry.id);
    if (!Array.isArray(entry.children)) { warnings.push(`${where} (${entry.id}) needs a children array; dropped`); return; }
    const children = [];
    for (const c of entry.children) {
      if (typeof c !== 'string' || !c.trim()) { warnings.push(`${where} (${entry.id}) has a child that is not a non-empty string; that child is dropped`); continue; }
      if (!children.includes(c)) children.push(c);
    }
    if (!children.length) { warnings.push(`${where} (${entry.id}) has no usable children; dropped`); return; }
    if (children.includes(entry.id)) { warnings.push(`${where} (${entry.id}) lists itself as a child; dropped`); return; }
    const label = cleanLabel(entry.label);
    if (entry.label !== undefined && label === null) warnings.push(`${where} (${entry.id}) label must be a non-empty string of at most ${MAX_LABEL} characters; the id is used`);
    if (entry.collapsed !== undefined && typeof entry.collapsed !== 'boolean') warnings.push(`${where} (${entry.id}) collapsed must be a boolean; false is used`);
    kept.push({ id: entry.id, label: label || entry.id, children, collapsed: entry.collapsed === true });
  });
  const cyclic = groupsOnCycles(kept);
  if (!cyclic.size) return kept;
  for (const id of cyclic) warnings.push(`group ${id} is part of a nesting cycle; dropped`);
  return kept.filter((g) => !cyclic.has(g.id));
}

function validateEdges(raw, warnings) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { warnings.push('edges must be an array; ignoring all edges'); return []; }
  const kept = [];
  let over = 0;
  raw.forEach((entry, i) => {
    const where = `edge #${i + 1}`;
    if (!isObject(entry)) { warnings.push(`${where} is not an object; dropped`); return; }
    if (typeof entry.from !== 'string' || !entry.from.trim() || typeof entry.to !== 'string' || !entry.to.trim()) { warnings.push(`${where} needs string "from" and "to"; dropped`); return; }
    if (entry.from === entry.to) { warnings.push(`${where} starts and ends at ${entry.from}; dropped`); return; }
    if (!EDGE_KINDS.includes(entry.kind)) { warnings.push(`${where} kind ${JSON.stringify(entry.kind)} must be one of ${EDGE_KINDS.join(', ')}; dropped`); return; }
    let label = null;
    if (entry.label !== undefined && entry.label !== null) {
      label = cleanLabel(entry.label);
      if (label === null) { warnings.push(`${where} label must be a non-empty string of at most ${MAX_LABEL} characters or null; dropped`); return; }
    }
    if (kept.length >= MAX_EDGES) { over += 1; return; }
    kept.push({ from: entry.from, to: entry.to, kind: entry.kind, label });
  });
  if (over) warnings.push(`more than ${MAX_EDGES} edges; ${over} dropped`);
  return kept;
}

function validateLabels(raw, warnings) {
  if (raw === undefined) return {};
  if (!isObject(raw)) { warnings.push('labels must be an object; ignoring all labels'); return {}; }
  const kept = {};
  let count = 0;
  let over = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (!id.trim()) { warnings.push('a label has an empty node id; dropped'); continue; }
    const label = cleanLabel(value);
    if (label === null) { warnings.push(`label of ${id} must be a non-empty string of at most ${MAX_LABEL} characters; dropped`); continue; }
    if (count >= MAX_LABELS) { over += 1; continue; }
    kept[id] = label;
    count += 1;
  }
  if (over) warnings.push(`more than ${MAX_LABELS} labels; ${over} dropped`);
  return kept;
}

// Pure and never throws: any input gives { config, warnings } with config always complete.
function validateWorkflowConfig(raw) {
  const warnings = [];
  try {
    if (!isObject(raw)) { warnings.push('the workflow file must be a JSON object; ignoring it'); return { config: emptyConfig(), warnings }; }
    if (raw.schemaVersion !== 1) { warnings.push(`schemaVersion must be 1 (got ${JSON.stringify(raw.schemaVersion)}); ignoring the workflow file`); return { config: emptyConfig(), warnings }; }
    return { config: { schemaVersion: 1, groups: validateGroups(raw.groups, warnings), edges: validateEdges(raw.edges, warnings), labels: validateLabels(raw.labels, warnings) }, warnings };
  } catch (e) {
    return { config: emptyConfig(), warnings: [`the workflow file could not be checked (${e && e.message ? e.message : e}); ignoring it`] };
  }
}

function workflowConfigPath(env = process.env) {
  return env.AGENT_MANAGER_WORKFLOW_PATH || path.join(REPO, 'workflow.json');
}

// { config, warnings } for the file at workflowConfigPath(env): absent file = empty config and no warning; unreadable, too large or not JSON = empty config and one warning.
function readWorkflowConfig(env = process.env) {
  const file = workflowConfigPath(env);
  const give = (warning) => ({ config: emptyConfig(), warnings: warning ? [`${file}: ${warning}`] : [] });
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return give(e && e.code === 'ENOENT' ? '' : `cannot read it (${e.message}); ignoring it`);
  }
  if (!stat.isFile()) return give('is not a file; ignoring it');
  if (stat.size > MAX_FILE_BYTES) return give(`is larger than ${MAX_FILE_BYTES / 1024} KB; ignoring it`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return give(`cannot be read as JSON (${e.message}); ignoring it`);
  }
  const { config, warnings } = validateWorkflowConfig(raw);
  return { config, warnings: warnings.map((w) => `${file}: ${w}`) };
}

if (require.main === module) process.stdout.write(JSON.stringify(readWorkflowConfig()) + '\n');

module.exports = { validateWorkflowConfig, readWorkflowConfig, workflowConfigPath, EDGE_KINDS };
