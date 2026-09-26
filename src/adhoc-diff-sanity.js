'use strict';

// Substance gate for an adhoc task's produced diff (2026-09-02). Root-caused live via
// three needs-clarification tasks (job-list grouping, second-brain recurring source,
// mobile-access): faced with a substantial multi-file feature, the local model produces a
// plausible-looking TOKEN GESTURE that isn't the work asked for -- an ADR instead of the
// UI code, a dead unused stub function in an unrelated file, or it deletes a core file it
// was never asked to touch -- and the drafting tiers stamp that as
// `adhocResolution: 'implemented'` because their quality bar only checks "valid diff,
// applies cleanly, non-empty" and never "is this actually the change?".
//
// Five deterministic checks (1-3 original, 4-5 added 2026-09-04). Used by:
//   - adhoc-harness-draft.js (tier 1): a hit -> decline, fall through to the agentic tiers.
//   - local-agentic-draft.js (tier 2): a hit -> decline, fall through to tier 3.
//   - agentic-draft-common.js resolveAgenticDraft (tier 3 implemented branch): a hit ->
//     retryable block carrying pointed feedback, instead of a wasted review round-trip.
//
// 2026-09-04 (corpus investigation of 96 historically-stuck adhoc tasks): this file's own
// substance check only ever ran for `resolution === 'implemented'` with a non-empty diff --
// a `no-changes-needed` resolution (empty diff, by definition) sailed past it entirely, and
// a FALSE-but-checkable completion claim inside an `implemented` diff's own summary (a test
// count, a "created file X") was never cross-checked against the diff either. Both shapes
// accounted for ~43% of the historically-stuck corpus, caught only after a full review
// round-trip (sometimes several). `adhocNoChangesClaimProblem` (below) is the
// `no-changes-needed` sibling of `adhocDiffSubstanceProblem`; checks 4-5 extend
// `adhocDiffSubstanceProblem` itself with the false-completion-claim checks. Both reuse
// `extractRequestObjectTokens` (request-object-tokens.js) and `fetchForQueries`
// (arch-import-fetch.js) -- the same primitives get-grounding-source.js's
// `buildRequestObjectGrounding` already uses at REVIEW time -- moved earlier, to draft
// time, so the round-trip closes instead of just getting detected after the fact.

const { extractRequestObjectTokens } = require('./request-object-tokens.js');

// --- diff parsing -----------------------------------------------------------

// Unified git diff -> [{ path, kind: 'create'|'delete'|'edit' }]. `path` is the b/ side
// (a/ for a delete). Best-effort; a line it can't parse just isn't a changed file.
function parseChangedFiles(diff) {
  const lines = String(diff || '').split('\n');
  const files = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!m) continue;
    let kind = 'edit';
    let path = m[2];
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (/^diff --git /.test(lines[j])) break;
      if (/^new file mode /.test(lines[j])) { kind = 'create'; break; }
      if (/^deleted file mode /.test(lines[j])) { kind = 'delete'; path = m[1]; break; }
    }
    files.push({ path, kind });
  }
  return files;
}

// --- classification helpers -----------------------------------------------

const DOC_PATH_RE = /(^|\/)(docs?|adr)(\/|$)|(^|\/)(README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|AGENTS)(\.[\w-]+)?$|\.(md|mdx|markdown|rst|txt|adoc)$/i;
const isDocPath = (p) => DOC_PATH_RE.test(p);

// Does the task text ask for actual code, not just prose? A pure "write an ADR for X"
// task has none of these; job-list ("renderJobListTab() in index.html") and second-brain
// ("a new task source in src/task-sources.js") both do. Fallback only -- see
// extractDeclaredFiles below for why the task's own "Files:" line is checked FIRST.
const CODE_SIGNAL_RE = /\b(src|python|scripts|lib|app|dashboard|templates)\/|\.(js|jsx|ts|tsx|py|sh|go|rb|rs|java|html|css)\b|\b(implement|endpoint|route|task source|new (?:module|file|source|helper)|render\w*\(|def \w+\(|function \w+|wire (?:it|this|the|in)|add .{0,25}(?:to|in|into) \w[\w./-]*\.(?:py|js|html|sh)|api route|backend|cursor module|sweep logic)\b/i;

// 2026-09-16, pipeline hardening: CODE_SIGNAL_RE.test(combined) is a blind whole-blob scan
// -- it can't tell "this src/ path is the edit target" from "this src/ path is cited as
// existing context" any more than the Files:-line-absent fallback it guards. Confirmed
// live, 4+ instances: a genuinely doc-only task (e.g. "prepend an invariant note to
// AGENTS.md stating that doc accuracy is enforced by scripts/check-doc-link.sh and
// src/doc-accuracy-check.js") got hard-blocked 3/3 attempts insisting it "asks for a real
// code change," because the citation sentence itself contains code-shaped tokens.
// CITATION_CONTEXT_RE marks the common phrasings a path is cited THROUGH rather than
// targeted BY ("enforced by", "already exists", "documented in", "see", ...) -- a sentence
// containing one of these is excluded from the code-signal scan, same "citation vs.
// target" distinction extractDeclaredFiles/extractDeclaredTargets already draw elsewhere
// in this file, just applied to the blind-scan fallback path instead of a structured one.
const CITATION_CONTEXT_RE = /\b(?:enforced by|already (?:exist|implement|cover|handle|contain)s?|documented in|as (?:shown|described|documented|seen|specified) in|mentioned in|cited in|referenced in|defined in|lives? in|found in|per\b|see\b|(?:anchor|grounding) is real|confirmed (?:real|in)|the (?:real|grounding) (?:source|evidence))\b/i;

// 2026-09-21 (needs-clarification clearing, in-app chat design review): the citation markers above cannot keep up with prose. Two genuine documentation tasks
// (an AGENTS.md invariant note; a research note under docs/research/) were still blocked 3/3 by sentences that mention a code path only to say it is NOT to be touched
// ("... not files to edit", "Do NOT modify any file under src/", "cited only as a grounding anchor, not an edit target"), that merely name one inside the text the
// deliverable must contain ("the guard clause in src/foo.js"), or that are the pipeline's own boilerplate ("implement against it directly").
// Enumerating more negative markers is unbounded, and dropping whole sentences would also wave through real code tasks ("Change the timeout in src/foo.js but do not touch
// the tests"). An earlier draft that required an affirmative edit verb on EVERY path sentence broke real code tasks with unlisted verbs ("Combine job types into rows in
// index.html"). So:
//   1. negated verb phrases ("do not touch", "not files to edit", "does not implement") and the boilerplate are stripped from each sentence before the scan;
//   2. with NO stated documentation deliverable the scan is exactly the legacy one (any remaining code signal wants code);
//   3. only when the task positively states a documentation deliverable ("append ... to AGENTS.md", "create a new Markdown file at docs/...") do PATH-ONLY sentences
//      (a code path with no edit verb and no code phrase) stop counting; a sentence with a phrase signal (implement, endpoint, new module, ...), an affirmative edit
//      verb, or one that opens with an imperative ("Lazy-load the rows in index.html") on a code path still wants code.
const CODE_PATH_SIGNAL_RE = /\b(?:src|python|scripts|lib|app|dashboard|templates)\/|\.(?:js|jsx|ts|tsx|py|sh|go|rb|rs|java|html|css)\b/i;
const CODE_PHRASE_SIGNAL_RE = /\b(?:implement|endpoint|route|task source|new (?:module|file|source|helper)|render\w*\(|def \w+\(|function \w+|wire (?:it|this|the|in)|add .{0,25}(?:to|in|into) \w[\w./-]*\.(?:py|js|html|sh)|api route|backend|cursor module|sweep logic)\b/i;
const AFFIRMATIVE_EDIT_VERB_RE = /\b(?:change|edit|update|modify|replace|rewrite|append|prepend|insert|remove|delete|add|fix|create|write|refactor|extract|move|rename)\b/i;
// A negator, up to three filler words, then an edit-ish verb: "do NOT modify", "not files to edit", "does not implement", "must not be edited".
const NEGATED_VERB_RE = /\b(?:do\s*n[o']?t|don['’]t|does\s*n[o']?t|doesn['’]t|must\s+not|should\s+not|never|not|no)\b(?:\s+[\w'’-]+){0,3}?\s+(?:edit\w*|modif\w*|chang\w*|touch\w*|implement\w*|updat\w*|writ\w*|add\w*|alter\w*|delet\w*|creat\w*|replac\w*|rewrit\w*|insert\w*|remov\w*|fix\w*)\b/gi;
// The sentence the needs-clarification picker appends to a human's answer ("This answer resolves the open question(s) above -- implement against it directly rather than
// re-asking for clarification"): pipeline text, never a request to write code.
const PIPELINE_BOILERPLATE_RE = /\bimplement against (?:it|this|that|the answer)\b[^.!?\n]*/gi;
// An affirmative sentence whose object is a documentation file: "Append X to AGENTS.md", "Create a single NEW Markdown file at docs/research/x.md".
const DOC_DELIVERABLE_RE = /\b(?:append|prepend|create|write|add|merge|insert|document|record|draft)\b[^.!?\n]{0,160}?(?:\.md\b|\.txt\b|\bdocs?\/|\bMarkdown\b|\bADR\b|\bREADME\b|\bAGENTS\b)/i;

function stripNonRequests(sen) {
  return sen.replace(NEGATED_VERB_RE, ' ').replace(PIPELINE_BOILERPLATE_RE, ' ');
}

// Scan one text: { docDeliverable, tripping: [code-signal sentences left after stripping citations, negations and boilerplate] }.
function scanForCodeSignals(text) {
  // Split on sentence-ending punctuation only -- NOT a bare colon, unlike this file's
  // other sentence-scoped scans. A colon here routinely introduces elaboration that's
  // still part of the SAME citation ("The code anchor is real: src/foo.js defines ..."),
  // and splitting on it would separate the citation marker from the very code-signal
  // token it's meant to cover.
  const sentences = String(text || '').split(/(?<=[.!?])\s+|\n+/);
  let docDeliverable = false;
  const tripping = [];
  for (const sen of sentences) {
    if (CITATION_CONTEXT_RE.test(sen)) continue;
    let cleaned = stripNonRequests(sen);
    const doc = DOC_DELIVERABLE_RE.exec(cleaned);
    if (doc) {
      docDeliverable = true;
      // The deliverable clause ("Create docs/x.md") is the request itself and its object is a document: its verb must not read as an
      // edit of the code paths this same sentence goes on to cite as evidence ("... containing the audit table (routes/chat.py = ...)").
      cleaned = cleaned.replace(doc[0], ' ');
    }
    if (CODE_SIGNAL_RE.test(cleaned)) tripping.push(cleaned);
  }
  return { docDeliverable, tripping };
}

// A code PATH merely named, cited or described does not make a sentence a request -- but a sentence that OPENS WITH AN IMPERATIVE does, whatever the verb: "Lazy-load the job
// rows in index.html", "Combine job types into expandable rows in index.html" (verbs no list will ever fully cover; caught in review of the first version of this gate, which
// only honoured the listed verbs and so waved such a request through as documentation-only whenever a doc deliverable was also stated). Imperative = the first word is a plain
// word (not a path, not a "Label:") that is not a determiner, pronoun, conjunction/copula or a documentation/citation verb (cite, describe, mention, ...): "The guard clause in
// src/x.js", "It lives in src/x.js", "Cite src/x.js", "Files: src/x.js" and "src/x.js is cited ..." all stay non-requests. A wrong call here only blocks a documentation task
// for a human look; the opposite mistake ships code as docs, so this leans to counting.
const NON_IMPERATIVE_LEAD_RE = /^(?:(?:and|then|also|but|so|next|finally|plus)\s+)?(?:the|this|that|these|those|it|its|they|their|there|a|an|each|every|any|all|some|one|both|if|when|where|while|because|since|which|what|how|why|who|is|are|was|were|be|do|does|did|can|could|should|would|will|may|might|must|not|no|never|only|just|note|see|per|cite|cites|reference|mention|quote|describe|explain|state|list|include|link|summari[sz]e|name|refer|show|record|document|for|as|in|on|at|by|with|without|from|of)$/i;
// ...AND it must aim the verb at a code file: "in / into / to / inside / within <path>.<code ext>" (an imperative that merely has a path somewhere in the sentence is not enough:
// "Populate it with at least three rows: routes/chat.py:140-148 (...)" and "Decision 1: ... touching scripts/local-worker.sh" are documentation, and a first version of this
// rule, dry-run over the real queue, flipped both). A "Label:" / "Decision 1:" lead is not a verb either.
const TARGET_PATH_RE = /\b(?:in|into|to|inside|within)\s+(?:the\s+|its\s+|a\s+)?(?:[\w.-]+\/)*[\w.-]+\.(?:js|jsx|ts|tsx|py|sh|go|rb|rs|java|html|css)\b/i;
function opensWithImperative(c) {
  const m = /^[\s>*\-\d.)]*([A-Za-z][A-Za-z-]*)(?=\s)/.exec(c);
  return !!m && !NON_IMPERATIVE_LEAD_RE.test(m[1]) && TARGET_PATH_RE.test(c);
}
// A sentence still counts as asking for code when it has a phrase signal, an affirmative edit verb, or opens with an imperative.
const requestsCode = (c) => CODE_PHRASE_SIGNAL_RE.test(c) || AFFIRMATIVE_EDIT_VERB_RE.test(c) || opensWithImperative(c);

// rawText is the task's own (human / pipeline authored) text; combined is rawText + the drafting model's plan. When the raw text itself states a documentation deliverable it
// GOVERNS: the plan of a documentation task is full of sentences describing what the document will cite or quote ("cite src/drift-scan.js and its runner function", a quoted
// closing line that begins "Add ..."), which say nothing about what the task is asking for.
function wantsCodeChange(combined, rawText = null) {
  if (rawText) {
    const raw = scanForCodeSignals(rawText);
    if (raw.docDeliverable) return raw.tripping.some(requestsCode);
  }
  const all = scanForCodeSignals(combined);
  if (!all.tripping.length) return false;
  if (!all.docDeliverable) return true; // legacy behaviour, unchanged
  return all.tripping.some(requestsCode);
}

// 2026-09-08, Grimmethy: "fix the gate" -- root-caused live (a docs-only checklist-tick
// task blocked as "the task asks for a code change" because its own PLAN cited a real
// src/ file as justifying EVIDENCE for the tick, not as an edit target). CODE_SIGNAL_RE
// above just regex-scans the whole combined rawText+planText blob for anything
// code-shaped -- it can't tell "a src/ path is the edit target" from "a src/ path is
// mentioned in passing." Second Brain [[dspy]] research applied: DSPy's own reward_fn
// convention (dspy.Refine/BestOfN, replacing dspy.Assert/Suggest) validates a prediction's
// explicit, typed OUTPUT FIELD (`pred.answer`, `pred.summary`) -- never scans the
// surrounding free-form reasoning text for signals -- specifically because reasoning can
// legitimately reference things the deliverable itself doesn't touch. This pipeline
// already has the equivalent of a typed output field for "what files does this task
// touch": prompts.js instructs every task-generating prompt (research/deep-dive,
// pipeline-debrief, brain-dump-sort recommendations, ...) to emit a "Files: <comma,
// separated, REAL paths>" line, "copied verbatim" and cited as the authoritative scope.
// extractDeclaredFiles parses that structured line when present and uses IT (not the
// free-text regex) to decide whether the task wants code -- CODE_SIGNAL_RE remains the
// fallback for the (older/manual) task shapes that never had a Files: line to begin with.
function extractDeclaredFiles(text) {
  const m = /^Files:\s*(.+)$/im.exec(String(text || ''));
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw || /^none[.,:;]*$/i.test(raw)) return [];
  return raw
    .split(',')
    // Strip a trailing "(lines ~464-467)"-style annotation, backticks, and trailing
    // sentence punctuation -- the convention allows citing a path with a parenthetical
    // note, but the PATH itself is still what's being declared.
    .map((s) => s.replace(/\(.*?\)/g, '').replace(/`/g, '').replace(/[.,:;]+\s*$/, '').trim())
    .filter(Boolean);
}

// Verbs that make a delete legitimate.
const DELETE_INTENT_RE = /\b(delet\w+|remov\w+|drop\w*|deprecat\w+|rip out|tear out|get rid of|eliminat\w+|no longer needed|obsolete)\b/i;

// Explicit "do NOT touch X" / "never touches X" restriction clauses -> forbidden paths.
// Sentence-scoped so a path from an unrelated later sentence is never pulled in.
const RESTRICTION_SENTENCE_RE = /\b(?:do ?n(?:'?o?)?t|don['’]t|never|must not|no other|nothing (?:else |but )?(?:in|under)|not (?:touch|modif|chang|edit))\b.*?\b(?:touch\w*|modif\w+|chang\w+|edit\w+|alter\w+|updat\w+|delet\w+|writ\w+ (?:to|into))\b|\b(?:never|does ?n(?:'?o)?t) (?:touch\w*|modif\w+)\b/i;

// Imperative edit verbs -- gates extractDeclaredTargets' rawText-BODY scan (source 4,
// below) so a path merely cited for context doesn't get mistaken for an edit target.
const EDIT_VERB_RE = /\b(?:change|edit|update|modify|replace|rewrite|append|prepend|insert|remove|delete|add|fix)\b/i;

// A sentence that REPORTS the result of a scope check ("No other `src/` file modified --
// `git status --porcelain src/` -- PASS") is evidence about what was done, not a restriction on
// what may be done -- but it trips RESTRICTION_SENTENCE_RE's "no other ... modified" branch and
// the extractors below then forbid every path it names, including the task's own edit targets
// (adhoc-brain-dump-bd-1788906657760, blocked twice on `forbidden "src/"`). Verification
// evidence -- a git status/diff command, --porcelain/--stat, a PASS/FAIL verdict, a checked box,
// or "verified"/"confirmed" -- marks a report. An imperative prohibition ("do not", "never",
// "must not") in the same sentence wins: "Never modify src/x.js -- verify with git diff" is
// still a restriction that merely mentions a check.
const VERIFICATION_MARKER_RE = /\bgit (?:status|diff)\b|--porcelain\b|--stat\b|\b(?:PASS|FAIL)\b|\[x\]|[\u2713\u2714]|\b[Vv]erified\b|\b[Cc]onfirmed\b/;
const IMPERATIVE_PROHIBITION_RE = /\b(?:do ?n(?:'?o?)?t|don['\u2019]t|never|must not|should not|shouldn['\u2019]t|may not)\b/i;
function isVerificationReport(sentence) {
  return VERIFICATION_MARKER_RE.test(sentence) && !IMPERATIVE_PROHIBITION_RE.test(sentence);
}

function extractForbiddenPaths(text) {
  const out = new Set();
  const add = (raw) => {
    let s = String(raw || '').trim().replace(/^[`'"(]+|[`'".,;)]+$/g, '');
    if (!s) return;
    if (/^(src|python|scripts|lib|tests?|docs|node_modules)$/i.test(s)) s = s.toLowerCase() + '/';
    out.add(s);
  };
  const sentences = String(text || '').split(/(?<=[.!?:])\s+|\n+/);
  for (const sen of sentences) {
    if (!RESTRICTION_SENTENCE_RE.test(sen)) continue;
    if (isVerificationReport(sen)) continue;
    for (const p of sen.matchAll(/\b(?:src|python|scripts|lib|tests?|docs|node_modules)\/[\w./@-]*[\w]/gi)) add(p[0]);
    for (const p of sen.matchAll(/[\w./@-]+\.(?:js|jsx|ts|tsx|py|sh|go|rb|rs|java|html|css|json|ya?ml)\b/gi)) add(p[0]);
    // (?!\/[A-Za-z0-9_-]) after the capture group (2026-09-15, root-caused live): without
    // it, "...the occurrences in src/local-draft.js..." matches "in " + "src" here just as
    // readily as an actual directory-scope restriction like "anything under the src
    // directory" -- both look identical to this regex up through the bare keyword. The
    // lookahead blocks exactly the case where what follows is a real path segment
    // ("src/whatever", which this line's OWN sibling regex above already extracts
    // correctly as its own specific forbidden path), while still matching a bare trailing
    // reference like "anything under src/" or "this task never touches src/" (nothing
    // path-like immediately after the slash, or no slash at all).
    for (const p of sen.matchAll(/(?:anything|everything|any(?: of the)? files?)?\s*(?:under|inside|within|in)\s+(?:the\s+)?["'`]?(src|python|scripts|lib|tests?|docs)(?!\/[A-Za-z0-9_-])["'`]?(?:\s+(?:dir\w*|folder|tree|directory))?/gi)) add(p[1]);
    if (/\b(?:under|anything|everything|whole|entire|any (?:file|change) (?:in|under))\b/i.test(sen)) {
      // Same reasoning as the loop above -- a restriction sentence can trip this
      // trigger-word check (e.g. its own "anything under...") while ALSO citing an
      // unrelated specific path elsewhere in the same sentence; without the lookahead,
      // "src/some-file.js" mentioned anywhere in such a sentence would wrongly add bare
      // "src" as forbidden too.
      for (const p of sen.matchAll(/\b(src|python|scripts|lib)(?!\/[A-Za-z0-9_-])\b/gi)) add(p[1]);
    }
  }
  return [...out];
}

function pathHitsForbidden(changedPath, forbidden) {
  const cp = changedPath.replace(/^\.\//, '');
  const base = cp.split('/').pop();
  return forbidden.find((f) => {
    if (f.endsWith('/')) return cp === f.slice(0, -1) || cp.startsWith(f);
    if (cp === f) return true;
    // path with no extension ("src/apply-adhoc-diff") -> match "src/apply-adhoc-diff.js"
    if (f.includes('/') && !/\.\w+$/.test(f)) return cp === f || cp.startsWith(`${f}.`);
    // a bare filename restriction matches by basename
    if (!f.includes('/')) return base === f || base.startsWith(`${f}.`);
    return false;
  });
}

// Paths the task ITSELF declares as an edit target: the structured `Files:` line, a
// path token in a non-restriction fragment of the title (a decompose / "wire up" task
// names the file it must edit right in its title), or an explicit `edit_file` /
// `EDIT ... <path>` mention in the plan body. Mirror image of the 2026-09-08 "fix the
// gate" change on check 3 (a path cited as EVIDENCE misread as an edit target): a
// scope-discipline clause in the task's OWN plan -- "No other lines in `index.html`
// were modified", "Do not touch CSS, HTML structure" -- is guidance on how to edit the
// target carefully, not a prohibition on touching it at all. extractForbiddenPaths'
// output is filtered against this set so the forbidden-path gate only ever fires for a
// path that is NOT one of the task's declared targets.
function extractDeclaredTargets(task, planText = '') {
  const out = new Set();
  const add = (raw) => {
    const s = String(raw || '').trim().replace(/^[`'"(]+|[`'".,;)]+$/g, '').replace(/^\.\//, '');
    if (s) out.add(s);
  };
  const rawText = task && ((task.promptContext && task.promptContext.rawText) || task.title);
  // 1. The authoritative structured `Files:` line, when the task has one.
  for (const p of (extractDeclaredFiles(rawText) || [])) add(p);
  // 2. Path tokens in the TITLE -- but only from fragments that are NOT themselves a
  //    restriction clause, so "Refactor src/a.js, do not touch src/b.js" keeps b.js
  //    forbidden. Same two token regexes extractForbiddenPaths uses.
  for (const frag of String((task && task.title) || '').split(/(?<=[.!?:;])\s+|\s+[—-]\s+/)) {
    if (RESTRICTION_SENTENCE_RE.test(frag)) continue;
    for (const m of frag.matchAll(/\b(?:src|python|scripts|lib|tests?|docs|node_modules)\/[\w./@-]*[\w]/gi)) add(m[0]);
    for (const m of frag.matchAll(/[\w./@-]+\.(?:js|jsx|ts|tsx|py|sh|go|rb|rs|java|html|css|json|ya?ml)\b/gi)) add(m[0]);
  }
  // 3. Explicit edit-target mentions in the plan body.
  const plan = String(planText || '');
  for (const m of plan.matchAll(/\b(?:edit_file|write_file)\b[^\n]*?`([\w./@-]+\.\w+)`/gi)) add(m[1]);
  for (const m of plan.matchAll(/\b(?:EDIT\b|Wire up\b[^\n]*?\binto)\b[^\n]*?`([\w./@-]+\.\w+)`/gi)) add(m[1]);
  // 4. A leading "In `<path>`, <verb> ..." clause in the rawText BODY, not just the TITLE
  // (2026-09-16, pipeline hardening) -- a decompose child's title sometimes names a
  // DIFFERENT file than the one its own rawText body actually instructs editing (the
  // parent decompose pass chose the title; the per-symbol instruction lives in the body
  // prose, e.g. "In `python/test_build_graph.py`, change the module docstring on line 2
  // ..."), so that real, explicitly-named target was invisible to every source above and
  // could get wrongly caught by a forbidden-path restriction meant for sibling sub-tasks.
  // Deliberately narrow (the path must be the subject of a LEADING "In X," clause, not
  // just co-located anywhere in a sentence that happens to also contain an edit verb) --
  // a looser same-sentence scan reintroduces the exact false-positive shape this fixes: a
  // sentence like "Prepend a note stating X is enforced by scripts/check-doc-link.sh" has
  // an edit verb (Prepend) and a path (scripts/check-doc-link.sh) that are NOT the same
  // thing; only the tight leading-clause anchor tells target from citation apart.
  //
  // Tolerates one parenthetical aside between the path and the comma (2026-09-19,
  // ghost-in-the-machine retroactive audit): "In src/group-b-worktree-diff.test.js
  // (append at end, after the stacked-branch tests), add two tests:" is a completely
  // ordinary way to write a leading "In X, ..." clause, but the old regex demanded the
  // comma immediately after the path -- missing this declared target let a SEPARATE
  // extraction gap (extractForbiddenPaths reading the plan's own "no other changes to
  // `<file>`" self-scoping language as if it forbade that exact file) go unreconciled,
  // wrongly blocking a 9-attempt-and-counting task from touching the one file it was
  // explicitly told to edit. The aside's own comma(s) are inside the parens, so `[^)]*`
  // stays balanced without needing real paren-nesting support.
  for (const p of leadingInClauseTargets(rawText)) add(p);
  // 5. The SAME leading "In `<path>`, <verb> ..." clause, but in the PLAN body instead of
  // the task's own rawText (2026-09-19, same incident as the parenthetical fix above,
  // second half): the model's OWN plan frequently declares its edit target this exact
  // way -- "In `src/local-draft.js`, immediately before the `try {` ..., add exactly:" --
  // when the human task text never named the file at all (it described a symptom/
  // behavior, e.g. "task.localRejectCount read inside the try without null-guard", and
  // left the model's own grep-grounded plan to pin the real site). rawText-only scoping
  // (rule 4 above) never saw this, so a real, singular declared target went unrecognized
  // and a self-scoping "No other file in `src/` is modified" sentence elsewhere in that
  // SAME plan broadly forbade all of src/ -- including the one file the plan had just
  // named as its edit target two paragraphs earlier.
  for (const p of leadingInClauseTargets(plan)) add(p);
  return [...out];
}

// Shared by extractDeclaredTargets' rules 4 and 5 -- a leading "In `<path>` (aside)?,
// <verb> ..." clause, scanned against whichever text is passed (task rawText or plan
// body). See rule 4's own header comment for the full rationale and false-positive shape
// this stays deliberately narrow to avoid reintroducing.
function leadingInClauseTargets(text) {
  const out = [];
  for (const frag of String(text || '').split(/(?<=[.!?:;])\s+|\n+/)) {
    const sentence = frag.trim();
    if (RESTRICTION_SENTENCE_RE.test(sentence)) continue;
    const leading = /^(?:In|At)\s+[`'"]?([\w./@-]+\.\w+)[`'"]?\s*(?:\([^)]*\)\s*)?,/i.exec(sentence);
    if (leading && EDIT_VERB_RE.test(sentence)) out.push(leading[1]);
  }
  return out;
}

// Loose path equality shared by the forbidden-vs-target reconciliation. Mirrors
// pathHitsForbidden's own matching latitude but symmetric: a bare filename or an
// extensionless dir-prefix restriction still lines up with the concrete target path.
function pathsRefEqual(a, b) {
  const na = String(a || '').replace(/^\.\//, '');
  const nb = String(b || '').replace(/^\.\//, '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  const hasExt = (s) => /\.\w+$/.test(s);
  // Directory-shaped forbidden entry ("src/", from extractForbiddenPaths' bare-"src"
  // normalization) reconciles against any target file it contains ("src/local-draft.js")
  // -- same "declared target wins" rule the extensionless-prefix checks below already
  // give a bare-name restriction, just for the trailing-slash directory spelling. Without
  // this, a task whose own plan says e.g. "don't touch other files under src/" produces a
  // forbidden "src/" entry that this function can never reconcile against the task's own
  // declared target (it only handled "src/foo" vs "src/foo.js", not "src/" vs
  // "src/foo.js") -- so the gate blocked the task from editing the exact file it was told
  // to edit. Confirmed live 2026-09-13 on adhoc-add-spec-comment-at-call-site-in-src-
  // local-draft-js-1789232601161-1.
  if (na.endsWith('/') && nb.startsWith(na)) return true;
  if (nb.endsWith('/') && na.startsWith(nb)) return true;
  if (na.includes('/') && !hasExt(na) && (nb === na || nb.startsWith(`${na}.`))) return true;
  if (nb.includes('/') && !hasExt(nb) && (na === nb || na.startsWith(`${nb}.`))) return true;
  // Same basename when BOTH sides are concrete files with a known extension -- covers the
  // common shape where the restriction clause writes a bare "index.html" and the target
  // (and the diff) carry the full "python/dashboard/templates/index.html".
  if (hasExt(na) && hasExt(nb) && !na.endsWith('/') && !nb.endsWith('/')) {
    return na.split('/').pop() === nb.split('/').pop();
  }
  return false;
}

// --- the gate -------------------------------------------------------------

function isAdhoc(task) {
  return !!task && (task.source === 'manual' || task.domain === 'adhoc');
}

const PLAN_TARGETS_HINT = 'Implement the actual change in the file(s) the plan/task names';

// --- false-completion-claim helpers (checks 4-5) ---------------------------

// "all 14 tests pass" / "all 24 tests" / "12 tests added" / "8 tests passing" -- the
// specific phrasing corpus incidents actually used. Deliberately narrow (a claim this
// check can't parse just isn't checked, never blocks).
const ALL_N_TESTS_RE = /\ball\s+(\d+)\s+tests?\b/i;
const N_TESTS_CLAIM_RE = /\b(\d+)\s+tests?\s+(?:pass(?:es|ed|ing)?|added)\b/i;

// `kind` separates a QUANTITY claim about the diff ("12 tests added") from a STATUS report
// ("All 14 tests pass" -- the N tests in the file, which can far exceed what this diff adds
// when it extends an existing test file; change_review AC-72 caught the 1054f01 regression
// where a truthful "All 5 tests pass" after adding 1 test to a 4-test file was rejected).
function extractClaimedTestCount(summary) {
  const all = ALL_N_TESTS_RE.exec(summary);
  if (all) return { count: Number(all[1]), kind: 'status' };
  const m = N_TESTS_CLAIM_RE.exec(summary);
  if (!m) return null;
  return { count: Number(m[1]), kind: /added/i.test(m[0]) ? 'added' : 'status' };
}

// Counts distinct test definitions ADDED by the diff (Python def test_..., JS it()/test()).
// Line-level, not AST -- consistent with this file's existing diff-parsing style.
function countAddedTestDefs(diff) {
  let n = 0;
  for (const line of String(diff || '').split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (/\bdef\s+test_\w+\s*\(/.test(line) || /\b(?:it|test)\(\s*['"`]/.test(line)) n++;
  }
  return n;
}

// "creates the file `x.py`" / "created file 'x.js'" -- checked against parseChangedFiles'
// own `create`-kind entries.
const CREATES_FILE_RE = /creat(?:e|ed|es)\s+(?:the\s+|a\s+)?(?:new\s+)?file\s+[`'"]([^`'"]+)[`'"]/i;

function extractClaimedCreatedFile(summary) {
  const m = CREATES_FILE_RE.exec(summary);
  return m ? m[1].trim() : null;
}

// --- no-changes-needed claim helpers (adhocNoChangesClaimProblem) ----------

const ALREADY_COVERED_RE = /already covered:/i;

// Every line under "Already covered:" (or anywhere else in the summary -- a citation
// written in prose still counts), so a token that appears ANYWHERE in the response text
// is treated as covered, not just inside the literal header block.
function tokenMentioned(token, summary) {
  return summary.toLowerCase().includes(String(token).toLowerCase());
}

// Returns null if the diff looks like a real, on-task implementation, else
// { code, reason, retryFeedback }.
// Does this task's text ask for a code change? The task's own "Files:" line is authoritative when present; otherwise the (negation-aware) scan above.
function taskWantsCodeFromText(rawText, combined) {
  const declaredFiles = extractDeclaredFiles(rawText);
  return declaredFiles ? declaredFiles.some((p) => !isDocPath(p)) : wantsCodeChange(combined, rawText);
}

// Task-level form of the same decision (for the known-fixed-failures registry): the gate's verdict on `task` with a docs-only diff, without needing a diff.
function taskWantsCodeChange(task) {
  const rawText = (task && task.promptContext && task.promptContext.rawText) || (task && task.title) || '';
  const planText = (task && (task.planResponse || task.lastGoodPlan)) || '';
  return taskWantsCodeFromText(rawText, `${rawText}\n${planText}`);
}

function adhocDiffSubstanceProblem(task, rawDiff, summary = '') {
  if (!isAdhoc(task) || !String(rawDiff || '').trim()) return null;
  const rawText = (task.promptContext && task.promptContext.rawText) || task.title || '';
  const planText = task.planResponse || task.lastGoodPlan || '';
  const combined = `${rawText}\n${planText}`;
  const files = parseChangedFiles(rawDiff);
  if (files.length === 0) return null; // can't parse -- don't block on this check

  // 1. Explicit "do NOT touch X" violation -- most specific, checked first. A path the
  //    task itself declares as an edit target is never "forbidden": its own plan's
  //    scope-discipline language ("no other lines in index.html were modified") must not
  //    lock the drafter out of the file it was told to change. See extractDeclaredTargets.
  const targets = extractDeclaredTargets(task, planText);
  const forbidden = extractForbiddenPaths(combined)
    .filter((f) => !targets.some((t) => pathsRefEqual(f, t)));
  if (forbidden.length) {
    const violations = files.map((f) => ({ f, hit: pathHitsForbidden(f.path, forbidden) })).filter((v) => v.hit);
    if (violations.length) {
      const list = violations.map((v) => `${v.f.path} (matches forbidden "${v.hit}")`).join(', ');
      return {
        code: 'forbidden-path',
        reason: `diff touches ${list} -- the task explicitly says not to`,
        retryFeedback: `Your diff modified ${violations.map((v) => v.f.path).join(', ')}, which the task EXPLICITLY forbids ("${forbidden.join('", "')}"). Discard those changes entirely. ${PLAN_TARGETS_HINT}, and nowhere else.`,
      };
    }
  }

  // 2. Deletes a file the task never asked to delete.
  const deletes = files.filter((f) => f.kind === 'delete');
  if (deletes.length && !DELETE_INTENT_RE.test(rawText)) {
    const list = deletes.map((d) => d.path).join(', ');
    return {
      code: 'unrequested-delete',
      reason: `diff deletes ${list} but the task never asked to delete anything`,
      retryFeedback: `Your diff DELETES ${list}. The task never asked for a deletion -- removing a file is almost certainly wrong here. Do not delete anything. ${PLAN_TARGETS_HINT}.`,
    };
  }

  // 3. Docs-only diff for a task that clearly wants code. The task's own "Files:" line
  // (when present) is authoritative -- see extractDeclaredFiles's own header for why a
  // free-text keyword scan can't distinguish an edit target from a cited-as-evidence
  // path. Only falls back to CODE_SIGNAL_RE's blind scan when no Files: line exists.
  const nonDoc = files.filter((f) => !isDocPath(f.path));
  if (nonDoc.length === 0) {
    if (taskWantsCodeFromText(rawText, combined)) {
      return {
        code: 'docs-only',
        reason: `diff only touches documentation (${files.map((f) => f.path).join(', ')}) -- the task asks for a code change`,
        retryFeedback: `Your diff only created/edited documentation (${files.map((f) => f.path).join(', ')}). That is not the deliverable -- the task asks for a real code change. ${PLAN_TARGETS_HINT}. A doc/ADR, if the task asks for one at all, comes LAST, after the code is written and checked.`,
      };
    }
  }

  // 4. A checkable "all N tests pass/added" claim contradicted by the diff's own test defs.
  const claimed = extractClaimedTestCount(summary);
  // A status claim ("All N tests pass") equals the diff's added tests only when the diff
  // CREATES every file it touches (a brand-new test file); against an edited existing file the
  // two are different numbers, so only an explicit "N tests added" claim is comparable there.
  const comparable = claimed !== null && (claimed.kind === 'added' || files.every((f) => f.kind === 'create'));
  if (comparable) {
    const claimedTests = claimed.count;
    const actualTests = countAddedTestDefs(rawDiff);
    if (actualTests < claimedTests) {
      return {
        code: 'false-test-count-claim',
        reason: `summary claims ${claimedTests} tests but the diff only adds ${actualTests} test definition(s)`,
        retryFeedback: `Your summary claims ${claimedTests} tests, but the diff you produced only adds ${actualTests} test definition(s). Either write the tests you claimed, or correct the summary to match what the diff actually contains -- do not report a count you didn't verify against your own diff.`,
      };
    }
  }

  // 5. A checkable "creates the file X" claim contradicted by the diff's own file list.
  const claimedFile = extractClaimedCreatedFile(summary);
  if (claimedFile) {
    const created = files.some((f) => f.kind === 'create' && (f.path === claimedFile || f.path.endsWith(`/${claimedFile}`) || claimedFile.endsWith(f.path)));
    if (!created) {
      return {
        code: 'false-file-creation-claim',
        reason: `summary claims it creates \`${claimedFile}\` but the diff has no "new file" entry for that path`,
        retryFeedback: `Your summary claims you created \`${claimedFile}\`, but your diff has no "new file" entry for that path. Either actually create it in the diff, or correct the summary -- do not claim a file exists that your own diff doesn't create.`,
      };
    }
  }

  return null;
}

// The no-changes-needed sibling of adhocDiffSubstanceProblem. Returns null if the claim
// looks genuinely grounded, else { code, reason, retryFeedback }.
function adhocNoChangesClaimProblem(task, summary) {
  if (!isAdhoc(task)) return null;
  const text = String(summary || '');
  if (!text.trim()) return null; // an empty response is handled elsewhere (turn-budget path)

  // Check A: no "Already covered:" block at all -- the single most common shape in the
  // corpus (a bare refusal or meta-commentary response with no coverage breakdown).
  if (!ALREADY_COVERED_RE.test(text)) {
    return {
      code: 'missing-citation-block',
      reason: 'no "Already covered:" block at all',
      retryFeedback: 'You answered RESOLUTION: no-changes-needed but gave no "Already covered:" block. Before that resolution is valid, you MUST list every concrete object/endpoint/field the request names, one line each, as `<object> -- <path>:<symbol>`, pointing at the REAL current file:symbol that covers it. If you cannot fill in a real file:symbol for every object the request names, it is NOT no-changes-needed -- implement the missing part instead.',
    };
  }

  // Check B: a distinctive named object is neither mentioned anywhere in the response NOR
  // findable anywhere in the live repo -- a double-negative confirmation the "already
  // covered" claim is false for that specific object.
  const rawText = (task.promptContext && task.promptContext.rawText) || task.title || '';
  const tokens = extractRequestObjectTokens(rawText).filter((tok) => !tokenMentioned(tok, text));
  if (tokens.length === 0) return null;

  let fetchForQueries;
  try {
    ({ fetchForQueries } = require('./arch-import-fetch.js'));
  } catch {
    return null; // can't verify -- don't block on this check
  }
  const variantToTok = new Map();
  const queries = [];
  for (const tok of tokens) {
    for (const v of new Set([tok, tok.toLowerCase(), tok.toUpperCase()])) {
      if (!variantToTok.has(v)) { variantToTok.set(v, tok); queries.push(v); }
    }
  }
  let hits = [];
  try {
    hits = fetchForQueries(queries).hits || [];
  } catch {
    return null; // grep failed -- don't block on this check
  }
  const hasHit = new Set();
  for (const h of hits) { const tok = variantToTok.get(h.query); if (tok) hasHit.add(tok); }
  const ungrounded = tokens.filter((tok) => !hasHit.has(tok));
  if (ungrounded.length === 0) return null;

  const list = ungrounded.map((t) => `"${t}"`).join(', ');
  return {
    code: 'ungrounded-named-object',
    reason: `the request names ${list}, which appears in neither your "Already covered:" citations nor anywhere in the current repo`,
    retryFeedback: `The request names ${list}. Your response doesn't cite it, and a search of the current repo found no trace of it either -- that is a strong signal it is NOT already covered. For each of these, either point at the real file:symbol that implements it, or implement the missing piece. Do not answer no-changes-needed while any of these remain unaccounted for.`,
  };
}

module.exports = {
  adhocDiffSubstanceProblem, adhocNoChangesClaimProblem, parseChangedFiles, extractForbiddenPaths,
  extractDeclaredTargets, pathsRefEqual, taskWantsCodeChange,
};
