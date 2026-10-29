'use strict';

// prerequisiteHubs: hub labels (HUB0006) a hub piece must wait for because it needs files that exist only on that other hub's unmerged branch.
//
// 2026-10-23, chat plugin HUB0008-03 needed accounts.py from HUB0006's held branch. A dependsOn on that hub would not hold it: isDependencySatisfied ->
// nestedHubBuilt releases a dependsOn on a coordinating hub as soon as its pieces are all BUILT, but the piece drafts off origin/<main> plus its OWN hub
// branch, so only a MERGE of the other hub helps. A hub is merged when its record has left queue/coordinating/ (the coordinator sweep moves it to done/ once
// every piece is merged), so a label is unmet exactly while a coordinating record carries it.
//
// Fails open on purpose: a label that matches no coordinating record (typo, hub from another pipeline, already finished) holds nothing; a hold older than
// 7 days (measured from the task's createdAt) is ignored so a mislabelled prerequisite can never freeze a piece for good; the piece's own hub is ignored.

const fs = require('fs');
const path = require('path');

const LABEL_RE = /^HUB\d+$/;
const HOLD_MAX_MS = 7 * 24 * 3600 * 1000;

// -> sorted-unique array of valid labels, or undefined when there are none.
function validPrerequisiteHubs(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [...new Set(value.filter((l) => typeof l === 'string' && LABEL_RE.test(l.trim())).map((l) => l.trim()))];
  return out.length ? out : undefined;
}

// task: the candidate (prerequisiteHubs, createdAt, parentHub). -> labels still waiting on a merge.
function unmetPrerequisiteHubs(pipelineDir, task, nowMs = Date.now()) {
  const labels = validPrerequisiteHubs(task && task.prerequisiteHubs);
  if (!labels) return [];
  const created = Date.parse(task.createdAt);
  if (Number.isFinite(created) && nowMs - created > HOLD_MAX_MS) return [];
  const own = task && typeof task.parentHub === 'string' ? task.parentHub : (task.promptContext && task.promptContext.decomposedFrom) || null;
  const dir = path.join(pipelineDir, 'queue', 'coordinating');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const open = new Set();
  for (const name of names) {
    let hub;
    try { hub = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (hub && hub.hubLabel && hub.id !== own) open.add(hub.hubLabel);
  }
  return labels.filter((l) => open.has(l));
}

module.exports = { HOLD_MAX_MS, validPrerequisiteHubs, unmetPrerequisiteHubs };
