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
const { getConfig } = require('./config.js');
const { applyArchDiscoveryCandidates, applyArchImportCandidate } = require('./apply-group-a.js');

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
function parseStrongLeadsFromIndex(indexText) {
  if (!indexText) return [];
  const notesIdx = indexText.indexOf('## Notes');
  const notesText = notesIdx === -1 ? '' : indexText.slice(notesIdx);
  const strongNames = new Set([...notesText.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim()));

  const rows = [...indexText.matchAll(/\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|/g)];
  const seen = new Set();
  const leads = [];
  for (const [, rawName, rawUrl] of rows) {
    const name = rawName.trim();
    if (!strongNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    leads.push({ name, url: rawUrl.trim() });
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
    execSync(`python "${buildGraphScript}" --target-dir "${clonePath}" --output "${graphOutPath}" --no-model-naming`, { stdio: 'pipe' });
  }

  const graphData = JSON.parse(readIfExists(graphOutPath) || '{"nodes":[],"links":[],"communities":[]}');
  return {
    slug,
    clonePath,
    communities: (graphData.communities || []).map((c) => ({ id: c.id, name: c.name, lastReviewedAt: null, actionItemCount: null })),
  };
}

function nextDeepDiveTask() {
  const { projectSearchIndexPath, deepDiveCoveragePath, deepDiveClonesDir } = getConfig();

  let coverage;
  try {
    coverage = JSON.parse(readIfExists(deepDiveCoveragePath) || '{"projects":{}}');
  } catch {
    coverage = { projects: {} };
  }
  if (!coverage.projects) coverage.projects = {};

  const strongLeads = parseStrongLeadsFromIndex(readIfExists(projectSearchIndexPath));
  let coverageChanged = false;
  for (const lead of strongLeads) {
    const slug = slugifyForId(lead.name);
    if (coverage.projects[slug]) continue; // already onboarded (or a prior onboarding attempt failed and will retry below)
    try {
      const onboarded = onboardDeepDiveProject(lead, deepDiveClonesDir);
      coverage.projects[slug] = {
        sourceUrl: lead.url,
        clonePath: onboarded.clonePath,
        clonedAt: new Date().toISOString(),
        communities: onboarded.communities,
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
  const candidates = [];
  for (const [slug, proj] of Object.entries(coverage.projects)) {
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

registerTaskSource('adhoc', { priority: 10, next: nextAdhocTask });
registerTaskSource('trouble_log', { priority: 20, next: nextTroubleLogTask });
registerTaskSource('secondbrain', { priority: 40, next: nextSecondBrainTask });
registerTaskSource('arch_review', {
  priority: 70,
  next: () => nextCandidateFulfillmentTask(getConfig().archReviewCandidatesPath, 'arch_review'),
});
// arch_import_review (ADR-0020): the OTHER consumer of nextCandidateFulfillmentTask,
// against arch_import's own candidates doc instead of arch_discovery's. Priority 71 --
// immediately after arch_review (70), before arch_discovery (80) -- every stage's own
// consumer outranks its own generator, and outranks the stage that feeds it; see
// docs/arch-import-pipeline.md for the full priority-ladder reasoning.
registerTaskSource('arch_import_review', {
  priority: 71,
  next: () => nextCandidateFulfillmentTask(getConfig().archImportCandidatesPath, 'arch_import_review'),
});
// apply (not just priority/next): arch_discovery's implement pass deliberately outputs raw
// markdown candidate write-ups (see prompts.js's archDiscoveryImplementPrompt), not Group B
// JSON -- without this, apply-task.js's writeArtifact() falls through to the generic Group
// B JSON parser and every approved arch_discovery task fails apply 100% of the time (found
// live 2026-07-21, see apply-group-a.js's applyArchDiscoveryCandidates for the full story).
registerTaskSource('arch_discovery', {
  priority: 80,
  next: nextArchDiscoveryTask,
  apply: ({ implementResponse }) => {
    const { archReviewCandidatesPath } = getConfig();
    return applyArchDiscoveryCandidates({ implementResponse, candidatesPath: archReviewCandidatesPath });
  },
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
function nextArchImportTask() {
  const { deepDiveAnalysisDir, importCoveragePath, defaultDomain } = getConfig();

  let entries;
  try {
    entries = fs.readdirSync(deepDiveAnalysisDir, { withFileTypes: true });
  } catch {
    return null; // no analysis dir yet -- nothing to promote
  }

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
      if (coverage.items[itemId].promotedAt) continue; // already promoted

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
registerTaskSource('arch_import', {
  priority: 81,
  next: nextArchImportTask,
  apply: ({ implementResponse, task }) => {
    const { archImportCandidatesPath, importCoveragePath } = getConfig();
    return applyArchImportCandidate({ implementResponse, candidatesPath: archImportCandidatesPath, importCoveragePath, task });
  },
});

registerTaskSource('deep_dive', { priority: 82, next: nextDeepDiveTask });
registerTaskSource('project_search', { priority: 85, next: nextProjectSearchTask });
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
  nextCandidateFulfillmentTask, nextArchDiscoveryTask, nextUnusedExportTask, nextProjectSearchTask,
  nextArchImportTask,
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

  const { pipelineDir } = getConfig();
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const alreadyPending = fs.existsSync(pendingDir)
    && fs.readdirSync(pendingDir).some((f) => f.endsWith('.json'));

  // An already-queued lower-priority task must never block a NEW adhoc task from
  // reaching pending/ -- adhoc is the "drop everything, do this now" lane. This exception
  // only fires when adhoc/ actually has something waiting, so the normal throttle (don't
  // pile up unbounded pending/ entries from the background sources) still applies to
  // everything else.
  const hasAdhocWaiting = fs.existsSync(adhocDir)
    && fs.readdirSync(adhocDir).some((f) => f.endsWith('.json'));

  if (alreadyPending && !hasAdhocWaiting) {
    console.log('pending/ already has work queued, not adding another task');
  } else {
    const task = getNextTask();
    if (!task) {
      console.log('no eligible task found (all registered sources exhausted or malformed)');
    } else {
      const file = writeTask(task);
      console.log(`queued: ${file}`);
      if (task.domain === 'adhoc') {
        try { fs.unlinkSync(path.join(adhocDir, task.id + '.json')); } catch {}
      }
    }
  }
}
