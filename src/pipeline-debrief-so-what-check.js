'use strict';

// Post-implement citation check for pipeline_debrief reports (2026-09-12). Root-caused
// live from a 6-task sample (and a wider 31-task blocked cluster): the drafting prompt
// (pipelineDebriefImplementPrompt, prompts.js) tells the model "Cite task id + history
// stage + model_calls row for each [SO WHAT] flag", and the evidence it's given is
// genuinely well-structured for this -- each audited task gets its own labeled
// "### COMPLETED N: <real-task-id>" block with a model_calls breakdown right under it.
// The model still, inconsistently, writes a generic aggregate claim ("across all 25
// tasks...") with zero citation. Confirmed live via a controlled re-test: the SAME task's
// SAME real evidence, re-run fresh (no priorRejectionFeedback), succeeded with real
// citations one time and failed the identical way a second time -- not a hard capability
// ceiling, but not reliably self-correcting either, and prior real attempts show the
// existing free-text priorRejectionFeedback loop repeating the identical generic mistake
// after being told about it twice in a row.
//
// This check is purely deterministic (no model call) -- unlike deep-dive-grounding-
// check.js's Check 2 fallback, there's no "is this semantically accurate" judgment to
// make here, only "did the SO WHAT section cite ANY of the real, closed set of evidence
// items it was handed." Wired via the generic, source-agnostic `postImplementCheck` hook
// (local-draft.js) -- same convention as deep_dive/function_length_review/premiseCheck;
// an 'ungrounded' verdict routes into the exact same blockedStage:'review' path a real
// review rejection takes, so the existing redraft/priorRejectionFeedback machinery picks
// it up unchanged. The rejection message lists the REAL valid citation tokens (same
// "closed-list" discipline this file's own prompts.js NOW-WHAT-Files-line fix already
// uses) so the next attempt has concrete options instead of vague English feedback.
//
// Kill switch: AGENT_MANAGER_PIPELINE_DEBRIEF_SO_WHAT_CHECK=false.

const { classifyNullOutcome } = require('./advisory-null-outcome.js');

const COMPLETED_BLOCK_RE = /### COMPLETED (\d+):/g;
const NO_CONFIDENT_RE = /^\s*NO CONFIDENT INEFFICIENCY\b/i;

function isEnabled() {
  return process.env.AGENT_MANAGER_PIPELINE_DEBRIEF_SO_WHAT_CHECK !== 'false';
}

// Real, closed set of "COMPLETED N" numbers this task's evidence actually contains --
// the ONLY citation tokens a compliant SO WHAT may reference.
function realCompletedNumbers(task) {
  const evidenceText = (task.promptContext && task.promptContext.evidenceText) || '';
  const numbers = [];
  let m;
  COMPLETED_BLOCK_RE.lastIndex = 0;
  while ((m = COMPLETED_BLOCK_RE.exec(evidenceText))) numbers.push(m[1]);
  return numbers;
}

// 2026-09-28: also includes contrastIds -- debrief-bundle.js's evidence text carries a
// "### CONTRAST N (STILL STUCK, same source)" block for each still-stuck sibling task
// alongside the "### COMPLETED N" shipped ones (both real, both shown to the drafter,
// both named in the prompt: prompts.js's "Contrast (still-stuck, same source) tasks:"
// line), and task-sources.js already stores contrastIds on the task record right next to
// taskIds -- but this function only ever read taskIds, so a SO WHAT flag that legitimately
// cites a contrast task as comparative evidence (a real, common pattern: "did the stuck
// ones burn out at the same stage" is literally what the prompt asks the drafter to
// check) was rejected as ungrounded even though the citation was 100% real. Root-caused
// live from 2 of 12 currently-blocked debriefs both citing a real contrastId with no
// other match.
function realTaskIds(task) {
  const ctx = task.promptContext || {};
  const ids = [...(ctx.taskIds || []), ...(ctx.contrastIds || [])];
  return ids.filter((id) => typeof id === 'string' && id);
}

// Isolates the SO WHAT section (between its own heading and the next section heading) --
// the citation requirement is specific to SO WHAT, not the whole report (WHAT is a
// call-profile summary, NOW WHAT has its own separate Files: line discipline already
// enforced elsewhere). Falls back to the whole text when the heading can't be found
// cleanly, matching this codebase's "can't isolate it -> check what we have, never throw"
// discipline (same as deep-dive-grounding-check.js's realFilesOf/checkFabricatedSymbols
// pattern of degrading to a no-op rather than a false block).
function extractSoWhatSection(text) {
  const m = /SO WHAT\s*\n([\s\S]*?)(?:\n\s*ALREADY-DETERMINISTIC CHECK\b|\n\s*NOW WHAT\b|$)/i.exec(text);
  return m ? m[1] : text;
}

// A citation counts when it names something that REALLY IS in this task's evidence -- never anything else. 2026-09-27, measured on the 21
// blocked debriefs: 17 of them did cite real evidence, just not as the exact string "COMPLETED N" / a full task id (8 used a real `bd-<digits>`
// token from a task id, 8 wrote "Task N" or "COMPLETED #N" with N a real block number, 1 a long id prefix), and were rejected as ungrounded;
// the 5 generic aggregates ("across all 25 tasks") and 1 uncited report are what this gate exists to catch and still fail. The drafter is not
// handed citations automatically -- that would fake grounding -- this only stops rejecting real ones written in another form. A number or id
// that is not in the evidence never satisfies any form below.
const MIN_ID_PREFIX_CHARS = 24;

// 2026-09-28: task ids/contrastIds in this pipeline are long, auto-generated, hyphen-
// joined slugs (e.g. `adhoc-fix-corrupted-nul-bytes-in-src-lib-implement-critique-js-
// dedup-k...`) or `change-review-<7-char-hash>` labels. Measured live on 9 of 12
// currently-blocked debriefs: the drafter routinely cites a real, meaningful FRAGMENT
// pulled from the middle of one of these ids ("nul-bytes", "guard-review-gate",
// "53b8f52") rather than the exact "COMPLETED N" form, a full id, a bd-<digits> token, or
// the 24-char PREFIX form (b)/(c) already accept -- none of which cover a mid-string
// fragment. Extracts every hyphen-joined multi-word run (>=2 segments, >=8 chars
// combined) and every short hash-like token (6-8 alnum chars containing at least one
// digit) from the real ids, once per check call -- same "real evidence, closed set"
// discipline as every other form here: a fragment that is not a substring of some real
// id can never match, so this cannot fabricate grounding, only recognize a real citation
// written in a shorter shape. A fragment shared by MULTIPLE real ids (e.g. "brain-dump-
// sort", a common source-name prefix) names the task TYPE, not one item, and is excluded
// -- only a fragment that uniquely identifies exactly one real id counts.
const HASH_TOKEN_RE = /^(?=.*[0-9])[a-z0-9]{6,8}$/;

// Counts which real ids each candidate fragment appears in -- a fragment shared by many
// ids (e.g. "brain-dump-sort", a shared SOURCE prefix on every brain_dump_sort id) names
// the task TYPE, not a specific evidence item, and must not satisfy the citation
// requirement on its own (same reasoning as "across all N tasks" already failing). Only a
// fragment that uniquely identifies exactly ONE real id counts.
function uniqueSlugFragments(ids) {
  const owners = new Map(); // frag -> Set of ids it appears in
  for (const id of ids) {
    const parts = id.toLowerCase().split(/[-_]/).filter(Boolean);
    const seen = new Set();
    for (let i = 0; i < parts.length; i++) {
      if (HASH_TOKEN_RE.test(parts[i])) seen.add(parts[i]);
      for (let j = i + 2; j <= parts.length; j++) {
        const frag = parts.slice(i, j).join('-');
        if (frag.length >= 8) seen.add(frag);
      }
    }
    for (const frag of seen) {
      if (!owners.has(frag)) owners.set(frag, new Set());
      owners.get(frag).add(id);
    }
  }
  const unique = new Set();
  for (const [frag, idSet] of owners) if (idSet.size === 1) unique.add(frag);
  return unique;
}

function citesFragment(soWhatLower, ids) {
  for (const frag of uniqueSlugFragments(ids)) {
    if (new RegExp(`(?<![a-z0-9-])${frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`).test(soWhatLower)) return true;
  }
  return false;
}

function citesEvidence(soWhat, completedNumbers, taskIds) {
  const real = new Set(completedNumbers.map(String));
  // (d) the original exact forms
  if (completedNumbers.some((n) => new RegExp(`\\bCOMPLETED\\s+${n}\\b`).test(soWhat))) return true;
  if (taskIds.some((id) => soWhat.includes(id))) return true;
  // (a) "COMPLETED #2", "COMPLETED2", "task 3", and lists: "Tasks 1, 3 and 5"
  const numRef = /\b(?:COMPLETED|Tasks?)\s*#?\s*(\d+(?:\s*(?:,|and|&|\/|-|\u2013)\s*#?\d+)*)/gi;
  let m;
  while ((m = numRef.exec(soWhat))) {
    if ((m[1].match(/\d+/g) || []).some((n) => real.has(String(Number(n))))) return true;
  }
  // (b) a `bd-<10+ digits>` token that occurs inside some real task id
  const realBd = new Set(taskIds.flatMap((id) => id.match(/bd-\d{10,}/g) || []));
  if ((soWhat.match(/bd-\d{10,}/g) || []).some((t) => realBd.has(t))) return true;
  // (c) a long, distinctive prefix of a real task id
  if (taskIds.some((id) => id.length >= MIN_ID_PREFIX_CHARS && soWhat.includes(id.slice(0, MIN_ID_PREFIX_CHARS)))) return true;
  // (e) a real, distinctive mid-string slug fragment (see slugFragments above)
  return citesFragment(soWhat.toLowerCase(), taskIds);
}

// task, implementResponse -> { verdict: 'ok'|'ungrounded', reason? }
function runSoWhatCitationCheck(task, implementResponse) {
  if (!isEnabled()) return { verdict: 'ok' };
  const text = String(implementResponse || '');
  if (!text.trim()) return { verdict: 'ok' }; // empty is handled by the degenerate-output gate, not this check
  if (NO_CONFIDENT_RE.test(text.trim())) return { verdict: 'ok' }; // a valid, correct terminal outcome -- nothing to cite
  if (classifyNullOutcome('pipeline_debrief', text)) return { verdict: 'ok' }; // the same null as a justified line inside the report (advisory-null-outcome.js): nothing to cite

  const completedNumbers = realCompletedNumbers(task);
  const taskIds = realTaskIds(task);
  if (!completedNumbers.length && !taskIds.length) return { verdict: 'ok' }; // nothing real to cite against -- don't invent a requirement the evidence itself can't support

  const soWhat = extractSoWhatSection(text);
  if (citesEvidence(soWhat, completedNumbers, taskIds)) return { verdict: 'ok' };

  const sample = completedNumbers.slice(0, 5).map((n) => `COMPLETED ${n}`).join(', ');
  return {
    verdict: 'ungrounded',
    reason: `SO WHAT does not cite any specific evidence item (a "COMPLETED N" reference or a real task id) for its flagged inefficiency -- it must cite at least one, e.g.: ${sample || '(see evidence)'}. A generic aggregate claim ("across all N tasks...") with no citation is not grounded, even if the underlying observation is correct. Accepted citation forms: "COMPLETED N" or "Task N" (N a real block number), a real task id (including a still-stuck CONTRAST task), its bd-<digits> token, or a distinctive fragment of a real id (e.g. "nul-bytes" from a longer id, or a short hash like "53b8f52").`,
  };
}

module.exports = { runSoWhatCitationCheck, realCompletedNumbers, realTaskIds, extractSoWhatSection };
