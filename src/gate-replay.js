'use strict';

// Gate replay for the review step (brain dump "Pipeline yellow hardening 7/8", 2026-10-01).
//
// Why: a gate, guard or detector written against hand-made examples misfires on real traffic, and the reviewer (three LLM votes) only checks that the code matches
// its description. On 2026-10-01 a draft-quality gate would have blocked 135 of 2,369 finished tasks (87 already merged: it treated files the draft itself creates as
// "fabricated"), a hallucinated-identifier check flagged 5 of 24 merged edit drafts, and an evidence-bundle fallback changed the winner set of all 11 sources while its
// tests stayed green with the fallback deleted. Each number took a throwaway script and minutes; this module is that script, run by the pipeline.
//
// What: given a unified diff and the scratch worktree it was applied to (src/review-verify.js already builds one), find the exported functions the diff adds or changes
// that look like gates (name matches GATE_NAME_RE, first parameters match a known input family), replay each over a corpus of tasks that already ran, and report how
// many MERGED tasks it would flag -- before (the base ref) and after (the diff). The gate runs inside the same bwrap sandbox as the tests, via src/gate-replay-runner.js.
//
// Families (what the gate is called with, and what the corpus is):
//   draft-text   gate(implementResponse|draftText|text, repoRoot)   corpus: queue/done tasks that have an implementResponse; "merged" = mergedAt.
//   edit-ops     gate(implementResponse, fetchedFiles, opts)         corpus: merged tasks whose implementResponse holds edit/create ops and whose promptContext
//                                                                    carries fetchedFiles.
//   file-text    gate(text, relPath)                                 corpus: the repo's own .js/.py files (a scanner rule). Reported, never blocking: there is no
//                                                                    "must not flag" population for source files.
// A gate that matches no family is reported as skipped with the reason -- "no corpus" is information, not a failure.
//
// Never throws: any failure means "no replay", which is never a block.

const fs = require('fs');
const path = require('path');
const { runGit } = require('./agentic-draft-common.js');

const GATE_NAME_RE = /(gate|guard|check|detect|classif|predicate|violation|verify|validate|filter|unverified|flags?$)/i;
const MAX_CANDIDATES = 3;
const MAX_ITEMS = 3000;
const MAX_TEXT_CHARS = 60000;
const DEFAULT_MAX_TOTAL_CHARS = 30000000;
// The corpus is written to one JSON file inside the sandbox, so its total text is capped (newest tasks first); AGENT_MANAGER_GATE_REPLAY_MAX_CHARS overrides.
function maxTotalChars() {
  const v = Number(process.env.AGENT_MANAGER_GATE_REPLAY_MAX_CHARS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_TOTAL_CHARS;
}
const MIN_MERGED_FOR_BLOCK = 20;
const DEFAULT_MAX_FP_RATE = 0.02;
const RUN_TIMEOUT_MS = 90000;
const ARTIFACT_DIR = '.gate-replay';
const BASE_SUFFIX = '.__gate_replay_base.js';
const TEST_PATH_RE = /\.(?:test|spec)\.[cm]?js$|(^|\/)(?:tests?|__tests__)\//;

// --- finding the gate functions a diff touches ---------------------------------------------------------------------------------------------------------------

// { file, name, params: [..], isNew } for each exported, gate-named function in a src/*.js (non-test) file whose source lines the diff touches (adds, or deletes inside).
// The touched NEW-file line numbers are read from the hunks and intersected with each function's line range in the worktree, where the diff is already applied. A
// function's range runs from its declaration to the line before the next column-0 declaration (this codebase keeps top-level code at column 0).
function changedNewLines(chunk) {
  const lines = new Set();
  let n = 0;
  for (const line of chunk.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { n = Number(h[1]); continue; }
    if (!n) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) { lines.add(n); n += 1; }
    else if (line.startsWith('-') && !line.startsWith('---')) lines.add(n); // a deletion touches the function that now spans this position
    else if (line.startsWith(' ')) n += 1;
  }
  return lines;
}

const TOP_LEVEL_RE = /^(?:async\s+)?function\s|^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|^module\.exports|^exports\./;

function findGateCandidates(rawDiff, worktreeDir) {
  const out = [];
  for (const chunk of String(rawDiff || '').split(/^(?=diff --git )/m)) {
    const head = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!head) continue;
    const file = head[2];
    if (!/^src\/.+\.js$/.test(file) || TEST_PATH_RE.test(file)) continue; // .js only: the base copy is named by swapping the .js suffix
    const isNew = /^new file mode/m.test(chunk);
    const touched = changedNewLines(chunk);
    if (!touched.size) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(worktreeDir, file), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    const starts = [];
    lines.forEach((l, idx) => { if (TOP_LEVEL_RE.test(l)) starts.push(idx); });
    for (let k = 0; k < starts.length; k += 1) {
      const start = starts[k];
      const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)/.exec(lines[start]);
      if (!m) continue;
      const name = m[1] || m[3];
      if (!GATE_NAME_RE.test(name)) continue;
      const end = (k + 1 < starts.length ? starts[k + 1] : lines.length) - 1;
      let hit = false;
      for (let ln = start + 1; ln <= end + 1; ln += 1) if (touched.has(ln)) { hit = true; break; }
      if (!hit) continue;
      const exported = new RegExp(`module\\.exports\\s*=\\s*\\{[^}]*\\b${name}\\b`).test(text) || new RegExp(`exports\\.${name}\\s*=`).test(text);
      if (!exported) continue;
      const params = (m[2] || m[4] || '').split(',').map((q) => q.replace(/=.*$/, '').replace(/[{}\[\]\s.]/g, '')).filter(Boolean);
      out.push({ file, name, params, isNew });
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}

// The family a gate belongs to, from its first parameter names. null = no known corpus for this signature.
function inferFamily(params) {
  const [a, b] = params || [];
  if (!a) return null;
  if (/^(implementResponse|implResponse)$/i.test(a) && /^(fetchedFiles|files)$/i.test(b || '')) return 'edit-ops';
  if (/^(draftText|implementResponse|implResponse|implText|responseText|rawText|draft|response)$/i.test(a)) return 'draft-text';
  if (/^(text|content|source|code)$/i.test(a) && /^(relPath|file|filePath|path)$/i.test(b || '')) return 'file-text';
  return null;
}

// --- corpora ---------------------------------------------------------------------------------------------------------------------------------------------------

function doneTasks(pipelineDir, accept) {
  const dir = path.join(pipelineDir || '', 'queue', 'done');
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const rows = [];
  for (const name of names) {
    let t;
    try { t = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    const item = accept(t, name);
    if (item) rows.push(item);
  }
  // newest first, capped: the corpus must stay cheap enough to run on every review
  rows.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
  const cap = maxTotalChars();
  const kept = [];
  let chars = 0;
  for (const row of rows) {
    if (kept.length >= MAX_ITEMS) break;
    chars += JSON.stringify(row.args).length;
    if (chars > cap && kept.length) break;
    kept.push(row);
  }
  return kept;
}

const clip = (s) => (typeof s === 'string' && s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s);

const CORPORA = {
  'draft-text': {
    blocking: true,
    describe: 'finished tasks with an implementResponse (merged ones must not be flagged)',
    load: ({ pipelineDir }) => doneTasks(pipelineDir, (t, name) => (typeof t.implementResponse === 'string' && t.implementResponse.trim()
      ? { id: String(t.id || name).slice(0, 80), merged: !!t.mergedAt, at: t.mergedAt || t.reviewedAt || t.createdAt, args: [clip(t.implementResponse), '__WORKTREE__'] } : null)),
  },
  'edit-ops': {
    blocking: true,
    describe: 'merged tasks whose draft is edit/create ops with stored fetchedFiles (none may be flagged)',
    load: ({ pipelineDir }) => doneTasks(pipelineDir, (t, name) => {
      const ff = t.promptContext && t.promptContext.fetchedFiles;
      if (!t.mergedAt || !Array.isArray(ff) || !ff.length) return null;
      if (typeof t.implementResponse !== 'string' || !/"mode"\s*:\s*"(edit|create)"/.test(t.implementResponse)) return null;
      return { id: String(t.id || name).slice(0, 80), merged: true, at: t.mergedAt, args: [clip(t.implementResponse), ff.map((f) => ({ path: f.path, content: clip(f.content) })), { anchorSnippet: '', declaredFiles: [] }] };
    }),
  },
  'file-text': {
    blocking: false,
    describe: "the repository's own .js/.py files (reported only)",
    load: ({ worktreeDir }) => {
      const rows = [];
      const walk = (dir, depth) => {
        if (depth > 4 || rows.length >= 400) return;
        let ents;
        try { ents = fs.readdirSync(path.join(worktreeDir, dir), { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue;
          const rel = dir ? `${dir}/${e.name}` : e.name;
          if (e.isDirectory()) walk(rel, depth + 1);
          else if (/\.(?:[cm]?js|py)$/.test(e.name)) {
            try { rows.push({ id: rel, merged: false, at: '', args: [clip(fs.readFileSync(path.join(worktreeDir, rel), 'utf8')), rel] }); } catch { /* unreadable */ }
          }
        }
      };
      walk('src', 0); walk('python', 0); walk('scripts', 0);
      return rows;
    },
  },
};

// --- running one candidate ------------------------------------------------------------------------------------------------------------------------------

function summariseSide(side, items) {
  if (!side) return null;
  const mergedIds = new Set(items.filter((i) => i.merged).map((i) => i.id));
  const flaggedMerged = side.flagged.filter((f) => mergedIds.has(f.id) || f.merged);
  return { n: side.n, flagged: side.flagged.length, flaggedMerged: flaggedMerged.length, errors: side.errors, ambiguous: side.ambiguous || 0, loadError: side.loadError, _merged: flaggedMerged };
}

function replayOne({ cand, family, worktreeDir, pipelineDir, mainBranch, run, runnerSource, timeoutMs }) {
  const corpus = CORPORA[family];
  const items = corpus.load({ pipelineDir, worktreeDir });
  const base = { name: cand.name, file: cand.file, family, blocking: corpus.blocking, corpus: corpus.describe };
  if (!items.length) return { ...base, ran: false, reason: `no corpus: ${corpus.describe} -- none found` };
  const artDir = path.join(worktreeDir, ARTIFACT_DIR);
  const baseAbs = path.join(worktreeDir, cand.file.replace(/\.js$/, BASE_SUFFIX));
  if (baseAbs === path.join(worktreeDir, cand.file)) return { ...base, ran: false, reason: 'cannot name a base copy for this file' }; // never overwrite (and later delete) the file under test
  try {
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(path.join(artDir, 'runner.js'), runnerSource);
    let basePath = null;
    if (!cand.isNew && mainBranch) {
      let g = null;
      try { g = runGit(['show', `${mainBranch}:${cand.file}`], worktreeDir); } catch { /* the base has no such file: treat as new */ }
      if (typeof g === 'string' && g) { fs.writeFileSync(baseAbs, g); basePath = path.relative(worktreeDir, baseAbs); }
    }
    fs.writeFileSync(path.join(artDir, 'input.json'), JSON.stringify({ file: cand.file, fn: cand.name, basePath, worktreeDir, items: items.map(({ id, merged, args }) => ({ id, merged, args })) }));
    const r = run({ worktreeDir, bin: 'node', args: [`${ARTIFACT_DIR}/runner.js`, `${ARTIFACT_DIR}/input.json`, `${ARTIFACT_DIR}/out.json`], timeoutMs });
    if (!r || !r.ran) return { ...base, ran: false, reason: `could not run the replay: ${(r && r.reason) || 'sandbox unavailable'}` };
    if (r.timedOut) return { ...base, ran: false, reason: 'the replay timed out' };
    let out;
    try { out = JSON.parse(fs.readFileSync(path.join(artDir, 'out.json'), 'utf8')); } catch { return { ...base, ran: false, reason: `the replay produced no result (exit ${r.exitCode}): ${String(r.output || '').slice(-200)}` }; }
    const after = summariseSide(out.after, items);
    const before = summariseSide(out.before, items);
    if (after.loadError) return { ...base, ran: false, reason: after.loadError };
    const beforeIds = new Set(before ? (out.before.flagged || []).filter((f) => f.merged).map((f) => f.id) : []);
    const newlyFlaggedMerged = after._merged.filter((f) => !beforeIds.has(f.id)).slice(0, 5).map((f) => ({ id: f.id, detail: f.detail }));
    const mergedTotal = items.filter((i) => i.merged).length;
    const rate = mergedTotal ? after.flaggedMerged / mergedTotal : null;
    const strip = (s) => (s ? { n: s.n, flagged: s.flagged, flaggedMerged: s.flaggedMerged, errors: s.errors } : null);
    return { ...base, ran: true, total: items.length, mergedTotal, before: strip(before), after: strip(after), rateMerged: rate,
      newlyFlaggedMerged, newlyFlaggedMergedCount: after._merged.filter((f) => !beforeIds.has(f.id)).length, ambiguous: after.ambiguous };
  } catch (e) {
    return { ...base, ran: false, reason: `replay errored: ${String(e && e.message).slice(0, 160)}` };
  } finally {
    try { fs.rmSync(artDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(baseAbs, { force: true }); } catch { /* best-effort */ }
  }
}

// Replays every gate the diff touches. `run` is review-verify's runSandboxed (or a test double); `mainBranch` is the base ref for the "before" side.
function replayGates({ rawDiff, worktreeDir, pipelineDir, mainBranch, run, timeoutMs = RUN_TIMEOUT_MS }) {
  const result = { candidates: [], skipped: [] };
  try {
    const cands = findGateCandidates(rawDiff, worktreeDir);
    const runnerSource = fs.readFileSync(path.join(__dirname, 'gate-replay-runner.js'), 'utf8');
    for (const cand of cands) {
      const family = inferFamily(cand.params);
      if (!family) { result.skipped.push({ name: cand.name, file: cand.file, reason: `no corpus for the signature (${cand.name}(${cand.params.join(', ')}))` }); continue; }
      const one = replayOne({ cand, family, worktreeDir, pipelineDir, mainBranch, run, runnerSource, timeoutMs });
      if (one.ran) result.candidates.push(one); else result.skipped.push({ name: one.name, file: one.file, reason: one.reason });
    }
  } catch (e) {
    result.skipped.push({ name: '(replay)', file: '', reason: `replay errored: ${String(e && e.message).slice(0, 160)}` });
  }
  return result;
}

// Block only when a blocking-family gate newly flags merged work above the rate limit on a corpus big enough to mean something.
function replayVerdict(replay, { maxRate = DEFAULT_MAX_FP_RATE } = {}) {
  const reasons = [];
  for (const c of (replay && replay.candidates) || []) {
    if (!c.blocking || c.rateMerged == null || c.mergedTotal < MIN_MERGED_FOR_BLOCK) continue;
    if (c.newlyFlaggedMergedCount > 0 && c.rateMerged > maxRate) {
      reasons.push(`${c.name} (${c.file}) would flag ${c.after.flaggedMerged} of ${c.mergedTotal} already-merged tasks (${(c.rateMerged * 100).toFixed(1)}%, limit ${(maxRate * 100).toFixed(1)}%)`
        + `${c.before ? `; the base flags ${c.before.flaggedMerged}` : ''}; e.g. ${c.newlyFlaggedMerged.map((x) => x.id).slice(0, 3).join(', ')}`);
    }
  }
  return { block: reasons.length > 0, reasons };
}

function gateReplayMaxRate() {
  const v = Number(process.env.AGENT_MANAGER_GATE_REPLAY_MAX_FP_RATE);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_MAX_FP_RATE;
}

module.exports = { findGateCandidates, inferFamily, replayGates, replayVerdict, gateReplayMaxRate, CORPORA, GATE_NAME_RE, DEFAULT_MAX_FP_RATE, MIN_MERGED_FOR_BLOCK };
