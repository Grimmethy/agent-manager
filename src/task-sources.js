'use strict';

// Picks the next unit of work for the drafting daemon. The local model has no filesystem
// access, so every task JSON written here is self-contained: it embeds the actual file
// text a prompt will need, rather than a path the model could never read on its own.
//
// This package ships 10 generic, project-agnostic sources at priorities
// 10/20/40/70/71/80/81/82/85/90. Priorities 30/50/60 are deliberately left open -- a consumer
// project registers its own domain-specific sources there via registerTaskSource (see
// README.md), so the combined priority order reads as one coherent backlog without
// renumbering anything.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { registerTaskSource, getRegisteredSources } = require('./task-source-registry.js');
const { reasoningTierFor } = require('./model-provider.js');
const { getConfig } = require('./config.js');
const { applyArchDiscoveryCandidates, applyArchImportCandidate, applyVerdictOnly } = require('./apply-group-a.js');
const { applyAdhocDiff } = require('./apply-adhoc-diff.js');
const { scanProject, isLikelyMinified } = require('./observability-scan.js');
const { scanProject: scanProjectForPerformance } = require('./performance-scan.js');
const { isOnline } = require('./connectivity-check.js');
const { appendHistoryEvent } = require('./task-history.js');
const { findAuditClusters, buildAuditTask } = require('./pipeline-self-audit.js');

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

const QUEUE_STATES = ['pending', 'drafting', 'review', 'approved', 'blocked', 'done'];

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

// Lightweight DAG-readiness check (agent-engine's TaskGraph pattern, adapted 2026-07-26,
// ahead of real need -- no built-in task source declares `deps` today, since every one
// generates fully independent units of work; this exists so a future task source CAN
// declare `deps: [taskId, ...]` and have the worker's claim order actually respect it, once
// running more than one worker process is a genuine throughput win rather than several
// processes contending for one loaded model).
//
// A task with no deps (the default, and every real task today) is always ready. Otherwise
// every listed dep must have reached queue/done/<depId>.json specifically -- not "exists
// anywhere in the queue" (taskIdExistsInQueue's question), a materially different question
// ("did the thing I depend on finish SUCCESSFULLY") from "is something already working on
// this exact id" (taskIdExistsInQueue's job, used to avoid re-generating a duplicate).
function isTaskReady(task, pipelineDir) {
  const deps = task && Array.isArray(task.deps) ? task.deps : [];
  if (deps.length === 0) return true;
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  return deps.every((depId) => fs.existsSync(path.join(doneDir, `${depId}.json`)));
}

// CLI mode (`node task-sources.js --pending-readiness`, mirrors --priority-map): computes
// isTaskReady() for every task currently sitting in pending/, so ornith-worker.ps1's claim
// order can skip a not-yet-ready task without re-implementing this check in PowerShell.
function pendingReadinessMap() {
  const { pipelineDir } = getConfig();
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  const map = {};
  let files;
  try {
    files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json'));
  } catch {
    return map;
  }
  for (const f of files) {
    const id = f.slice(0, -'.json'.length);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(path.join(pendingDir, f), 'utf8'));
    } catch {
      map[id] = true; // malformed file -- do not let a readiness bug block an otherwise-claimable task
      continue;
    }
    map[id] = isTaskReady(task, pipelineDir);
  }
  return map;
}

// CLI mode (`node task-sources.js --pending-tier-counts`, mirrors --pending-readiness):
// counts how many tasks currently sitting in pending/ resolve to each reasoningTierFor()
// tier ('low'/'high'). Added 2026-08-18 for the model-swap-thrashing guard (Grimmethy:
// "make sure that all the tasks that the currently loaded model has available to them is
// completed before switching to the next model") -- a worker about to swap Ollama's
// resident model calls this first to check whether the model it would be EVICTING still
// has claimable work waiting, so it can yield instead of forcing a swap mid-backlog. Same
// "compute it once in JS, consume it from bash" split pendingReadinessMap() already uses.
function pendingTierCounts() {
  const { pipelineDir } = getConfig();
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  const counts = { low: 0, high: 0 };
  let files;
  try {
    files = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json'));
  } catch {
    return counts;
  }
  for (const f of files) {
    let task;
    try {
      task = JSON.parse(fs.readFileSync(path.join(pendingDir, f), 'utf8'));
    } catch {
      continue; // malformed file -- doesn't count as claimable work for either tier
    }
    const tier = reasoningTierFor(task);
    counts[tier] = (counts[tier] || 0) + 1;
  }
  return counts;
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

    // Spread the WHOLE file through, then force only the fields this source's contract
    // actually requires -- id/domain/source/title default -- rather than rebuilding a
    // fresh object from a hardcoded field list. That old shape (id/domain/source/title/
    // promptContext only) already burned this exact class of bug once: a 2026-07-25 fix
    // had to special-case preDrafted/implementResponse back in by hand after they were
    // found silently dropped (see the live incident that fix's own comment described).
    // The same bug, unnoticed until now, also drops `history` -- which matters here
    // specifically because api_task_resolve_clarification (python/dashboard/app.py) moves
    // an ALREADY-HELD task's real file (with its full held/resolved history) straight
    // into queue/adhoc/ expecting nextAdhocTask() to pick up that SAME task and continue
    // it, not originate a brand-new one. Confirmed live 2026-08-19: a task genuinely held
    // for clarification, then resolved, showed up down the pipeline with a history of
    // exactly one entry ("created"), with zero trace it had ever gone through
    // clarification at all -- every field on the resolved file except id/domain/source/
    // title/promptContext was silently discarded the moment this function claimed it.
    // domain/source/id still can't be trusted from the file (a hand-edited one could claim
    // anything) -- those three are force-overridden AFTER the spread specifically so
    // nothing in the file can win against this source's fixed contract, while everything
    // else (history, createdAt, preDrafted, implementResponse, planResponse, ...) now
    // passes through unconditionally instead of needing its own one-off carve-out.
    return {
      ...parsed,
      id,
      domain: 'adhoc',
      source: 'manual',
      title: parsed.title ?? `Adhoc task: ${id}`,
    };
  }

  return null;
}

// --- Source: research_task (Brain Dump #1 follow-up, 2026-08-17) -- notes brain_dump_sort
// classified as requiresResearch land here (queue/research/), same shape as queue/adhoc/
// but consumed by research-agentic-draft.js's WebSearch/WebFetch-backed agentic call
// instead of adhoc-agentic-draft.js's code-repo one -- see task-source-registry.js's
// registerTaskSource('research_task', ...) below.
function nextResearchTask() {
  const { pipelineDir } = getConfig();
  const researchDir = path.join(pipelineDir, 'queue', 'research');
  let entries;
  try {
    entries = fs.readdirSync(researchDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => {
      const full = path.join(researchDir, e.name);
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

    // Only ever written by applyBrainDumpSort's requiresResearch branch, unlike
    // queue/adhoc/ (which has several producers -- CLI, dashboard, brain_dump_sort) --
    // trusted to already be shaped correctly, no need to reconstruct a fresh object from
    // a handful of known-safe fields the way nextAdhocTask() does.
    return {
      id,
      domain: 'research',
      source: 'research_task',
      title: parsed.title ?? `Research task: ${id}`,
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
  const { troubleLogPath, defaultDomain } = getConfig();
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
      domain: defaultDomain,
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

// Shared by arch_review (candidatesPath=archReviewCandidatesPath) and arch_import_review
// (candidatesPath=archImportCandidatesPath) -- both consume an identically-shaped
// "### AC-NNN · Title / Strength: ... / Files: ..." candidates doc and turn the oldest
// Strong one into a real fulfillment task, differing only in WHICH doc and what `source`
// gets stamped on the resulting task. Was nextArchReviewTask() until ADR-0020's
// arch_import_review needed the exact same logic against a second doc -- parameterized
// instead of copy-pasting a second near-identical function that would inevitably drift
// (see this whole session's running theme of exactly that happening elsewhere).
function nextCandidateFulfillmentTask(candidatesPath, sourceName) {
  const { defaultDomain } = getConfig();
  const text = readIfExists(candidatesPath);
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

    const taskId = sourceName.replace(/_/g, '-') + '-' + candidateId.toLowerCase();
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
      domain: defaultDomain,
      source: sourceName,
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
// Was 60000, same bug and same fix as DEEP_DIVE_CONTEXT_BUDGET_CHARS below (see its
// comment) -- nearly double ornith-client.js's num_ctx=8192 default, which arch_discovery's
// plan call never overrides. Hadn't yet triggered a live degenerate-empty failure the way
// deep_dive's did, but the same overflow risk existed regardless.
const ARCH_DISCOVERY_CONTEXT_BUDGET_CHARS = 24000;

function nextArchDiscoveryTask() {
  const { repoRoot, communityCoveragePath, graphPath, archReviewCandidatesPath, defaultDomain } = getConfig();
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
    domain: defaultDomain,
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

// --- Source: project_search — proposes external open-source leads for the active project
// (priority 85, between arch_discovery's 80 and unused_export's 90) ----------------------
//
// See ADR-0018 and docs/project-search-pipeline.md for the full design. Discovery-only:
// unlike arch_discovery -> arch_review, there is deliberately NO consumer source that
// promotes a finding into a fulfillment task -- a human decides what happens to a lead.
// Pure background/exploratory filler, no hard cadence throttle (matches every other
// source's fallback-chain behavior): it only fires once every higher-priority source has
// nothing to offer. A fresh task is generated each time it's this source's turn -- there is
// no time-based dedup by design (see the grill session this was designed in); dedup against
// already-known leads happens via the INDEX.md content embedded below, read by Ornith
// itself when proposing queries and synthesizing findings.
function nextProjectSearchTask() {
  // Real GitHub/HuggingFace search happens later, in ornith-draft.js's harness-fetch step
  // (project-search-fetch.js) -- but that's AFTER a plan+implement pass has already been
  // spent drafting this task. Checking connectivity here, before the task is even
  // generated, is what actually stops the "ton of blocked repo search jobs" (offline
  // 2026-08-15): no point queuing work that's guaranteed to fail its one real dependency.
  if (!isOnline()) return null;

  const { repoRoot, projectSearchIndexPath, defaultDomain } = getConfig();
  const projectTag = path.basename(repoRoot);

  const contextDoc = readIfExists(path.join(repoRoot, 'CONTEXT.md'));
  const claudeDoc = readIfExists(path.join(repoRoot, 'CLAUDE.md'));
  const projectDocs = [contextDoc, claudeDoc].filter(Boolean).join('\n\n---\n\n');
  if (!projectDocs) return null; // nothing to reason about this project's needs from -- skip rather than search blind

  const indexText = readIfExists(projectSearchIndexPath) || '';
  const knownUrls = [...indexText.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[)\]]+$/, ''));

  const id = `project-search-${slugifyForId(projectTag)}-${Date.now()}`;
  if (taskIdExistsInQueue(id)) return null;

  return {
    id,
    domain: 'project_search',
    source: 'project_search',
    title: `Search for open-source leads relevant to ${projectTag}`,
    promptContext: {
      projectTag,
      projectDocs,
      knownUrls,
    },
  };
}

// --- Source: deep_dive — dissects Strong-rated project_search leads into action items
// (priority 82, between arch_discovery's 80 and project_search's 85) --------------------
//
// See ADR-0019 and docs/deep-dive-pipeline.md for the full design. Deliberately placed
// BEFORE project_search (its own generator): draining the backlog of un-dissected Strong
// leads takes priority over finding more of them.
//
// Was 60000 (~15K tokens) -- confirmed live 2026-07-21 this was nearly double
// ornith-client.js's num_ctx=8192 default, which deep_dive's plan/implement calls never
// override. A community anywhere near the old ceiling had literally no room left in the
// context window for a response, regardless of thinking mode -- the no-think retry
// fallback (ornith-worker.ps1) helps the THINKING-budget-exhaustion failure mode, but
// can't rescue a prompt that overflows num_ctx outright before any output is generated.
// 24000 chars (~6K tokens) leaves headroom for the prompt template/instructions plus
// num_predict=1400's response reservation within the 8192 budget.
const DEEP_DIVE_CONTEXT_BUDGET_CHARS = 24000;

// Cross-references INDEX.md's table rows against its '## Notes' '### Name' subsections --
// only a Strong-rated finding gets a subsection there (see apply-group-a.js's
// applyProjectSearchFindings), so a table row with a matching heading is Strong; one
// without is Weak. There is no per-row Strength column in the rendered table itself, so
// this cross-reference is the only way to recover which leads are Strong after the fact.
//
// Also extracts the "Relevant to" column (the 3rd cell after the name/url one; table shape
// is | Project | Source | Description | Relevant to | Status |) -- nextProjectSearchTask()
// writes this as "<projectTag> -- <reason>" (Ornith fills in the reason, projectTag is
// exactly path.basename(repoRoot), same convention used everywhere else in this file), so
// the leading token before " -- " recovers which consumer project a lead was discovered
// FOR. Added 2026-07-27 after this field existed in the data but was silently discarded
// here, which is the root cause behind deep_dive/arch_import treating every lead as fair
// game for whichever project's pipeline happened to be running (see task-sources.js's
// writeTask() comment for the incident this traces back to).
function parseStrongLeadsFromIndex(indexText) {
  if (!indexText) return [];
  const notesIdx = indexText.indexOf('## Notes');
  const notesText = notesIdx === -1 ? '' : indexText.slice(notesIdx);
  const strongNames = new Set([...notesText.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim()));

  const seen = new Set();
  const leads = [];
  for (const line of indexText.split('\n')) {
    const cellMatch = line.match(/^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|(.*)$/);
    if (!cellMatch) continue;
    const [, rawName, rawUrl, restCells] = cellMatch;
    const name = rawName.trim();
    if (!strongNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    // restCells is "Source | Description | Relevant to | Status |" -- Source, Description,
    // Relevant to, Status, trailing empty string from the closing pipe, in that order.
    const cells = restCells.split('|').map((c) => c.trim());
    const relevantToCell = cells[2] || '';
    const relevantTo = relevantToCell.split(/\s*--\s*/)[0].trim() || null;
    leads.push({ name, url: rawUrl.trim(), relevantTo });
  }
  return leads;
}

// Lazy onboarding for one newly-Strong lead: clone it (shallow -- only current history is
// needed for reading, not the project's own git log) and run build_graph.py against the
// clone with --no-model-naming (see ADR-0019: naming a community here is a free heuristic,
// never a spent Ornith round-trip) and --target-dir so this repo's own graphify-out/
// graph.json is never touched. Both the clone and the graph-build are slow/blocking --
// deliberately done here, inline in the normal ornith-worker.ps1 tick, and NOT in
// queue-watchdog.ps1's tight poll loop (see docs/deep-dive-pipeline.md's "Clone management"
// section for why).
function onboardDeepDiveProject(lead, clonesDir) {
  const slug = slugifyForId(lead.name);
  const clonePath = path.join(clonesDir, slug);
  if (!fs.existsSync(clonePath)) {
    fs.mkdirSync(clonesDir, { recursive: true });
    execSync(`git clone --depth 1 "${lead.url}" "${clonePath}"`, { stdio: 'pipe' });
  }

  const graphOutPath = path.join(clonePath, '.deep-dive-graph.json');
  if (!fs.existsSync(graphOutPath)) {
    const buildGraphScript = path.join(__dirname, '..', 'python', 'build_graph.py');
    // Prefer this package's own .venv interpreter (same one launch.sh uses for the
    // dashboard: PACKAGE_ROOT/.venv/bin/python) -- that's where build_graph.py's actual
    // dependencies (networkx, per python/requirements.txt) are installed. Falls back to a
    // bare python3/python off PATH for a consumer without this exact venv layout. Two
    // stacked bugs found live 2026-08-14, both silent until now (ornith-worker.sh only
    // recently started keeping task-sources.js's stderr instead of discarding it to
    // /dev/null): (1) the original hardcoded 'python' is a Windows-ism -- most Linux
    // distros, this one included, only ever install a 'python3' binary, no 'python' alias,
    // so this failed with `/bin/sh: 1: python: not found` on every single attempt; (2) even
    // after fixing the binary name, the system-wide python3 doesn't have networkx installed
    // at all -- only this repo's own .venv does. Together, EVERY onboarding attempt for
    // EVERY real, well-grounded Strong lead that had accumulated (8 of them) failed, and
    // Scouted Repos stayed empty long after real Strong leads existed to onboard.
    const venvPython = process.platform === 'win32'
      ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
      : path.join(__dirname, '..', '.venv', 'bin', 'python');
    const pythonBin = fs.existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3');
    execSync(`"${pythonBin}" "${buildGraphScript}" --target-dir "${clonePath}" --output "${graphOutPath}" --no-model-naming`, { stdio: 'pipe' });
  }

  const graphData = JSON.parse(readIfExists(graphOutPath) || '{"nodes":[],"links":[],"communities":[]}');
  return {
    slug,
    clonePath,
    communities: (graphData.communities || []).map((c) => ({ id: c.id, name: c.name, lastReviewedAt: null, actionItemCount: null })),
  };
}

function nextDeepDiveTask() {
  const { repoRoot, projectSearchIndexPath, deepDiveCoveragePath, deepDiveClonesDir } = getConfig();
  // Same convention nextProjectSearchTask() already uses to write the "Relevant to" column
  // in the first place -- matching it here is what makes the filter below meaningful.
  const projectTag = path.basename(repoRoot);

  let coverage;
  try {
    coverage = JSON.parse(readIfExists(deepDiveCoveragePath) || '{"projects":{}}');
  } catch {
    coverage = { projects: {} };
  }
  if (!coverage.projects) coverage.projects = {};

  // Scoping fix (2026-07-27, see writeTask()'s comment for the incident): only onboard a
  // lead that was actually discovered FOR this project. Without this, deep_dive treated
  // every Strong lead in the shared ledger as fair game for whichever project's pipeline
  // happened to be running.
  const strongLeads = parseStrongLeadsFromIndex(readIfExists(projectSearchIndexPath))
    .filter((lead) => lead.relevantTo === projectTag);
  // Onboarding (below) does a real `git clone` of the lead's URL -- same offline failure
  // mode as project_search's search calls, just via git instead of https directly. Only
  // guards the clone step, not the whole function: drafting from ALREADY-onboarded
  // communities (the candidates loop further down) is pure local filesystem work and
  // stays available offline.
  const onboardingOnline = strongLeads.some((lead) => !coverage.projects[slugifyForId(lead.name)]) ? isOnline() : true;
  let coverageChanged = false;
  for (const lead of strongLeads) {
    if (!onboardingOnline) break;
    const slug = slugifyForId(lead.name);
    if (coverage.projects[slug]) continue; // already onboarded (or a prior onboarding attempt failed and will retry below)
    try {
      const onboarded = onboardDeepDiveProject(lead, deepDiveClonesDir);
      coverage.projects[slug] = {
        sourceUrl: lead.url,
        clonePath: onboarded.clonePath,
        clonedAt: new Date().toISOString(),
        communities: onboarded.communities,
        // Stamped at onboarding time so arch_import's own filter (nextArchImportTask) can
        // trace a promoted item back to which consumer project it was ever relevant to,
        // without needing to re-parse INDEX.md itself.
        relevantToProject: projectTag,
      };
      coverageChanged = true;
    } catch (e) {
      // Clone/graph-build failures (bad URL, network, python not on PATH, etc.) must never
      // crash the worker loop -- log and skip this lead for this tick; since it's still
      // absent from coverage.projects, it's retried automatically next tick.
      console.error(`deep_dive: failed to onboard "${lead.name}": ${e.message}`);
    }
  }
  if (coverageChanged) {
    fs.mkdirSync(path.dirname(deepDiveCoveragePath), { recursive: true });
    fs.writeFileSync(deepDiveCoveragePath, JSON.stringify(coverage, null, 2));
  }

  // Flatten every tracked project's communities and pick the oldest/null lastReviewedAt
  // first -- same rule nextArchDiscoveryTask() uses, just flattened across multiple
  // projects instead of one repo (see docs/deep-dive-pipeline.md). Hotlisted projects
  // (dashboard's Scouted Repos checkbox, toggled via /api/deep-dive/projects/<slug>/hotlist)
  // win the tiebreak first, ahead of the normal oldest-first rule -- every remaining
  // community in a hotlisted project drafts before any community in a non-hotlisted one,
  // regardless of how long that other project has been waiting in rotation.
  //
  // Only this project's own onboarded entries are eligible (relevantToProject match) --
  // an entry with NO relevantToProject at all predates this fix (2026-07-27) and is
  // deliberately excluded rather than guessed at: it sat in the shared coverage file before
  // any project association was tracked, so there's no reliable way to know which project
  // it was really for. Known consequence, not chased further here: the real backlog of
  // already-onboarded external projects from before this fix will sit idle until manually
  // re-tagged (or re-discovered fresh by project_search under the new scoping) rather than
  // being silently guessed into whichever project happens to run next.
  const candidates = [];
  for (const [slug, proj] of Object.entries(coverage.projects)) {
    if (proj.relevantToProject !== projectTag) continue;
    for (const community of proj.communities || []) {
      candidates.push({ slug, proj, community, hotlist: !!proj.hotlist });
    }
  }
  candidates.sort((a, b) => {
    if (a.hotlist !== b.hotlist) return a.hotlist ? -1 : 1;
    const at = a.community.lastReviewedAt ? Date.parse(a.community.lastReviewedAt) : -Infinity;
    const bt = b.community.lastReviewedAt ? Date.parse(b.community.lastReviewedAt) : -Infinity;
    return at - bt;
  });

  const chosen = candidates.find((c) => !taskIdExistsInQueue(`deep-dive-${c.slug}-${c.community.id}`));
  if (!chosen) return null; // every known community already has an in-flight or terminal task

  const { slug, proj, community } = chosen;
  const graphPath = path.join(proj.clonePath, '.deep-dive-graph.json');
  const graphData = JSON.parse(readIfExists(graphPath) || '{"nodes":[],"links":[]}');
  const memberNodes = (graphData.nodes || []).filter((n) => n.community === community.id);
  if (memberNodes.length === 0) return null;

  // Same degree-by-file, budget-capped file selection as nextArchDiscoveryTask() -- see
  // ARCH_DISCOVERY_CONTEXT_BUDGET_CHARS's own comment for the reasoning; deep_dive reuses
  // the identical convention rather than inventing a second one.
  const degreeByNodeId = {};
  for (const link of graphData.links || []) {
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
    const content = readIfExists(path.join(proj.clonePath, sourceFile));
    if (content == null) continue;
    if (budgetUsed + content.length > DEEP_DIVE_CONTEXT_BUDGET_CHARS) break;
    files.push({ path: sourceFile, degree, content });
    budgetUsed += content.length;
  }

  const lead = strongLeads.find((l) => slugifyForId(l.name) === slug);

  return {
    id: `deep-dive-${slug}-${community.id}`,
    domain: 'deep_dive',
    source: 'deep_dive',
    title: `Deep dive: ${lead ? lead.name : slug} — ${community.name}`,
    promptContext: {
      projectSlug: slug,
      projectName: lead ? lead.name : slug,
      communityId: community.id,
      communityName: community.name,
      files,
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
  const { pipelineDir, defaultDomain } = getConfig();
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
      domain: defaultDomain,
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

// --- Source: observability_review -- flags observability-hygiene issues in projects
// already onboarded by deep_dive (priority 80, alongside arch_discovery) ----------------
//
// Project idea "OpenTelemetry-Observability-Idea" (2026-07-26): rides on deep_dive's
// coverage file (deepDiveCoveragePath) for its project list/clonePaths rather than
// cloning its own copies -- deep_dive already does the slow clone+graph-build step inline
// per tick, duplicating that here would double the clone traffic for no benefit. This
// source only reads that file, never writes it.
//
// observability-scan.js is a pure deterministic scanner (no LLM, see its own header
// comment) -- running it is fast enough to do inline, same reasoning as deep_dive's own
// onboarding step. Each project is scanned exactly once (tracked in
// observabilityCoveragePath, a small sibling of deep-dive-coverage.json); findings
// accumulate in queue/observability-flags.json and are handed to Ornith one at a time,
// oldest first, for the same genuine-issue-vs-false-positive judgment
// nextUnusedExportTask() already uses for dead-code candidates.
function nextObservabilityReviewTask() {
  const { pipelineDir, defaultDomain, deepDiveCoveragePath, observabilityCoveragePath } = getConfig();

  let deepDiveCoverage;
  try {
    deepDiveCoverage = JSON.parse(readIfExists(deepDiveCoveragePath) || '{"projects":{}}');
  } catch {
    deepDiveCoverage = { projects: {} };
  }
  const deepDiveProjects = deepDiveCoverage.projects || {};

  let coverage;
  try {
    coverage = JSON.parse(readIfExists(observabilityCoveragePath) || '{"projects":{}}');
  } catch {
    coverage = { projects: {} };
  }
  if (!coverage.projects) coverage.projects = {};

  const flagsPath = path.join(pipelineDir, 'queue', 'observability-flags.json');
  let flags;
  try {
    flags = JSON.parse(readIfExists(flagsPath) || '[]');
  } catch {
    flags = [];
  }

  let coverageChanged = false;
  let flagsChanged = false;
  for (const [slug, proj] of Object.entries(deepDiveProjects)) {
    if (coverage.projects[slug]) continue; // already scanned once
    if (!proj.clonePath || !fs.existsSync(proj.clonePath)) continue;
    try {
      flags.push(...scanProject(proj.clonePath, slug));
      flagsChanged = true;
    } catch (e) {
      // A scan failure (unreadable file, scanner bug on unusual input) must never crash
      // the worker loop -- same rule onboardDeepDiveProject's own try/catch follows. Mark
      // it scanned anyway so a persistently-broken project doesn't retry every tick forever.
      console.error(`observability_review: failed to scan "${slug}": ${e.message}`);
    }
    coverage.projects[slug] = { scannedAt: new Date().toISOString() };
    coverageChanged = true;
  }
  if (coverageChanged) {
    fs.mkdirSync(path.dirname(observabilityCoveragePath), { recursive: true });
    fs.writeFileSync(observabilityCoveragePath, JSON.stringify(coverage, null, 2));
  }
  if (flagsChanged) {
    fs.mkdirSync(path.dirname(flagsPath), { recursive: true });
    fs.writeFileSync(flagsPath, JSON.stringify(flags, null, 2));
  }

  const sorted = [...flags].sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt));
  for (const finding of sorted) {
    const taskId = `observability-${slugifyForId(finding.projectSlug)}-${slugifyForId(finding.rule)}-${slugifyForId(finding.file || 'repo')}-${finding.line || 0}`;
    if (taskIdExistsInQueue(taskId)) continue;

    // Attach a small surrounding-source snippet for context, same reasoning as
    // nextUnusedExportTask's callSites: a bare rule/file/line claim is exactly the kind of
    // "unverified claim" a triage judgment shouldn't be asked to trust blindly.
    let snippet = null;
    const proj = finding.file && deepDiveProjects[finding.projectSlug];
    if (proj && proj.clonePath) {
      const content = readIfExists(path.join(proj.clonePath, finding.file));
      // Re-check isLikelyMinified against the file's CURRENT content, not just at scan
      // time -- flags.json is a persistent queue, appended once per project the first
      // time it's scanned and never touched again (see the "already scanned once" skip
      // above), so a flag generated by an older scanner run stays queueable forever even
      // after scanProject's own minified-file skip is fixed. Confirmed live 2026-08-19:
      // 26 performance_review + a much larger observability_review backlog in
      // queue/blocked/ were ALL flags scanned hours before 082346c ("Skip minified/
      // bundled build output in observability + performance scans") landed, then drained
      // into new, still-doomed tasks for a full day afterward -- the scan-time fix was
      // correct but did nothing for a flags file that was already stale by the time it
      // shipped. This is the self-healing half: any flag whose target is minified NOW is
      // dropped here regardless of when or why it got into the file, so this class of bug
      // can't recur even if a future scanner rule change reintroduces a similar gap.
      if (content && isLikelyMinified(content)) continue;
      if (content) {
        const lines = content.split('\n');
        const start = Math.max(0, (finding.line || 1) - 4);
        const end = Math.min(lines.length, (finding.line || 1) + 3);
        snippet = lines.slice(start, end).join('\n');
      }
    }

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'observability_review',
      title: `Observability triage: ${finding.rule} — ${finding.projectSlug}${finding.file ? ` (${finding.file}:${finding.line})` : ''}`,
      promptContext: {
        rule: finding.rule,
        detail: finding.detail,
        file: finding.file,
        line: finding.line,
        projectSlug: finding.projectSlug,
        snippet,
      },
    };
  }

  return null;
}

// --- Source: performance_review -- flags performance-hygiene issues in projects already
// onboarded by deep_dive (priority 80, alongside arch_discovery/observability_review) ---
//
// Brain Dump #94 (2026-08-18: "our pretty little cpu is getting overloaded... we need to
// develop a performance review job for projects anyways"). Structurally an exact copy of
// nextObservabilityReviewTask immediately above -- same coverage-file/flags-file/oldest-
// first/skip-if-queued shape, same reasoning for reusing deep_dive's clonePaths rather
// than cloning again -- swapped to performance-scan.js's scanner and its own
// coverage/flags files so the two sources never contend over the same state.
function nextPerformanceReviewTask() {
  const { pipelineDir, defaultDomain, deepDiveCoveragePath, performanceCoveragePath } = getConfig();

  let deepDiveCoverage;
  try {
    deepDiveCoverage = JSON.parse(readIfExists(deepDiveCoveragePath) || '{"projects":{}}');
  } catch {
    deepDiveCoverage = { projects: {} };
  }
  const deepDiveProjects = deepDiveCoverage.projects || {};

  let coverage;
  try {
    coverage = JSON.parse(readIfExists(performanceCoveragePath) || '{"projects":{}}');
  } catch {
    coverage = { projects: {} };
  }
  if (!coverage.projects) coverage.projects = {};

  const flagsPath = path.join(pipelineDir, 'queue', 'performance-flags.json');
  let flags;
  try {
    flags = JSON.parse(readIfExists(flagsPath) || '[]');
  } catch {
    flags = [];
  }

  let coverageChanged = false;
  let flagsChanged = false;
  for (const [slug, proj] of Object.entries(deepDiveProjects)) {
    if (coverage.projects[slug]) continue; // already scanned once
    if (!proj.clonePath || !fs.existsSync(proj.clonePath)) continue;
    try {
      flags.push(...scanProjectForPerformance(proj.clonePath, slug));
      flagsChanged = true;
    } catch (e) {
      // A scan failure must never crash the worker loop -- same rule
      // nextObservabilityReviewTask's own try/catch follows.
      console.error(`performance_review: failed to scan "${slug}": ${e.message}`);
    }
    coverage.projects[slug] = { scannedAt: new Date().toISOString() };
    coverageChanged = true;
  }
  if (coverageChanged) {
    fs.mkdirSync(path.dirname(performanceCoveragePath), { recursive: true });
    fs.writeFileSync(performanceCoveragePath, JSON.stringify(coverage, null, 2));
  }
  if (flagsChanged) {
    fs.mkdirSync(path.dirname(flagsPath), { recursive: true });
    fs.writeFileSync(flagsPath, JSON.stringify(flags, null, 2));
  }

  const sorted = [...flags].sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt));
  for (const finding of sorted) {
    const taskId = `performance-${slugifyForId(finding.projectSlug)}-${slugifyForId(finding.rule)}-${slugifyForId(finding.file || 'repo')}-${finding.line || 0}`;
    if (taskIdExistsInQueue(taskId)) continue;

    let snippet = null;
    const proj = finding.file && deepDiveProjects[finding.projectSlug];
    if (proj && proj.clonePath) {
      const content = readIfExists(path.join(proj.clonePath, finding.file));
      // Re-check isLikelyMinified against the file's CURRENT content -- see
      // nextObservabilityReviewTask's identical guard for the full "flags.json is a
      // persistent queue that outlives the scanner fix that should have prevented these
      // entries" rationale (2026-08-19).
      if (content && isLikelyMinified(content)) continue;
      if (content) {
        const lines = content.split('\n');
        const start = Math.max(0, (finding.line || 1) - 4);
        const end = Math.min(lines.length, (finding.line || 1) + 3);
        snippet = lines.slice(start, end).join('\n');
      }
    }

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'performance_review',
      title: `Performance triage: ${finding.rule} — ${finding.projectSlug}${finding.file ? ` (${finding.file}:${finding.line})` : ''}`,
      promptContext: {
        rule: finding.rule,
        detail: finding.detail,
        file: finding.file,
        line: finding.line,
        projectSlug: finding.projectSlug,
        snippet,
      },
    };
  }

  return null;
}

// --- Source: brain_dump_sort -- classifies one freshly-captured Brain Dump entry
// (priority 42, right after secondbrain's 40) -----------------------------------------
//
// Entries are written by the dashboard's Brain Dump tab (POST /api/brain-dump/capture),
// not by this pipeline -- this source only ever reads brainDumpPath, never writes it
// (the actual classification write happens in apply-group-a.js's applyBrainDumpSort,
// AFTER review approval, same "nothing is committed until review passes" rule every
// other source here follows). domain and source are both 'brain_dump_sort' (matching
// project_search/deep_dive's own domain===source convention) so the dashboard's
// _ensure_task_domains helper (python/dashboard/app.py) can key task-domains.json by
// this one name unambiguously.
//
// Priority 41 is deliberately left open, immediately ahead of this source, for a future
// brain_dump_action consumer that promotes a sorted+actionable entry into a real
// fulfillment task -- same "the consumer outranks its own generator" ordering
// arch_review/arch_discovery and deep_dive/project_search already establish. Not built
// yet; scoped out of this change.
//
// Top-level secondBrainDir listing (names only, not content -- same reason arch_discovery
// only embeds the specific files a plan needs, not a whole repo) is embedded so the
// implement pass can reuse an existing folder ("Projects/", "Reference/", ...) instead of
// inventing a new one for every entry, which would defeat the point of a second brain.
// Best-effort: an unreadable/missing secondBrainDir just yields an empty list, never fatal.
function listSecondBrainTopLevel(secondBrainDir) {
  if (!secondBrainDir) return [];
  let entries;
  try {
    entries = fs.readdirSync(secondBrainDir, { withFileTypes: true });
  } catch {
    return [];
  }
  // De-dupe case-insensitively before this ever reaches the model: showing it both
  // "Projects/" and "projects/" as two separate "existing" options is exactly what let it
  // pick a different-case variant of a folder that already existed (confirmed live
  // 2026-08-16 -- the vault actually had both). If the vault somehow still has both
  // (should only happen transiently, e.g. mid-manual-cleanup), keep whichever has more
  // entries -- the more-populated one is the one actually in use -- and fall back to
  // alphabetical for a stable tie-break so this doesn't flip between ticks.
  const byLower = new Map();
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const key = e.name.toLowerCase();
    const count = e.isDirectory() ? (() => {
      try { return fs.readdirSync(path.join(secondBrainDir, e.name)).length; } catch { return 0; }
    })() : -1;
    const existing = byLower.get(key);
    if (!existing || count > existing.count || (count === existing.count && e.name < existing.name)) {
      byLower.set(key, { name: e.name, isDir: e.isDirectory(), count });
    }
  }
  return [...byLower.values()]
    .map((v) => (v.isDir ? `${v.name}/` : v.name))
    .sort();
}

// Registered projects (projects.json, at the package root -- one level up from src/), used
// so brain_dump_sort can tell Ornith which tracked codebases exist. Best-effort: a
// missing/corrupt registry just yields an empty list, same convention as
// listSecondBrainTopLevel above -- this is context for the model, not a hard dependency.
// AGENT_MANAGER_PROJECTS_REGISTRY_PATH override exists purely for this file's own tests
// -- same reasoning as apply-group-a.js's readProjectRegistry(): the real registry is a
// live file the actual running pipeline reads/writes concurrently, unsafe to swap out
// from under it for a test run.
function readProjectLabels() {
  const registryPath = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH || path.join(__dirname, '..', 'projects.json');
  try {
    const list = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return Array.isArray(list) ? list.map((p) => p.label).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function nextBrainDumpSortTask() {
  const { brainDumpPath, secondBrainDir } = getConfig();
  if (!brainDumpPath) return null;
  const raw = readIfExists(brainDumpPath);
  if (!raw) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const entries = Array.isArray(data.entries) ? data.entries : [];
  // Was entries.find(...) + a single taskIdExistsInQueue check that returned null the
  // instant the OLDEST captured entry already had a task in queue -- if that oldest one
  // ever landed in blocked/ (3 failed attempts) or done/, this returned null forever,
  // silently starving every NEWER captured entry behind it even though none of them had
  // ever been attempted. Confirmed live 2026-07-26: 7 captured entries existed, the
  // oldest (bd-1784964943302) was blocked, and zero brain_dump_sort tasks had reached
  // pending/ at all -- the claim-order priority fix from earlier that same day had
  // nothing to act on, because generation itself had stopped dead. Same "skip an
  // in-queue one and keep looking" loop nextArchImportTask/nextUnusedExportTask already
  // use for their own oldest-first selection.
  const chosen = entries.find((e) => e && e.status === 'captured' && !taskIdExistsInQueue('brain-dump-sort-' + e.id));
  if (!chosen) return null;

  const taskId = 'brain-dump-sort-' + chosen.id;

  return {
    id: taskId,
    domain: 'brain_dump_sort',
    source: 'brain_dump_sort',
    title: `Sort brain dump entry: ${chosen.rawText.slice(0, 80)}`,
    promptContext: {
      brainDumpEntryId: chosen.id,
      rawText: chosen.rawText,
      existingStructure: listSecondBrainTopLevel(secondBrainDir),
      projectLabels: readProjectLabels(),
      // If this package's own source directory is ALSO one of the tracked projects (this
      // deployment: agent-manager operating on itself), self-referential notes -- about
      // the brain-dump/pipeline/dashboard system itself -- are near-certainly a feature/
      // bug for THAT project specifically, not "no project applies." Confirmed live
      // 2026-08-16: a real note ("brain dump entries should track an interaction count")
      // was classified actionable:false, belongsToProject:null -- correctly recognized
      // as a real note per the self-referential guard already in the prompt, but that
      // guard only ever said "this is real, don't treat it as a placeholder," never
      // "and therefore it belongs to the project it's describing." Computed generically
      // (package dir name, not a hardcoded "agent-manager" string) so this still works
      // correctly for a consumer project with a different name; only passed through when
      // that label is actually registered/routable, never invented.
      selfProjectLabel: (() => {
        const candidate = path.basename(path.join(__dirname, '..'));
        return readProjectLabels().includes(candidate) ? candidate : null;
      })(),
    },
  };
}

// --- Source: path_prefetch_resolve -- LLM-assisted fallback for a held
// queue/needs-clarification/ task path-prefetch.js's deterministic keyword match
// couldn't resolve on its own (context-aware-file-path-prefetch-job.md, hybrid design
// 2026-08-16: pure keyword matching doesn't hold up as a codebase grows or contributors
// don't know it well -- vague descriptions, vocabulary drift between what someone calls
// a feature and what the code calls it, accidental substring collisions in a large repo.
// This is the smart fallback for exactly the cases the fast deterministic pass gives up
// on, not a replacement for it -- see apply-group-a.js's applyBrainDumpSort, which still
// tries the free/instant keyword match FIRST and only ever lands a task in
// queue/needs-clarification/ when that fails.
//
// Deliberately does NOT auto-resolve the held task -- see prompts.js's
// pathPrefetchResolveImplementPrompt and apply-group-a.js's applyPathPrefetchResolve:
// this only ever writes a SUGGESTION (path(s) + rationale) back onto the held task for a
// human to accept or override in the dashboard's clarification picker, same fail-safe
// property the deterministic pass already has (never silently prefetch the wrong file).
// -----------------------------------------------------------------------------------------
// 14 days -- long enough that a genuinely-static idea (e.g. an exploratory "investigate
// X" note with no real anchor to any file) doesn't get re-spent on every tick forever,
// short enough that real codebase growth has a realistic chance to produce a new match
// within a few cycles, not months.
const PERIODIC_REATTEMPT_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

function nextPathPrefetchResolveTask() {
  const { pipelineDir, graphPath } = getConfig();
  const heldDir = path.join(pipelineDir, 'queue', 'needs-clarification');
  let files;
  try {
    // Oldest-first (mtime), same convention nextAdhocTask() already uses for its own
    // queue/adhoc/ scan -- readdirSync's own order is unspecified, and a held task
    // deserves the same FIFO treatment as everything else this pipeline processes, not
    // whatever arbitrary order the filesystem happens to return.
    files = fs.readdirSync(heldDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(heldDir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime)
      .map((entry) => entry.f);
  } catch {
    return null; // no held tasks at all -- nothing to do
  }

  for (const f of files) {
    let held;
    try {
      held = JSON.parse(fs.readFileSync(path.join(heldDir, f), 'utf8'));
    } catch {
      continue; // unreadable/mid-write -- skip this tick, same non-fatal-skip convention as everywhere else in this file
    }
    if (!held || !held.needsClarification) continue;
    // NOTE: does NOT skip on `held.needsClarification.suggested` alone -- a non-confident
    // (or confident-but-empty-paths) suggestion still sets `suggested`, and that's exactly
    // the case this retry targets (a CONFIDENT non-empty suggestion already auto-resolved
    // the task straight into queue/adhoc/ in applyPathPrefetchResolve(), removing it from
    // this directory entirely, so it can never reach this loop at all). Eligibility is
    // driven entirely by the two attempted-flags below instead. Confirmed live 2026-08-17:
    // an earlier version of this gate skipped on bare `suggested` truthiness, which
    // silently skipped every one of the 22 real stuck held tasks in this project's own
    // queue/needs-clarification/ (all of which already carry a non-confident `suggested`
    // from their first attempt) -- nextPathPrefetchResolveTask() returned null for all of
    // them instead of offering the intended retry.
    // Brain Dump #77: two automatic attempts per held task, not one -- a low-reasoning
    // (Ornith) attempt first, same as always, then ONE automatic high-reasoning (Claude)
    // retry if that first attempt didn't land a confident suggestion. Only once both flags
    // are set does this fall back to requiring a human (Discuss, which resets both --
    // see app.py's discuss-end handler).
    // Brain Dump (2026-08-18, "build a system" for needs-clarification): a THIRD tier
    // beyond the two automatic attempts above -- once both are spent, periodically retry
    // the same safe, human-gated suggestion step anyway, on an interval, rather than
    // requiring a human to remember to open Discuss forever. The codebase keeps growing;
    // a keyword with no match today may have a real one in a few weeks, and this is the
    // exact same non-auto-applying suggest-only step every other tier already uses --
    // this only changes HOW OFTEN a person has to notice and act, never what happens
    // automatically. Re-fires every PERIODIC_REATTEMPT_INTERVAL_MS indefinitely (not a
    // third one-shot) so an old held task can't just age out of ever being retried.
    let isHighReasoningRetry = false;
    let isPeriodicReattempt = false;
    if (held.needsClarification.suggestionAttempted) {
      if (held.needsClarification.highReasoningAttempted) {
        const anchorAt = held.needsClarification.lastPeriodicReattemptAt || held.createdAt;
        const anchorMs = anchorAt ? Date.parse(anchorAt) : NaN;
        // No anchor at all (missing/unparseable createdAt) is treated as "not due yet",
        // not "due now" -- conservative on purpose, same direction every other unknown
        // gets treated in this pipeline (an unknown budget/staleness signal is never
        // silently read as "safe to proceed"). Every real held task has a real createdAt
        // in practice; this only matters for the theoretical case where it doesn't.
        if (Number.isNaN(anchorMs) || Date.now() - anchorMs < PERIODIC_REATTEMPT_INTERVAL_MS) continue;
        isPeriodicReattempt = true;
      } else {
        isHighReasoningRetry = true;
      }
    }

    const heldId = held.id || f.replace(/\.json$/, '');
    // Suffixed with the attempt number, not just heldId alone -- taskIdExistsInQueue()
    // checks queue/done/ too, so a bare `path-prefetch-resolve-${heldId}` id would
    // collide with the FIRST attempt's now-done/ file forever, permanently blocking a
    // legitimate second attempt after Discuss resets suggestionAttempted to false.
    // Confirmed live 2026-08-16: two held tasks came back from Discuss with
    // suggestionAttempted:false as designed, but this loop still silently skipped both of
    // them every tick because their first attempt's id already existed in done/. app.py's
    // discuss-end handler bumps needsClarification.attempt alongside the reset; default to
    // 1 for a held task that predates this field (first-ever attempt).
    const attempt = held.needsClarification.attempt || 1;
    // The high-reasoning retry and periodic reattempts each get their own distinct id
    // suffix, independent of `attempt` (which only tracks human/Discuss-driven retries)
    // -- so none of the three ever collides with either other's id in queue/done/. The
    // periodic round number comes from the held task itself (bumped by
    // applyPathPrefetchResolve on each periodic run), so every cycle gets a fresh id.
    const periodicRound = (held.needsClarification.periodicReattemptCount || 0) + 1;
    const resolveId = isPeriodicReattempt
      ? `path-prefetch-resolve-${heldId}-periodic${periodicRound}`
      : isHighReasoningRetry
        ? `path-prefetch-resolve-${heldId}-attempt${attempt}-highreasoning`
        : (attempt > 1 ? `path-prefetch-resolve-${heldId}-attempt${attempt}` : `path-prefetch-resolve-${heldId}`);
    if (taskIdExistsInQueue(resolveId)) {
      // Self-heal a deadlock confirmed live 2026-08-17: a resolve task that gets rejected
      // by REVIEW never reaches applyPathPrefetchResolve() at all, so the held task's own
      // suggestionAttempted/highReasoningAttempted flag never gets stamped -- but if
      // review-rejection retries (reject-retry-check.js's own generic 2-attempt cap,
      // unrelated to this tier system) are exhausted first, the resolveId now permanently
      // "exists" in queue/blocked/, so this loop refuses to ever regenerate it, while the
      // held task's own flags still say "eligible", forever. Two real held tasks hit this
      // exact deadlock (both attempt1-highreasoning resolve tasks exhausted at review),
      // silently starving worker-reasoning of the only work it had left. If the existing
      // resolveId reached a TERMINAL state (blocked/ or done/) without ever calling
      // applyPathPrefetchResolve(), stamp the flag here instead of leaving it to that
      // function alone, so this held task stops being offered (matches the "spent" outcome
      // review-rejection-exhaustion already represents) and a human can pick it up via
      // Discuss like any other exhausted case.
      const heldPath = path.join(heldDir, f);
      const resolveTerminalPath = ['blocked', 'done']
        .map((state) => path.join(pipelineDir, 'queue', state, `${resolveId}.json`))
        .find((p) => fs.existsSync(p));
      if (resolveTerminalPath) {
        // Same deadlock class, applied to the periodic tier: a rejected periodic resolve
        // task must still advance lastPeriodicReattemptAt/periodicReattemptCount, or this
        // exact resolveId (round N) "exists" in queue/blocked/ forever and the interval
        // check above never gets a fresh anchor to count forward from -- an indefinite
        // stall identical to the pre-existing high-reasoning deadlock this block already
        // self-heals, just for a different tier.
        if (isPeriodicReattempt) {
          held.needsClarification.lastPeriodicReattemptAt = new Date().toISOString();
          held.needsClarification.periodicReattemptCount = periodicRound;
          try {
            fs.writeFileSync(heldPath, JSON.stringify(held, null, 2));
          } catch {
            // Non-fatal -- worst case this self-heal is retried next tick.
          }
        } else {
          const flagKey = isHighReasoningRetry ? 'highReasoningAttempted' : 'suggestionAttempted';
          if (!held.needsClarification[flagKey]) {
            held.needsClarification[flagKey] = true;
            try {
              fs.writeFileSync(heldPath, JSON.stringify(held, null, 2));
            } catch {
              // Non-fatal -- worst case this self-heal is retried next tick.
            }
          }
        }
      }
      continue;
    }

    // Same candidate universe path-prefetch.js's own deterministic pass already
    // searched -- the LLM fallback reasons over the exact same real files, not a
    // separate signal that could disagree with what "matched" would even mean. Uses
    // getConfig().graphPath (config.js's resolveGraphPath()) rather than re-deriving the
    // old hardcoded graphify-out/graph.json default here -- confirmed live 2026-08-16:
    // this function had its OWN independent copy of that stale default, so it never
    // actually benefited from the resolveGraphPath() fix even after that fix shipped,
    // and silently returned null (graph "not found") for every real held task.
    let fileList;
    try {
      const graph = JSON.parse(readIfExists(graphPath) || '{}');
      fileList = [...new Set((graph.nodes || []).map((n) => n.source_file).filter(Boolean))];
    } catch {
      fileList = [];
    }
    if (fileList.length === 0) continue; // greenfield project -- nothing for the LLM to match against either; leave held as-is

    return {
      id: resolveId,
      domain: 'path_prefetch_resolve',
      source: 'path_prefetch_resolve',
      // Per-instance override (see model-provider.js's reasoningTierFor()) -- only the
      // retry attempt sets this; the first attempt stays on path_prefetch_resolve's
      // ordinary low-reasoning default (no static reasoningTier registered for that source).
      ...(isHighReasoningRetry ? { reasoningTier: 'high' } : {}),
      title: isPeriodicReattempt
        ? `Periodic re-check (round ${periodicRound}): suggest file path(s) for held task: ${(held.title || heldId).slice(0, 60)}`
        : `Suggest file path(s) for held task: ${(held.title || heldId).slice(0, 80)}`,
      promptContext: {
        heldTaskId: heldId,
        rawText: (held.promptContext && held.promptContext.rawText) || held.title || '',
        taskTitle: held.title || '',
        reason: held.needsClarification.reason,
        candidates: held.needsClarification.candidates || null,
        // Budget cap matching path-prefetch.js's own MAX_PREFETCHED_PATHS reasoning --
        // this is meant to give the model a real candidate list, not the whole repo's
        // worth of paths crammed into one prompt.
        fileList: fileList.slice(0, 400),
        // Read by applyPathPrefetchResolve() to know which flag/counter to advance on
        // completion -- see its own comment for why this can't just reuse
        // suggestionAttempted/highReasoningAttempted (both are already true by the time
        // this tier fires).
        periodicReattempt: isPeriodicReattempt,
      },
    };
  }
  return null;
}

// Per-source priority override (Job List tab, AGENT_MANAGER_TASK_PRIORITIES via
// config.js's taskPriorityOverrides) -- falls back to `def` when a source has no
// override. Every registerTaskSource() call below runs at module load time, so this
// calls getConfig() there too -- but unlike every other getConfig() call in this file
// (all inside functions, called only once a task is actually being processed), this one
// fires the moment task-sources.js is REQUIRED at all. getConfig() throws when
// AGENT_MANAGER_REPO_ROOT isn't set, which broke prompts.test.js (imports prompts.js ->
// task-sources.js with no env var set, same as several other test/tooling entry points
// that only ever wanted the module's exports, not a live pipeline). Falling back to `def`
// on that throw keeps this a nice-to-have override, not a new hard requirement to even
// import this file.
function taskPriority(name, def) {
  try {
    return getConfig().taskPriorityOverrides[name] ?? def;
  } catch {
    return def;
  }
}

// apply: applyAdhocDiff -- registered HERE, not via prompts.js's later updateTaskSource
// call, same reasoning unused_export's own apply:applyVerdictOnly already established:
// apply-task.js requires task-sources.js directly but never requires prompts.js at all,
// so a custom apply attached only in prompts.js's updateTaskSource('adhoc', {...}) is
// invisible to apply-task.js's own process -- confirmed live 2026-08-17 testing this
// exact feature: drafting/review worked (both go through prompts.js), but apply fell
// through to the generic Group B JSON-diff path and failed parsing a real unified diff
// as JSON, every time, until this was moved here.
// reasoningTier: 'high' -- feeds ornith-worker.sh's worker-lane claim filter (via
// model-provider.js's reasoningTierFor()) so worker-reasoning* claims adhoc tasks, matching
// what ornith-draft.js's own resolveSourceName()==='adhoc' branch already hardcodes
// regardless of this registration -- kept here so the two can't drift apart (Brain Dump
// #77's generalized tier filter, replacing the earlier adhoc-hardcoded bash check).
registerTaskSource('adhoc', { priority: taskPriority('adhoc', 10), next: nextAdhocTask, apply: applyAdhocDiff, reasoningTier: 'high' });
// research_task (Brain Dump #1 follow-up, 2026-08-17): same "drop everything, personal
// task" priority tier as adhoc, and reasoningTier: 'high' is UNCONDITIONAL (unlike
// path_prefetch_resolve's two-tier design) -- Ornith has no web tools at all, so there is
// no meaningful low-tier attempt to make. No `apply` registered here -- its target
// (SecondBrain) is outside repoRoot and has nothing to do with the tracked code repo's
// git state, the same "non-git write target" shape as secondbrain/brain_dump_sort/
// project_search/path_prefetch_resolve above, all of which applyTask() intercepts
// directly BEFORE writeArtifact() (the only thing that would ever read a registered
// `apply`) is reached -- see apply-task.js's own research branch instead. (Unlike those,
// still needs an explicit registerTaskSource() entry here since it's this package's own
// new source, not an existing one being extended.)
registerTaskSource('research_task', {
  priority: taskPriority('research_task', 10),
  next: nextResearchTask,
  reasoningTier: 'high',
});
registerTaskSource('trouble_log', { priority: taskPriority('trouble_log', 20), next: nextTroubleLogTask });
registerTaskSource('secondbrain', { priority: taskPriority('secondbrain', 40), next: nextSecondBrainTask });
// No `apply` key here, unlike arch_discovery/arch_import above -- writeArtifact() (called
// from apply-task.js) is only reached for domains that AREN'T one of the non-git special
// cases (secondbrain/project_search/deep_dive/brain_dump_sort) hardcoded in applyTask()
// itself. An `apply` registered here would be dead code: applyTask() intercepts
// domain==='brain_dump_sort' before writeArtifact() is ever called. See apply-task.js's
// applyBrainDumpSort branch instead.
registerTaskSource('brain_dump_sort', { priority: taskPriority('brain_dump_sort', 42), next: nextBrainDumpSortTask });
// Priority 45 -- right after brain_dump_sort (42) generates the held task in the first
// place, ahead of every other job type. A held task blocks real work from ever being
// drafted at all, so resolving it (or at least trying to) deserves to jump the queue,
// not compete on equal footing with routine backlog like arch_review/deep_dive.
// No `apply` registered here -- same reasoning as brain_dump_sort just above:
// applyTask() intercepts domain==='path_prefetch_resolve' before writeArtifact() (the
// only thing that would ever read a registered `apply`) is reached at all. See
// apply-task.js's own path_prefetch_resolve branch instead.
registerTaskSource('path_prefetch_resolve', {
  priority: taskPriority('path_prefetch_resolve', 45),
  next: nextPathPrefetchResolveTask,
});
registerTaskSource('arch_review', {
  priority: taskPriority('arch_review', 70),
  next: () => nextCandidateFulfillmentTask(getConfig().archReviewCandidatesPath, 'arch_review'),
});
// arch_import_review (ADR-0020): the OTHER consumer of nextCandidateFulfillmentTask,
// against arch_import's own candidates doc instead of arch_discovery's. Priority 71 --
// immediately after arch_review (70), before arch_discovery (80) -- every stage's own
// consumer outranks its own generator, and outranks the stage that feeds it; see
// docs/arch-import-pipeline.md for the full priority-ladder reasoning.
registerTaskSource('arch_import_review', {
  priority: taskPriority('arch_import_review', 71),
  next: () => nextCandidateFulfillmentTask(getConfig().archImportCandidatesPath, 'arch_import_review'),
});
// apply (not just priority/next): arch_discovery's implement pass deliberately outputs raw
// markdown candidate write-ups (see prompts.js's archDiscoveryImplementPrompt), not Group B
// JSON -- without this, apply-task.js's writeArtifact() falls through to the generic Group
// B JSON parser and every approved arch_discovery task fails apply 100% of the time (found
// live 2026-07-21, see apply-group-a.js's applyArchDiscoveryCandidates for the full story).
registerTaskSource('arch_discovery', {
  priority: taskPriority('arch_discovery', 80),
  next: nextArchDiscoveryTask,
  apply: ({ implementResponse }) => {
    const { archReviewCandidatesPath } = getConfig();
    return applyArchDiscoveryCandidates({ implementResponse, candidatesPath: archReviewCandidatesPath });
  },
});

// observability_review shares arch_discovery's tier (80) deliberately -- it's the same
// kind of proactive review of already-scanned projects, not pure speculative cleanup like
// unused_export (90). See nextObservabilityReviewTask's own header comment for the full
// design (project idea "OpenTelemetry-Observability-Idea", 2026-07-26).
registerTaskSource('observability_review', {
  priority: taskPriority('observability_review', 80),
  next: nextObservabilityReviewTask,
  // Fix, 2026-07-26: this source used to have no apply function at all, silently
  // falling through to the generic Group-B-JSON path -- a hard mismatch for a
  // judgment-verdict task that never produces a real code fix. See
  // observabilityReviewImplementPrompt's own header comment (prompts.js) for the full
  // story, confirmed live on a real blocked task whose implement response was a
  // perfectly sensible "there are no steps to implement" given the old mismatched prompt.
  apply: applyVerdictOnly,
});

// performance_review shares observability_review's tier (80) and shape exactly -- same
// "proactive review of already-scanned projects" reasoning, and the same judgment-verdict-
// only apply (no real code fix comes out of this task; a genuine finding becomes a
// separate follow-up, same as observability_review/arch_discovery). See
// nextPerformanceReviewTask's own header comment for the full design (Brain Dump #94,
// 2026-08-18).
registerTaskSource('performance_review', {
  priority: taskPriority('performance_review', 80),
  next: nextPerformanceReviewTask,
  apply: applyVerdictOnly,
});

// --- Source: arch_import -- promotes a deep_dive Use/Adapt finding into a real,
// agent-manager-grounded architecture candidate (priority 81, ADR-0020,
// docs/arch-import-pipeline.md). Deliberately placed AFTER arch_import_review (71, its
// own consumer) and BEFORE deep_dive (82, its own generator) -- same "drain before
// generate, outrank your own generator" principle every stage in this ladder follows.
//
// Scans every UsefulProjectIndex/analysis/<project>.md for **ID:**-tagged items (stamped
// by applyDeepDiveFindings at write time) not yet a key in import-coverage.json, adds
// them with promotedAt: null, then picks the oldest not-yet-promoted Use/Adapt item not
// already in-flight. Ignore-rated items are never import candidates -- deep_dive's own
// "honest nothing found" outcome has nothing to promote. Items with no **ID:** at all
// (written before that stamping existed) are deliberately never considered -- same
// "pre-existing entries are ambiguous, not retroactively fixed" precedent
// docs/deep-dive-pipeline.md already sets for community-name matching.
const ARCH_IMPORT_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function nextArchImportTask() {
  const { repoRoot, deepDiveAnalysisDir, deepDiveCoveragePath, importCoveragePath, defaultDomain } = getConfig();
  // Same convention nextDeepDiveTask()/nextProjectSearchTask() already use.
  const projectTag = path.basename(repoRoot);

  let entries;
  try {
    entries = fs.readdirSync(deepDiveAnalysisDir, { withFileTypes: true });
  } catch {
    return null; // no analysis dir yet -- nothing to promote
  }

  // Scoping fix (2026-07-27, see writeTask()'s comment for the incident): an analysis doc
  // (one per onboarded external project, e.g. "autogen-microsoft.md") only contributes
  // candidates when deep-dive-coverage.json says that external project was onboarded FOR
  // this consumer project. Without this, arch_import offered ANY Use/Adapt-rated item from
  // ANY analysis doc as a candidate against whichever repoRoot happened to be active --
  // this is what generated ~48 unrelated import candidates against a throwaway test repo.
  // A doc with no recorded relevantToProject at all predates this fix and is excluded, same
  // fail-closed reasoning as nextDeepDiveTask()'s candidate filter.
  let deepDiveCoverage;
  try {
    deepDiveCoverage = JSON.parse(readIfExists(deepDiveCoveragePath) || '{"projects":{}}');
  } catch {
    deepDiveCoverage = { projects: {} };
  }
  const relevantSlugs = new Set(
    Object.entries(deepDiveCoverage.projects || {})
      .filter(([, proj]) => proj.relevantToProject === projectTag)
      .map(([slug]) => slug),
  );

  let coverage;
  try {
    coverage = JSON.parse(readIfExists(importCoveragePath) || '{"items":{}}');
  } catch {
    coverage = { items: {} };
  }
  if (!coverage.items) coverage.items = {};

  let coverageChanged = false;
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const projectSlug = entry.name.replace(/\.md$/, '');
    if (!relevantSlugs.has(projectSlug)) continue;
    const text = readIfExists(path.join(deepDiveAnalysisDir, entry.name));
    if (!text) continue;

    // Split on H2 ("## ") item headings -- drop index 0, which is the "# <project> —
    // Deep Dive" H1 header line applyDeepDiveFindings writes on first create, not a real
    // item block.
    const blocks = text.split(/(?=^## )/m).slice(1);
    for (const block of blocks) {
      const idMatch = block.match(/^\*\*ID:\*\*\s*(\S+)/m);
      if (!idMatch) continue;
      const itemId = idMatch[1];

      if (!(itemId in coverage.items)) {
        coverage.items[itemId] = { promotedAt: null, candidateId: null, projectSlug };
        coverageChanged = true;
      }
      const itemCoverage = coverage.items[itemId];
      if (itemCoverage.promotedAt) continue; // a REAL candidate was produced -- genuinely done
      // A skipped (zero-harness-grounding, or Ornith declined) attempt is retryable, not
      // terminal -- agent-manager's own codebase keeps growing, so a query with zero hits
      // today can find a real match later. Confirmed live 2026-07-26: the old unconditional
      // promotedAt stamp had permanently blocked 134/134 real attempts, none of which ever
      // produced an actual candidate. ARCH_IMPORT_RETRY_COOLDOWN_MS below just stops the
      // SAME just-attempted item from being re-picked every single tick forever while
      // nothing about the codebase has changed yet.
      if (itemCoverage.lastAttemptedAt && Date.now() - Date.parse(itemCoverage.lastAttemptedAt) < ARCH_IMPORT_RETRY_COOLDOWN_MS) continue;

      const ratingMatch = block.match(/^\*\*Rating:\*\*\s*(\S+)/m);
      const rating = ratingMatch ? ratingMatch[1] : '';
      if (rating !== 'Use' && rating !== 'Adapt') continue;

      const titleMatch = block.match(/^##\s*(.+)$/m);
      const filesMatch = block.match(/^\*\*Files:\*\*\s*(.+)$/m);
      const rationaleAnchor = filesMatch ? filesMatch[0] : idMatch[0];
      const rationale = block.slice(block.indexOf(rationaleAnchor) + rationaleAnchor.length).trim();

      candidates.push({
        itemId,
        projectSlug,
        title: titleMatch ? titleMatch[1].trim() : itemId,
        rating,
        files: filesMatch ? filesMatch[1].trim() : '',
        rationale,
      });
    }
  }

  if (coverageChanged) {
    fs.mkdirSync(path.dirname(importCoveragePath), { recursive: true });
    fs.writeFileSync(importCoveragePath, JSON.stringify(coverage, null, 2));
  }

  // No timestamp is stamped on an item itself (only on promotion), and itemId's numeric
  // suffix is only meaningfully ordered WITHIN one project (each has its own independent
  // counter) -- sorting by itemId string is just for a stable, reproducible pick across
  // repeated calls, not a claim of real chronological ordering across projects.
  candidates.sort((a, b) => a.itemId.localeCompare(b.itemId));

  for (const c of candidates) {
    const taskId = 'arch-import-' + c.itemId;
    if (taskIdExistsInQueue(taskId)) continue;

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'arch_import',
      title: `Arch import: ${c.title} (from ${c.projectSlug})`,
      promptContext: {
        itemId: c.itemId,
        sourceProject: c.projectSlug,
        itemTitle: c.title,
        rating: c.rating,
        itemFiles: c.files,
        itemRationale: c.rationale,
      },
    };
  }

  return null;
}

// pipeline_self_audit (2026-08-19: "How can we turn this into a self improving
// process?"): see pipeline-self-audit.js's own header for the full design. Deterministic
// detection only -- reads queue/blocked/ fresh every call (not a persistent flags queue
// like observability/performance_review's, deliberately: this project's own history has
// already shown a persistent flags file can outlive the bug it was flagging, see
// task-sources.js's isLikelyMinified re-validation fix above) and files a real adhoc task
// once a failure cluster crosses CLUSTER_THRESHOLD, so the resulting fix goes through the
// exact same real-agentic-Claude-plus-human-confirmation path every other adhoc task
// does.
function nextPipelineSelfAuditTask() {
  const { pipelineDir, selfAuditCoveragePath } = getConfig();
  const blockedDir = path.join(pipelineDir, 'queue', 'blocked');

  let names;
  try {
    names = fs.readdirSync(blockedDir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }

  const blockedTasks = [];
  for (const name of names) {
    try {
      blockedTasks.push(JSON.parse(fs.readFileSync(path.join(blockedDir, name), 'utf8')));
    } catch {
      // an unreadable/malformed blocked file is not itself evidence of a pattern -- skip it.
    }
  }

  let coverage;
  try {
    coverage = JSON.parse(readIfExists(selfAuditCoveragePath) || '{}');
  } catch {
    coverage = {};
  }

  const clusters = findAuditClusters(blockedTasks, coverage);
  if (clusters.length === 0) return null;

  const cluster = clusters[0];
  const task = buildAuditTask(cluster);
  if (taskIdExistsInQueue(task.id)) return null;

  // Coverage is recorded by the CLI's markPipelineSelfAuditReported(), AFTER writeTask()
  // actually persists this task -- not here. Fixed 2026-08-20 (Grimmethy: "Last hours
  // report shows 0 tasks done... Has the self audit task been working?"): this used to
  // write coverage unconditionally before returning, but getNextTask()'s tier filter can
  // silently `continue` past (discard) a task whose resolved tier doesn't match the
  // caller's --tier -- domain:'adhoc' always resolves to 'high', so a --tier=low caller
  // (worker-1) reaching this source generated a real task, this function marked its
  // signature "reported" forever, and getNextTask() then threw the task away without ever
  // calling writeTask(). Confirmed live: all 6 real clusters found 2026-08-20 04:19-04:40
  // had a coverage entry but no task file anywhere in the queue -- every one silently
  // burned. Every next() function here is documented as a pure read with no queue-write
  // side effect (see getNextTask()'s own comment); this now honors that.
  return task;
}

// Called once from the CLI, only after writeTask() has actually persisted a
// pipeline_self_audit task to pending/ -- see nextPipelineSelfAuditTask()'s own comment
// for why the write moved here instead of living inside the generator.
function markPipelineSelfAuditReported(task) {
  const { selfAuditCoveragePath } = getConfig();
  const signature = task.promptContext && task.promptContext.signature;
  if (!signature) return;
  let coverage;
  try {
    coverage = JSON.parse(readIfExists(selfAuditCoveragePath) || '{}');
  } catch {
    coverage = {};
  }
  coverage[signature] = { reportedAt: new Date().toISOString(), taskId: task.id };
  fs.mkdirSync(path.dirname(selfAuditCoveragePath), { recursive: true });
  fs.writeFileSync(selfAuditCoveragePath, JSON.stringify(coverage, null, 2));
}
registerTaskSource('arch_import', {
  priority: taskPriority('arch_import', 81),
  next: nextArchImportTask,
  apply: ({ implementResponse, task }) => {
    const { archImportCandidatesPath, importCoveragePath } = getConfig();
    return applyArchImportCandidate({ implementResponse, candidatesPath: archImportCandidatesPath, importCoveragePath, task });
  },
});

registerTaskSource('deep_dive', { priority: taskPriority('deep_dive', 82), next: nextDeepDiveTask });
registerTaskSource('project_search', { priority: taskPriority('project_search', 85), next: nextProjectSearchTask });
// apply: applyVerdictOnly -- fix, 2026-07-26, same reasoning as observability_review's own
// (see unusedExportImplementPrompt's header comment, prompts.js). Never actually confirmed
// live (dead-code-flags.json has never existed in this pipeline's real history), but the
// registration gap was identical, so fixed for consistency ahead of the scanner ever
// actually running.
registerTaskSource('unused_export', { priority: taskPriority('unused_export', 90), next: nextUnusedExportTask, apply: applyVerdictOnly });
// No `apply` key here -- domain:'adhoc' (see buildAuditTask) already resolves to 'adhoc'
// via resolveSourceName(), so this goes through the exact same real-agentic-implement /
// awaiting-confirm apply path every other adhoc task uses (task-source-registry.js's
// resolveSourceName: `task.domain === 'adhoc' ... return 'adhoc'`, checked before
// task.source at all).
registerTaskSource('pipeline_self_audit', { priority: taskPriority('pipeline_self_audit', 65), next: nextPipelineSelfAuditTask });

// tierFilter ('low'|'high'|undefined) -- Brain Dump #77 follow-up (2026-08-17): without
// this, getNextTask() always returns the FIRST source in priority order with eligible
// work and stops there, even when that source's task doesn't match the calling lane's own
// reasoning tier. Confirmed live: with path_prefetch_resolve's automatic high-reasoning
// retry (priority 69, beats arch_discovery/arch_import/observability_review at 79/80/79)
// having a real 20+ item backlog, worker-1's generation calls kept returning a high-tier
// retry task every single tick, which worker-1 then correctly declined to CLAIM (see
// ornith-worker.sh's tier filter) -- but never got far enough down the ladder to generate
// any LOW-tier work for itself either, so worker-1 sat idle while worker-reasoning did
// everything. A mismatched-tier task is skipped (not returned) and the ladder keeps
// walking to the next source instead of stopping -- safe because every next() function
// here is a pure "what would I offer" read with no queue-write side effect (writeTask()
// is the only thing that actually persists a task), so skipping a candidate wastes at
// most one extra read, never loses or duplicates work.
function getNextTask({ tierFilter } = {}) {
  const { taskSourceAllowlist } = getConfig();
  const restricted = taskSourceAllowlist && taskSourceAllowlist.length > 0;
  for (const source of getRegisteredSources()) {
    // 'adhoc' is a fixed contract (README: "preempts every deterministic source") --
    // an allowlist restricting this run to e.g. just project_search should still let an
    // explicitly human-queued adhoc task through, not silently swallow it. 'brain_dump_sort'
    // is documented (see app.py's _ALWAYS_ENSURE_DOMAINS) as an always-on background source,
    // independent of whichever project's pipeline mode is active -- a mode-scoped allowlist
    // like Project Search's [project_search, deep_dive] should never be able to silently
    // pause it, since Brain Dump is meant to sit above any single active project.
    const alwaysAllowed = source.name === 'adhoc' || source.name === 'brain_dump_sort';
    if (restricted && !alwaysAllowed && !taskSourceAllowlist.includes(source.name)) continue;
    if (typeof source.next !== 'function') continue;
    const task = source.next();
    if (!task) continue;
    if (tierFilter && reasoningTierFor(task) !== tierFilter) continue;
    return task;
  }
  return null;
}

// generatedForRepoRoot stamps which repo's config was live when this task was generated.
// Several sources (project_search, deep_dive, arch_import, and anything reading a path
// derived from path.dirname(repoRoot) rather than repoRoot itself) resolve to the SAME
// absolute path regardless of which sibling repo under the same parent directory
// AGENT_MANAGER_REPO_ROOT currently points at -- switching a running pipeline to a new
// project does not isolate it from that shared backlog, and a task generated under one
// repoRoot can otherwise be claimed and applied against a totally different one if the
// pipeline gets repointed in between (reproduced live 2026-07-27: repointing at a fresh
// throwaway repo caused ~48 unrelated cross-project import candidates to be drafted and
// auto-approved against it). ornith-worker.ps1 checks this at claim time, before any
// Ornith compute is spent, and blocks rather than silently proceeding on a mismatch.
function writeTask(task) {
  const { pipelineDir, repoRoot } = getConfig();
  const dir = path.join(pipelineDir, 'queue', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${task.id}.json`);
  const record = {
    ...task,
    generatedForRepoRoot: repoRoot,
    status: 'pending',
    createdAt: new Date().toISOString(),
    history: [],
  };
  appendHistoryEvent(record, 'created', task.source);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

module.exports = {
  getNextTask, writeTask, taskIdExistsInQueue,
  nextTroubleLogTask, nextAdhocTask, nextSecondBrainTask,
  nextCandidateFulfillmentTask, nextArchDiscoveryTask, nextUnusedExportTask, nextProjectSearchTask,
  nextArchImportTask, nextDeepDiveTask, nextBrainDumpSortTask, nextObservabilityReviewTask,
  nextPerformanceReviewTask,
  nextPathPrefetchResolveTask, nextResearchTask,
  parseStrongLeadsFromIndex,
  isTaskReady, pendingReadinessMap,
  listSecondBrainTopLevel,
  nextPipelineSelfAuditTask, markPipelineSelfAuditReported,
};

// CLI entry point: `node task-sources.js` -- writes one new pending task if one is found
// and nothing is already sitting in pending/. Safe to call on every worker tick.
//
// ensureRegistered() is called HERE, inside the CLI block, deliberately AFTER
// module.exports above rather than at module-load time: the consumer's registration file
// (AGENT_MANAGER_REGISTER_PATH) commonly imports taskIdExistsInQueue back FROM this same
// file (see README.md's example) -- calling ensureRegistered() any earlier would hand that
// require() an incomplete module.exports (Node's circular-require behavior) before
// taskIdExistsInQueue is actually defined on it.
if (require.main === module) {
  const { ensureRegistered } = require('./config.js');
  ensureRegistered();

  // `node task-sources.js --priority-map` prints {name: priority} for every registered
  // source and exits without touching pending/adhoc. Consumed by ornith-worker.ps1 so the
  // worker's claim order (which task in pending/ to pick up next) uses the SAME priority
  // ladder as generation order, instead of the old binary manual-vs-everything-else rank
  // that let a large pre-existing backlog starve a newer, higher-priority task indefinitely
  // (confirmed live 2026-07-25: a fresh brain_dump_sort task sat behind a 28-deep deep_dive
  // backlog despite outranking it on priority, because claim order never consulted priority).
  if (process.argv.includes('--priority-map')) {
    const map = {};
    for (const source of getRegisteredSources()) map[source.name] = source.priority;
    console.log(JSON.stringify(map));
    return;
  }

  // `node task-sources.js --pending-readiness` prints {taskId: boolean} for every task
  // currently sitting in pending/ -- see isTaskReady()'s own header comment. Same
  // "compute it once in JS, consume it from PowerShell" split as --priority-map above.
  if (process.argv.includes('--pending-readiness')) {
    console.log(JSON.stringify(pendingReadinessMap()));
    return;
  }

  // `node task-sources.js --pending-tier-counts` prints {low: N, high: N} -- see
  // pendingTierCounts()'s own header comment.
  if (process.argv.includes('--pending-tier-counts')) {
    console.log(JSON.stringify(pendingTierCounts()));
    return;
  }

  // `node task-sources.js --approval-modes` prints {name: mode} for every registered
  // source -- the resolved three-tier approval mode (config.js's approvalModeOverrides,
  // falling back to defaultApprovalMode), consumed by apply-runner.ps1 so its automatic
  // loop only ever auto-claims 'auto'-tier approved tasks. Same split as --priority-map.
  if (process.argv.includes('--approval-modes')) {
    const { approvalModeOverrides, defaultApprovalMode } = getConfig();
    const map = {};
    for (const source of getRegisteredSources()) {
      map[source.name] = approvalModeOverrides[source.name] || defaultApprovalMode;
    }
    console.log(JSON.stringify(map));
    return;
  }

  // `node task-sources.js --tier=low|high` -- restricts generation to that reasoning
  // tier (see getNextTask()'s own comment). Omitted entirely = no filter, generates
  // whichever source is highest priority regardless of tier, matching this CLI's
  // long-standing default behavior for any caller that doesn't care about tiers.
  const tierArg = process.argv.find((a) => a.startsWith('--tier='));
  const tierFilter = tierArg ? tierArg.slice('--tier='.length) : undefined;

  const { pipelineDir, brainDumpPath } = getConfig();
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  const draftingDir = path.join(pipelineDir, 'queue', 'drafting');
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const researchDir = path.join(pipelineDir, 'queue', 'research');
  // Checked pendingDir only until 2026-08-14 -- a claimed task moves OUT of pending/ into
  // drafting/<instanceId>/ within the same worker tick that claims it (see
  // ornith-worker.sh), well before the real plan/implement/critique work behind it is
  // done, so pending/ alone reads "empty" almost immediately after every claim regardless
  // of how deep the real backlog sitting in drafting/ already is. Confirmed live: 15+
  // project_search tasks piled up in drafting/ while this throttle kept seeding a new one
  // on every single ~30s tick, since it only ever saw an empty pending/. drafting/ is one
  // level deeper (per-instance subfolders), so this checks any *.json under any of those,
  // not just the top level.
  // When tierFilter is set, a task file only counts toward "already pending" if it's
  // actually THIS tier's own backlog -- otherwise a tier-scoped caller (e.g. worker-1
  // calling --tier=low) would see worker-reasoning's high-tier drafting/pending backlog and
  // throttle itself into never generating any low-tier work at all, the exact starvation
  // this tier split exists to fix. Unreadable/mid-write files count as backlog either way
  // (conservative default, matches every other non-fatal-skip convention in this file).
  const taskFileMatchesTier = (filePath) => {
    if (!tierFilter) return true;
    try {
      return reasoningTierFor(JSON.parse(fs.readFileSync(filePath, 'utf8'))) === tierFilter;
    } catch {
      return true;
    }
  };
  const hasDraftingWork = fs.existsSync(draftingDir)
    && fs.readdirSync(draftingDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) return false;
      const instanceDir = path.join(draftingDir, entry.name);
      try {
        return fs.readdirSync(instanceDir).some((f) => f.endsWith('.json') && taskFileMatchesTier(path.join(instanceDir, f)));
      } catch {
        return false;
      }
    });
  const alreadyPending = hasDraftingWork
    || (fs.existsSync(pendingDir) && fs.readdirSync(pendingDir).some((f) => f.endsWith('.json') && taskFileMatchesTier(path.join(pendingDir, f))));

  // An already-queued lower-priority task must never block a NEW adhoc task from
  // reaching pending/ -- adhoc is the "drop everything, do this now" lane. This exception
  // only fires when adhoc/ actually has something waiting, so the normal throttle (don't
  // pile up unbounded pending/ entries from the background sources) still applies to
  // everything else.
  const hasAdhocWaiting = fs.existsSync(adhocDir)
    && fs.readdirSync(adhocDir).some((f) => f.endsWith('.json'));

  // Same exception, same reasoning, for research_task (priority 10, also "drop
  // everything" -- see task-sources.js's own registerTaskSource('research_task', ...)):
  // arrival is bounded by how often brain_dump_sort actually classifies a note as
  // requiresResearch, same bounded-arrival argument as adhoc's own exemption above.
  const hasResearchWaiting = fs.existsSync(researchDir)
    && fs.readdirSync(researchDir).some((f) => f.endsWith('.json'));

  // Same exception, same reasoning, for brain_dump_sort (priority 42): confirmed live
  // 2026-07-25 that a sustained background backlog (e.g. the deep_dive rotation across
  // many communities) starves brain_dump_sort indefinitely even though it outranks
  // deep_dive on the priority ladder -- the throttle above never lets getNextTask() run
  // at all while pending/ is non-empty, so priority never gets a chance to matter. Unlike
  // adhoc/deep_dive/project_search, brain_dump_sort's arrival rate is bounded by how often
  // a human actually captures a note, so letting it through here can't create the
  // unbounded-pileup problem this throttle exists to prevent.
  //
  // MUST also check taskIdExistsInQueue the same way nextBrainDumpSortTask() itself does
  // -- confirmed live 2026-08-17, the same class of bug as the needs-clarification
  // exemption above: a captured entry's status only flips to 'sorted' once its
  // brain_dump_sort task is actually APPLIED, not once it's merely queued. With 16 real
  // captured entries each already sitting in queue/pending/ as their own
  // brain-dump-sort-<id> task (drafted or not, none applied yet), this exemption stayed
  // open on every tick even though nextBrainDumpSortTask() itself correctly had nothing
  // left to add -- reopening the FULL getNextTask() ladder and letting arch_import/
  // arch_discovery/observability_review keep generating fresh tasks the whole time
  // pending/ already sat 140+ deep, exactly the symptom the needs-clarification fix
  // above was meant to close off for good.
  const hasBrainDumpWaiting = (() => {
    if (!brainDumpPath) return false;
    try {
      const data = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8'));
      return Array.isArray(data.entries) && data.entries.some((e) => e && e.status === 'captured'
        && !taskIdExistsInQueue('brain-dump-sort-' + e.id));
    } catch {
      return false;
    }
  })();

  // Same exception, same reasoning, as adhoc/brain_dump_sort above -- for a held
  // queue/needs-clarification/ task that just came out of a Discuss session (or was never
  // attempted yet): nextPathPrefetchResolveTask() (priority 45) never gets a chance to run
  // at all while pending/drafting/ already has a backlog, no matter how it ranks on the
  // priority ladder, because the throttle above short-circuits before getNextTask() is
  // even called. Confirmed live 2026-08-16: two held tasks sat with
  // suggestionAttempted:false behind a deep arch_import backlog indefinitely. Arrival rate
  // here is bounded by how many tasks are actually sitting in needs-clarification/ waiting
  // on a fresh attempt (a human just discussed one), same bounded-arrival argument that
  // justifies brain_dump_sort's exemption, so this can't create the unbounded-pileup
  // problem the throttle exists to prevent.
  //
  // MUST also check whether a path-prefetch-resolve task for this held item is already
  // in flight (same resolveId/taskIdExistsInQueue check nextPathPrefetchResolveTask()
  // itself uses) -- confirmed live 2026-08-17: without this, the exemption stays open for
  // the entire window between "resolve task queued" and "resolve task actually applied"
  // (suggestionAttempted only flips once applyPathPrefetchResolve() runs, not merely once
  // the task is queued). Every tick in that window re-opens the FULL getNextTask() ladder;
  // nextPathPrefetchResolveTask() itself correctly returns null (nothing new to add, it
  // already queued one), so the ladder falls all the way through to arch_discovery/
  // arch_import (priority 79/80) -- which, unlike path_prefetch_resolve, always has more
  // candidates to give from a large scouted repo. Result: pending/ kept receiving a fresh
  // arch_import task roughly every tick, completely defeating the "don't add more while a
  // backlog exists" throttle, while the 144+ item backlog it was meant to protect never
  // shrank -- two real held tasks stuck for hours were enough to flood the queue
  // indefinitely with unrelated low-priority work.
  // Brain Dump #77: mirrors nextPathPrefetchResolveTask()'s own two-tier eligibility gate
  // (attempted-flags-driven, NOT `suggested` truthiness -- a non-confident suggestion still
  // sets `suggested`, and that's exactly the retry-eligible case). Confirmed live
  // 2026-08-17: the OLD check here (`suggested || suggestionAttempted`) treated every one
  // of this project's real stuck held tasks as "not waiting" (all already have a
  // non-confident `suggested` from their first attempt), so this exemption never reopened
  // the ladder for their automatic high-reasoning retry -- it only worked at all because
  // the real backlog happened to be thin enough for the plain (non-exempted) throttle to
  // stay open on its own.
  const hasHeldClarificationWaiting = (() => {
    const heldDir = path.join(pipelineDir, 'queue', 'needs-clarification');
    let files;
    try {
      files = fs.readdirSync(heldDir).filter((f) => f.endsWith('.json'));
    } catch {
      return false;
    }
    return files.some((f) => {
      try {
        const held = JSON.parse(fs.readFileSync(path.join(heldDir, f), 'utf8'));
        if (!held || !held.needsClarification) return false;
        const nc = held.needsClarification;
        const attempted = !!nc.suggestionAttempted;
        if (attempted && nc.highReasoningAttempted) return false; // both tiers spent -- needs a human, not more generation
        const heldId = held.id || f.replace(/\.json$/, '');
        const attempt = nc.attempt || 1;
        const resolveId = attempted
          ? `path-prefetch-resolve-${heldId}-attempt${attempt}-highreasoning`
          : (attempt > 1 ? `path-prefetch-resolve-${heldId}-attempt${attempt}` : `path-prefetch-resolve-${heldId}`);
        return !taskIdExistsInQueue(resolveId);
      } catch {
        return false;
      }
    });
  })();

  if (alreadyPending && !hasAdhocWaiting && !hasResearchWaiting && !hasBrainDumpWaiting && !hasHeldClarificationWaiting) {
    console.log('pending/ already has work queued, not adding another task');
  } else {
    const task = getNextTask({ tierFilter });
    if (!task) {
      console.log('no eligible task found (all registered sources exhausted or malformed)');
    } else {
      const file = writeTask(task);
      console.log(`queued: ${file}`);
      if (task.source === 'pipeline_self_audit') markPipelineSelfAuditReported(task);
      if (task.domain === 'adhoc') {
        try { fs.unlinkSync(path.join(adhocDir, task.id + '.json')); } catch {}
      }
      if (task.domain === 'research') {
        try { fs.unlinkSync(path.join(researchDir, task.id + '.json')); } catch {}
      }
    }
  }
}
