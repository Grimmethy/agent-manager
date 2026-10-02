'use strict';

// Policy-change classification for the review step (brain dump "Pipeline yellow hardening 5/8, revised", 2026-10-01).
//
// Why: 12 of the 13 brain-dump-derived branches verified on 2026-10-01 changed how the pipeline ITSELF behaves -- a gate, a retry or escalation rule, a prompt block, lock timing,
// a selection or generation policy -- and 11 of those 12 went yellow: their defects only showed on real traffic (a draft-quality gate that would block 135 of 2,369 finished tasks,
// a prompt block reaching most first attempts, a source that crashes on a null) and three LLM votes approved all of them. src/gate-replay.js (7/8) now measures the gates among them
// against real data. This module is the routing layer on top: classify a finished diff as behaviour-policy-affecting, and say whether the replay SETTLED it or a human has to decide.
//
// The primary signal is the diff, not the request text: which pipeline-behaviour files it touches and what its added lines do. A pure move (file-decompose, an extraction) is exempt
// -- the same lines removed elsewhere -- and so are docs, tests, dashboard UI and ordinary application code. The request text is only a hint and never escalates on its own.
//
// Decision (decidePolicyRouting):
//   'none'           not a policy change.
//   'replay-settled' a blocking gate-replay candidate ran on a corpus of >= 20 merged tasks, so src/review-task.js's replay verdict already decided it (a human is not needed).
//   'decided'        a human already answered ("HUMAN DESIGN DECISION" in the task text): never ask twice.
//   'escalate'       policy-affecting and the replay could not settle it (no corpus: lock timing, prompt wording, retry rules; or only a reported-only family).
// Escalation is OFF by default (shadow mode records the decision on the task so the escalation rate can be measured first); AGENT_MANAGER_POLICY_CHANGE_ROUTING=true turns it on.
//
// Never throws: any failure means "not a policy change".

const MIN_MERGED_FOR_SETTLED = 20;
const MAX_SIGNALS = 6;
const MOVE_RATIO = 0.6;
const MOVE_MIN_LINES = 12;

// The pipeline's own code: everything under src/ and the shell workers. Dashboard (python/, static JS), docs, tests and fixtures are not pipeline policy.
const POLICY_FILE_RES = [/^src\/[^/]+\.js$/, /^src\/lib\/[^/]+\.js$/, /^scripts\/[^/]*\.sh$/];
const TEST_PATH_RE = /\.(?:test|spec)\.[cm]?js$|(^|\/)(?:tests?|__tests__)\//;

// What an added line does, by kind. Each is deliberately narrow: a kind is reported only when an added line actually expresses it.
const KIND_RES = [
  { kind: 'gate', re: /\b(?:blockedReason|blockedStage|verdict:\s*'blocked'|blocked:\s*true)\b|\breturn\s*\{\s*pass\s*:\s*false|\bviolations\.push\b|\bthrow new Error\([`'"][^`'"]*(?:guard|gate|zero existing|refus)/i },
  { kind: 'threshold', re: /\b(?:const|let|var)\s+[A-Z][A-Z0-9_]{3,}\s*=\s*(?:Number\()?[\d(]/ },
  { kind: 'retry', re: /\b(?:localRejectCount|MAX_LOCAL_REJECT_RETRIES|retryableDraftBlock|reviewInconclusive|needsClarification\s*=|requeue\w*\(|escalat\w+)\b/ },
  { kind: 'timing', re: /\b(?:sleepMs|backoff|Deadline|deadline|DEBOUNCE|PRIORITY_MAX_WAIT|sleep\s+\d)\b/ },
  { kind: 'selection', re: /\b(?:MAX_WINNERS|pickFair|selectWinners|candidateOrder|taskPriority\()\w*|\b(?:pool|winners|candidates)\s*=\s*[^;]*\.(?:filter|sort|slice)\(/ },
  { kind: 'prompt', re: /['"`][^'"`]*\b(?:MUST NOT|MUST|HARD RULE|HARD CONSTRAINT|do not re-grep|FORBIDDEN|ALWAYS|NEVER)\b[^'"`]*['"`]|\bis forbidden from\b/ },
  { kind: 'skip', re: /\bif\s*\((?:[^()]|\([^()]*\))*\)\s*(?:return\s*(?:null|false|undefined|''|\[\])\s*;|continue\s*;)|\breturn null;\s*\/\/.*(?:skip|abstract|nothing)/i },
];

function isTestPath(file) { return TEST_PATH_RE.test(String(file || '')); }
function isPolicyFile(file) { return !isTestPath(file) && POLICY_FILE_RES.some((re) => re.test(file)); }

// { file, added: [{ line, text }], removed: [text] } per touched file; a new-file diff has no removed lines.
function parseDiff(rawDiff) {
  const files = [];
  for (const chunk of String(rawDiff || '').split(/^(?=diff --git )/m)) {
    const head = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!head) continue;
    const file = head[2];
    const added = [];
    const removed = [];
    let n = 0;
    for (const line of chunk.split('\n')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) { n = Number(h[1]); continue; }
      if (!n) continue;
      if (line.startsWith('+') && !line.startsWith('+++')) { added.push({ line: n, text: line.slice(1) }); n += 1; }
      else if (line.startsWith('-') && !line.startsWith('---')) removed.push(line.slice(1));
      else if (line.startsWith(' ')) n += 1;
    }
    files.push({ file, added, removed });
  }
  return files;
}

const norm = (t) => String(t).trim();
const isCommentOrBlank = (t) => { const x = norm(t); return x === '' || /^(?:\/\/|\/\*|\*|#)/.test(x); };

// A pure move: nearly every added line also appears among the removed lines of the diff (a decompose / extraction), so no behaviour changed.
function looksLikePureMove(files) {
  const added = [];
  const removed = new Set();
  for (const f of files) {
    for (const a of f.added) if (!isCommentOrBlank(a.text)) added.push(norm(a.text));
    for (const r of f.removed) if (!isCommentOrBlank(r)) removed.add(norm(r));
  }
  if (added.length < MOVE_MIN_LINES) return false;
  const moved = added.filter((t) => removed.has(t)).length;
  // An extraction re-wraps the moved lines (a signature, a call, an import), so the bar is that most added lines are old lines AND about as much was removed as added.
  const removedCount = files.reduce((n, f) => n + f.removed.filter((r) => !isCommentOrBlank(r)).length, 0);
  return moved / added.length >= MOVE_RATIO && removedCount >= added.length * 0.5;
}

const TEXT_HINT_RE = /\b(?:gate|guard|threshold|retry policy|escalat\w*|backoff|cap\b|rate limit|prompt (?:block|wording)|classifier|reject drafts?)\b/i;

const REFACTOR_TITLE_RE = /\b(?:extract|move|split|decompose|rename|inline|refactor|pull out|break out)\b/i;

// A task titled as a refactor whose diff removes about as much as it adds is an extraction: behaviour is meant to be unchanged, and that is checkable elsewhere (differential
// runs), so it is not routed as a policy change. The title alone never exempts a diff that mostly ADDS new logic.
function looksLikeRefactor(files, title) {
  if (!REFACTOR_TITLE_RE.test(String(title || ''))) return false;
  let added = 0; let removed = 0;
  for (const f of files) {
    added += f.added.filter((a) => !isCommentOrBlank(a.text)).length;
    removed += f.removed.filter((r) => !isCommentOrBlank(r)).length;
  }
  return added > 0 && removed >= added * 0.4;
}

function classifyPolicyChange({ rawDiff, text, title } = {}) {
  const out = { policy: false, kinds: [], signals: [], pureMove: false, hint: false };
  try {
    out.hint = TEXT_HINT_RE.test(String(text || ''));
    const files = parseDiff(rawDiff);
    if (!files.length) return out;
    const touched = files.filter((f) => isPolicyFile(f.file));
    if (!touched.length) return out;
    if (looksLikePureMove(files) || looksLikeRefactor(files, title)) { out.pureMove = true; return out; }
    const kinds = new Set();
    for (const f of touched) {
      const promptFile = f.file === 'src/prompts.js';
      for (const a of f.added) {
        if (isCommentOrBlank(a.text)) continue;
        let hit = null;
        if (promptFile && a.text.trim().length > 20) hit = 'prompt';
        else hit = (KIND_RES.find((k) => k.re.test(a.text)) || {}).kind || null;
        if (!hit) continue;
        kinds.add(hit);
        if (out.signals.length < MAX_SIGNALS) out.signals.push({ kind: hit, file: f.file, line: a.line, text: norm(a.text).slice(0, 140) });
      }
    }
    if (kinds.size) { out.policy = true; out.kinds = [...kinds]; }
  } catch { /* classification is advisory: failure means "not a policy change" */ }
  return out;
}

function hasHumanDecision(task) {
  const raw = task && task.promptContext && task.promptContext.rawText;
  return typeof raw === 'string' && /HUMAN DESIGN DECISION \(answered/.test(raw);
}

// gateReplay is the clamped record review-task.js keeps on the task (summariseGateReplay): candidates[] each with blocking + mergedTotal.
function replaySettled(gateReplay) {
  const cands = (gateReplay && Array.isArray(gateReplay.candidates)) ? gateReplay.candidates : [];
  return cands.some((c) => c && c.blocking && Number(c.mergedTotal) >= MIN_MERGED_FOR_SETTLED);
}

function decidePolicyRouting({ classification, gateReplay, task } = {}) {
  if (!classification || !classification.policy) return { route: 'none', reason: classification && classification.pureMove ? 'a pure move: the same lines removed elsewhere' : 'not a policy change' };
  if (hasHumanDecision(task)) return { route: 'decided', reason: 'a human already answered a design question on this task' };
  if (replaySettled(gateReplay)) return { route: 'replay-settled', reason: 'a gate replay over merged work decides it' };
  return { route: 'escalate', reason: 'policy-affecting and no replay can settle it' };
}

// The one-screen brief a human sees in needs-clarification.
function buildPolicyBrief({ classification, gateReplay, taskTitle } = {}) {
  const lines = [];
  lines.push(`This change alters how the pipeline itself behaves (${(classification.kinds || []).join(', ')}) and no replay over finished work can settle whether it is right.`);
  if (taskTitle) lines.push(`Task: ${String(taskTitle).slice(0, 160)}`);
  lines.push('');
  lines.push('What the diff does (first matches):');
  for (const s of (classification.signals || []).slice(0, 4)) lines.push(`- ${s.file}:${s.line} (${s.kind}): ${s.text}`);
  const skipped = (gateReplay && Array.isArray(gateReplay.skipped)) ? gateReplay.skipped : [];
  if (skipped.length) { lines.push(''); for (const k of skipped.slice(0, 3)) lines.push(`Replay: not possible for ${k.name}: ${k.reason}`); }
  else if (!(gateReplay && gateReplay.candidates && gateReplay.candidates.length)) { lines.push(''); lines.push('Replay: the diff contains no gate, guard or detector that can be replayed over finished tasks.'); }
  lines.push('');
  lines.push('Options: (1) ship it as drafted; (2) ship it with constraints -- say which (a lower limit, a narrower trigger, advisory only first); (3) do not ship it -- Archive the task.');
  lines.push('Your answer is attached to the task and the next draft implements it; the review will not ask again.');
  return lines.join('\n');
}

function policyRoutingEnabled() { return process.env.AGENT_MANAGER_POLICY_CHANGE_ROUTING === 'true'; }

module.exports = { classifyPolicyChange, looksLikeRefactor, decidePolicyRouting, buildPolicyBrief, hasHumanDecision, replaySettled, policyRoutingEnabled, isPolicyFile, looksLikePureMove, parseDiff };
