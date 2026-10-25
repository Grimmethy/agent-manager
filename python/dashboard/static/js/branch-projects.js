'use strict';

// Project labelling for the Unmerged Branches tab (backend: python/dashboard/branch_projects.py, `?projects=all`).
// Kept out of branches-joblist-hardware-tabs.js on purpose (hot file) -- that file only calls the helpers below.
// Pure string/array functions, no DOM, so they are testable from Node. Rows without a `project` tag (the plain
// active-project list) count as the active project.

const BRANCHES_URL = '/api/git/unmerged-branches?projects=all';
// Labels of registered projects the server has not finished scanning yet (response header); the tab's own poll picks them up.
let branchProjectsPending = [];

function _bpEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function branchIsActiveProject(b) {
  return !b || !b.project || b.project.active === true;
}

// One identity per branch: two projects can both hold agent/triage-queue.
function branchRowKey(b) {
  return `${(b.project && b.project.repoRoot) || ''}|${b.branch}`;
}

// Same label -> same color every time and on every page (a hash, not a palette index that shifts when a project is added).
function branchProjectHue(label) {
  let h = 0;
  for (const ch of String(label || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function branchProjectChipHtml(b) {
  const p = (b && b.project) || null;
  if (!p) return '';
  const hue = branchProjectHue(p.label);
  return `<span class="badge" data-project-chip="${_bpEscape(p.label)}" style="background:hsl(${hue} 55% 32%);color:#fff;font-weight:600"`
    + ` title="Project: ${_bpEscape(p.label)}${p.active ? ' (active project)' : ''}\n${_bpEscape(p.repoRoot)}">${_bpEscape(p.label)}${p.active ? ' ● active' : ''}</span>`;
}

// Consecutive runs of the same project, in the order the server sent them (active project first).
function groupBranchesByProject(branches) {
  const groups = [];
  for (const b of branches) {
    const label = (b.project && b.project.label) || '';
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.branches.push(b);
    else groups.push({ label, project: b.project || null, branches: [b] });
  }
  return groups;
}

function branchProjectHeaderHtml(group) {
  const p = group.project;
  const hue = branchProjectHue(p.label);
  const n = group.branches.length;
  return `<div data-project-header="${_bpEscape(p.label)}" style="margin:18px 0 8px;padding:6px 10px;border-radius:6px;background:hsl(${hue} 55% 32%);color:#fff;display:flex;gap:10px;align-items:baseline">`
    + `<strong>${_bpEscape(p.label)}</strong>${p.active ? '<span>● active project</span>' : ''}`
    + `<span style="opacity:.8">${n} branch${n === 1 ? '' : 'es'}</span>`
    + `<span style="opacity:.6;font-family:monospace;font-size:11px;margin-left:auto">${_bpEscape(p.repoRoot)}</span></div>`;
}

// Headers only earn their space when more than one project is on screen.
function branchListWithProjectHeadersHtml(branches, cardHtml) {
  const groups = groupBranchesByProject(branches);
  if (groups.length <= 1 && (!groups[0] || !groups[0].project || groups[0].project.active)) return branches.map(cardHtml).join('');
  return groups.map((g) => (g.project ? branchProjectHeaderHtml(g) : '') + g.branches.map(cardHtml).join('')).join('');
}

function branchProjectsPendingHtml(pending) {
  const list = Array.isArray(pending) ? pending.filter(Boolean) : [];
  if (!list.length) return '';
  return `<div class="meta" data-projects-pending style="margin:0 0 10px">Still scanning ${list.length} other project${list.length === 1 ? '' : 's'} for branches: ${list.map(_bpEscape).join(', ')} -- they appear here as each finishes.</div>`;
}

// Merge/discard/verdict act on the card's OWN project: the buttons carry the project's repoRoot (empty for the active project) and the request appends
// ?project=<repoRoot>, which the server resolves against the registry (an unknown project is a 404, never a fallback to the active one).
function branchProjectRequestRoot(b) {
  return branchIsActiveProject(b) ? '' : ((b.project && b.project.repoRoot) || '');
}

function branchActionUrl(branch, action, project) {
  return `/api/git/branches/${encodeURIComponent(branch)}/${action}` + (project ? `?project=${encodeURIComponent(project)}` : '');
}

// Discard permanently deletes a remote branch and merge pushes to a project's main: a card from another project says so in the confirm.
function branchConfirmWithProject(message, btn) {
  const root = btn && btn.dataset && btn.dataset.project;
  if (!root) return message;
  const row = btn.closest && btn.closest('[data-branch-row]');
  const chip = row && row.querySelector && row.querySelector('[data-project-chip]');
  const label = (chip && chip.dataset && chip.dataset.projectChip) || root;
  return `PROJECT: ${label}\n(not the active project -- this runs in ${root})\n\n${message}`;
}

// Same as fetchJson (core-ui.js) but also reads which projects the server is still scanning.
async function fetchBranchList() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let r;
  try {
    r = await fetch(BRANCHES_URL, { signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(BRANCHES_URL + ' -> timed out after 30s');
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!r.ok) throw new Error(BRANCHES_URL + ' -> ' + r.status);
  branchProjectsPending = (r.headers.get('X-Branch-Projects-Pending') || '').split(',').filter(Boolean);
  return r.json();
}

if (typeof module !== 'undefined') module.exports = { branchIsActiveProject, branchRowKey, branchProjectHue, branchProjectChipHtml, groupBranchesByProject, branchProjectHeaderHtml, branchListWithProjectHeadersHtml, branchProjectsPendingHtml, branchProjectRequestRoot, branchActionUrl, branchConfirmWithProject };
