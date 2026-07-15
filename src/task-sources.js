'use strict';

// Picks the next unit of work for the drafting daemon. The local model has no filesystem
// access, so every task JSON written here is self-contained: it embeds the actual file
// text a prompt will need, rather than a path the model could never read on its own.
//
// This package ships 6 generic, project-agnostic sources at priorities 10/20/40/70/80/90.
// Priorities 30/50/60 are deliberately left open -- a consumer project registers its own
// domain-specific sources there via registerTaskSource (see README.md), so the combined
// priority order reads as one coherent backlog without renumbering anything.

const fs = require('fs');
const path = require('path');
const { registerTaskSource, getRegisteredSources } = require('./task-source-registry.js');
const { getConfig } = require('./config.js');

function slugifyForId(str) {
  return str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

const QUEUE_STATES = ['pending', 'drafting', 'review', 'blocked', 'done'];

// A claimed task lives at queue/drafting/<InstanceId>/<id>.json, not queue/drafting/<id>.json
// directly (a per-instance claim subfolder) -- every task source shares this function, so a
// task actively being drafted is correctly seen as already-queued, not regenerated.
function taskIdExistsInQueue(id) {
  const { pipelineDir } = getConfig();
  const queueDir = path.join(pipelineDir, 'queue');
  return QUEUE_STATES.some((state) => {
    if (state !== 'drafting') return fs.existsSync(path.join(queueDir, state, `${id}.json`));

    const draftingDir = path.join(queueDir, 'drafting');
    if (fs.existsSync(path.join(draftingDir, `${id}.json`))) return true; // legacy: no subfolder
    let entries;
    try {
      entries = fs.readdirSync(draftingDir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries
      .filter((e) => e.isDirectory())
      .some((e) => fs.existsSync(path.join(draftingDir, e.name, `${id}.json`)));
  });
}

// --- Source: queue/adhoc/, a manually-submitted one-off task (priority 10) --------------
//
// Lets a human or an orchestrating agent hand this pipeline a specific task right now,
// outside all deterministic sources below. Submitted via queue-adhoc-task.js, which writes
// a complete task JSON into queue/adhoc/. Picks the oldest file (by mtime) whose id isn't
// already queued; a malformed file or one missing a valid id is skipped, not fatal.
// domain/source are always forced to 'adhoc'/'manual' regardless of what the file itself
// says, since a hand-edited file could claim anything -- this is the pipeline's fixed
// contract for this source.
function nextAdhocTask() {
  const { pipelineDir } = getConfig();
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  let entries;
  try {
    entries = fs.readdirSync(adhocDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => {
      const full = path.join(adhocDir, e.name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);

  for (const f of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(f.full, 'utf8'));
    } catch {
      continue;
    }

    if (!parsed || typeof parsed.id !== 'string' || !parsed.id.trim()) continue;

    const id = parsed.id.trim();
    if (taskIdExistsInQueue(id)) continue;

    return {
      id,
      domain: 'adhoc',
      source: 'manual',
      title: parsed.title ?? `Adhoc task: ${id}`,
      promptContext: parsed.promptContext,
    };
  }

  return null;
}

// --- Source: a project's own issue-tracker doc, entries flagged ready-for-agent (priority 20) --
//
// Only a hard body-length ceiling is auto-queued -- an oversized entry isn't narrow enough
// to hand an LLM unattended and still needs a human to split it.
const MAX_TROUBLE_LOG_TASK_CHARS = 4000;

function nextTroubleLogTask() {
  const { troubleLogPath } = getConfig();
  const text = readIfExists(troubleLogPath);
  if (!text) return null;

  // Section boundaries: an entry starts at a "### " heading and ends at the next
  // "\n### " (next entry) or "\n## " (chapter heading), whichever comes first, or EOF.
  const sections = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('### ', pos);
    if (start === -1) break;

    const nextH2 = text.indexOf('\n## ', start + 3);
    const nextH3 = text.indexOf('\n### ', start + 3);
    let end;
    if (nextH2 !== -1 && nextH3 !== -1) {
      end = Math.min(nextH2, nextH3);
    } else if (nextH2 !== -1) {
      end = nextH2;
    } else if (nextH3 !== -1) {
      end = nextH3;
    } else {
      end = -1; // no more boundaries — take to EOF
    }

    const sectionText = end === -1 ? text.slice(start) : text.slice(start, end);
    sections.push(sectionText);
    // Resume AT the terminating newline (end + 1 is the "#" of the next heading) so the
    // next indexOf('### ') can match it — advancing further silently drops every other entry.
    pos = end === -1 ? text.length : end + 1;
  }

  for (const section of sections) {
    const headingLine = section.split('\n')[0];
    if (!headingLine.includes('🤖')) continue; // not ready-for-agent

    // Heading shape: "### 🤖 T-059 · Some title"
    const idMatch = headingLine.match(/T-\d+/);
    if (!idMatch) continue;
    const ticketId = idMatch[0];

    if (section.length > MAX_TROUBLE_LOG_TASK_CHARS) continue;

    const taskId = 'trouble-log-' + ticketId.toLowerCase();
    if (taskIdExistsInQueue(taskId)) continue;

    const titleMatch = headingLine.match(/T-\d+\s*·\s*(.+)/);
    const titleText = (titleMatch ? titleMatch[1] : headingLine.replace(/^###\s*/, '')).replace(/🤖/g, '').trim();

    return {
      id: taskId,
      domain: 'taxharvest',
      source: 'trouble_log',
      title: `${ticketId} · ${titleText}`,
      promptContext: {
        ticketId,
        title: titleText,
        body: section,
      },
    };
  }

  return null;
}

// --- Source: SecondBrain-style inbox, oldest unprocessed note (priority 40) -------------
function nextSecondBrainTask() {
  const { secondBrainDir } = getConfig();
  if (!secondBrainDir) return null;

  const inboxDir = path.join(secondBrainDir, 'Inbox');
  let entries;
  try {
    entries = fs.readdirSync(inboxDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const notes = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')
      && !e.name.toLowerCase().startsWith('ornith live log'))
    .map((e) => {
      const full = path.join(inboxDir, e.name);
      return { name: e.name, full, mtime: fs.statSync(full).mtimeMs };
    })
    .filter((n) => !fs.existsSync(`${n.full}.done`))
    .sort((a, b) => a.mtime - b.mtime);

  if (notes.length === 0) return null;
  const note = notes[0];
  const id = `secondbrain-${note.name.replace(/\.md$/, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}`;
  if (taskIdExistsInQueue(id)) return null;

  return {
    id,
    domain: 'secondbrain',
    source: 'inbox',
    title: `SecondBrain inbox: ${note.name}`,
    promptContext: {
      notePath: note.full,
      noteContent: readIfExists(note.full),
    },
  };
}

// --- Source: an architecture-candidates doc, lowest-priority-but-one backlog (priority 70) --
//
// This backlog isn't deterministically enumerable from repo state; it's replenished by
// arch_discovery below. Only Strong-rated candidates are eligible for auto-queue.
const MAX_ARCH_REVIEW_TASK_CHARS = 4000;

function nextArchReviewTask() {
  const { archReviewCandidatesPath } = getConfig();
  const text = readIfExists(archReviewCandidatesPath);
  if (!text) return null;

  const sections = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('### ', pos);
    if (start === -1) break;

    const nextH2 = text.indexOf('\n## ', start + 3);
    const nextH3 = text.indexOf('\n### ', start + 3);
    let end;
    if (nextH2 !== -1 && nextH3 !== -1) {
      end = Math.min(nextH2, nextH3);
    } else if (nextH2 !== -1) {
      end = nextH2;
    } else if (nextH3 !== -1) {
      end = nextH3;
    } else {
      end = -1;
    }

    const sectionText = end === -1 ? text.slice(start) : text.slice(start, end);
    sections.push(sectionText);
    pos = end === -1 ? text.length : end + 1;
  }

  for (const section of sections) {
    const headingLine = section.split('\n')[0];

    const idMatch = headingLine.match(/AC-\d+/);
    if (!idMatch) continue;
    const candidateId = idMatch[0];

    const strengthMatch = section.match(/^Strength:\s*(.+)$/m);
    if (!strengthMatch || strengthMatch[1].trim() !== 'Strong') continue;

    if (section.length > MAX_ARCH_REVIEW_TASK_CHARS) continue;

    const taskId = 'arch-review-' + candidateId.toLowerCase();
    if (taskIdExistsInQueue(taskId)) continue;

    const titleMatch = headingLine.match(/AC-\d+\s*·\s*(.+)/);
    const titleText = (titleMatch ? titleMatch[1] : headingLine.replace(/^###\s*/, '')).trim();

    let filesArray = [];
    const filesMatch = section.match(/^Files:\s*(.+)$/m);
    if (filesMatch) {
      filesArray = filesMatch[1].split(',').map((f) => f.trim());
    }

    return {
      id: taskId,
      domain: 'taxharvest',
      source: 'arch_review',
      title: `${candidateId} · ${titleText}`,
      promptContext: {
        candidateId,
        title: titleText,
        files: filesArray,
        body: section,
      },
    };
  }

  return null;
}

// --- Source: arch_discovery — generates new candidates for one graphify community at a time (priority 80) --
//
// Deliberately placed AFTER arch_review (the consumer): new candidates are only generated
// once there's nothing left to consume, so this never piles up junk faster than arch_review
// can drain it. The model has no filesystem access, so every real file this needs is read
// here and embedded verbatim into promptContext.
const ARCH_DISCOVERY_CONTEXT_BUDGET_CHARS = 60000;

function nextArchDiscoveryTask() {
  const { repoRoot, communityCoveragePath, graphPath, archReviewCandidatesPath } = getConfig();
  const coverageText = readIfExists(communityCoveragePath);
  if (!coverageText) return null;

  let coverage;
  try {
    coverage = JSON.parse(coverageText);
  } catch {
    return null;
  }
  if (!coverage || !Array.isArray(coverage.communities) || coverage.communities.length === 0) return null;

  // Oldest lastReviewedAt first; null (never reviewed) sorts before any real timestamp.
  const sorted = [...coverage.communities].sort((a, b) => {
    const at = a.lastReviewedAt ? Date.parse(a.lastReviewedAt) : -Infinity;
    const bt = b.lastReviewedAt ? Date.parse(b.lastReviewedAt) : -Infinity;
    return at - bt;
  });
  const chosen = sorted.find((c) => !taskIdExistsInQueue('arch-discovery-community-' + c.id));
  if (!chosen) return null; // every community already has an in-flight or terminal task

  const graphText = readIfExists(graphPath);
  if (!graphText) return null;

  let graph;
  try {
    graph = JSON.parse(graphText);
  } catch {
    return null;
  }
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) return null;

  const memberNodes = graph.nodes.filter((n) => n.community === chosen.id);
  if (memberNodes.length === 0) return null;

  // Degree = how many times a node's id appears as EITHER end of ANY link in the whole
  // graph, not just links within this community — a file's real architectural weight
  // includes its cross-community connections.
  const degreeByNodeId = {};
  for (const link of graph.links) {
    degreeByNodeId[link.source] = (degreeByNodeId[link.source] || 0) + 1;
    degreeByNodeId[link.target] = (degreeByNodeId[link.target] || 0) + 1;
  }

  const degreeByFile = {};
  for (const node of memberNodes) {
    if (!node.source_file) continue;
    degreeByFile[node.source_file] = (degreeByFile[node.source_file] || 0) + (degreeByNodeId[node.id] || 0);
  }
  const rankedFiles = Object.entries(degreeByFile).sort((a, b) => b[1] - a[1]);

  const files = [];
  let budgetUsed = 0;
  for (const [sourceFile, degree] of rankedFiles) {
    const content = readIfExists(path.join(repoRoot, sourceFile));
    if (content == null) continue; // skip unreadable/missing files, never throw
    if (budgetUsed + content.length > ARCH_DISCOVERY_CONTEXT_BUDGET_CHARS) break;
    files.push({ path: sourceFile, degree, content });
    budgetUsed += content.length;
  }

  const candidatesTail = readIfExists(archReviewCandidatesPath);
  const existingCandidatesTail = candidatesTail ? candidatesTail.slice(-4000) : '';

  return {
    id: 'arch-discovery-community-' + chosen.id,
    domain: 'taxharvest',
    source: 'arch_discovery',
    title: 'Architecture discovery: ' + chosen.name,
    promptContext: {
      communityId: chosen.id,
      communityName: chosen.name,
      files,
      existingCandidatesTail,
    },
  };
}

// --- Source: queue/dead-code-flags.json, absolute lowest priority (priority 90) ---------
//
// A separate scanner script flags exported symbols with low real call-site counts (call
// sites are attached so the downstream judgment is "genuine dead code vs. false positive,"
// not a bare tool verdict). Lower priority than even the architecture backlog: this is
// pure speculative cleanup.
function nextUnusedExportTask() {
  const { pipelineDir } = getConfig();
  const flagsPath = path.join(pipelineDir, 'queue', 'dead-code-flags.json');
  let entries;
  try {
    const raw = readIfExists(flagsPath);
    if (!raw) return null;
    entries = JSON.parse(raw);
  } catch {
    return null;
  }

  entries.sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt));

  for (const entry of entries) {
    const taskId = `deadcode-${slugifyForId(entry.symbol)}-${slugifyForId(entry.definedIn)}`;
    if (taskIdExistsInQueue(taskId)) continue;

    return {
      id: taskId,
      domain: 'taxharvest',
      source: 'deadcode_triage',
      title: `Triage dead-code candidate: ${entry.symbol} (defined in ${entry.definedIn}) — ${entry.callSites.length} call site(s) found`,
      promptContext: {
        symbol: entry.symbol,
        definedIn: entry.definedIn,
        callSites: entry.callSites,
        note: 'Judge genuine-dead vs false-positive (barrel/re-export, factory pattern, etc.). Use a majority-vote judgment, not a single verdict.',
      },
    };
  }

  return null;
}

registerTaskSource('adhoc', { priority: 10, next: nextAdhocTask });
registerTaskSource('trouble_log', { priority: 20, next: nextTroubleLogTask });
registerTaskSource('secondbrain', { priority: 40, next: nextSecondBrainTask });
registerTaskSource('arch_review', { priority: 70, next: nextArchReviewTask });
registerTaskSource('arch_discovery', { priority: 80, next: nextArchDiscoveryTask });
registerTaskSource('unused_export', { priority: 90, next: nextUnusedExportTask });

function getNextTask() {
  for (const source of getRegisteredSources()) {
    if (typeof source.next !== 'function') continue;
    const task = source.next();
    if (task) return task;
  }
  return null;
}

function writeTask(task) {
  const { pipelineDir } = getConfig();
  const dir = path.join(pipelineDir, 'queue', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${task.id}.json`);
  const record = {
    ...task,
    status: 'pending',
    createdAt: new Date().toISOString(),
    history: [{ status: 'pending', at: new Date().toISOString() }],
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

module.exports = {
  getNextTask, writeTask, taskIdExistsInQueue,
  nextTroubleLogTask, nextAdhocTask, nextSecondBrainTask,
  nextArchReviewTask, nextArchDiscoveryTask, nextUnusedExportTask,
};
