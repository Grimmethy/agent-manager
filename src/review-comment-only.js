'use strict';

// review-comment-only.js -- is a unified diff a COMMENT-ONLY change? (2026-10-31, discard analysis)
//
// Why: 10 brain-dump branches since 2026-10-24 were discarded because their whole change was comments or docstrings in a test or source file
// (questforge test/schedule.test.js: three '// intentional: deep clone ...' comments; a test docstring claiming 'Reviewed: ...'). Nothing behaves
// differently, the file passes on the base too, and the voters still approved them (2/3), because a comment-only diff reads as correct and complete.
//
// What "comment-only" means here: for every file, take the REMOVED lines and the ADDED lines separately, strip the comments from each, drop the lines that
// are then empty, and compare. The diff is comment-only when the remaining code is IDENTICAL on both sides and at least one comment actually changed. So a
// new comment, a deleted comment, a reworded trailing comment (`foo(); // old` -> `foo(); // new`) and added/removed blank lines all qualify; one changed
// code character does not.
//
// Conservative by construction (a wrong "yes" would throw real work away; a wrong "no" only means the normal vote happens):
//   - only JS/TS (// and /* */), Python (# and docstrings) and #-comment files (sh, yaml, toml); any other file type, a new, deleted or renamed file, a binary
//     file, Markdown, or a diff that cannot be parsed makes the whole diff NOT comment-only;
//   - comment syntax is only trusted where this hunk can see it begin: a line inside a block comment or a docstring whose opener is outside the hunk is read
//     as code (so a reworded middle line of a JSDoc block, with its `/*` outside the hunk, is not comment-only);
//   - a Python triple-quoted string counts as a docstring only when it opens a line directly after a `def`/`class` line (or at the very top of a file);
//     any other triple-quoted string is code;
//   - strings and template literals are respected, so `'http://x'` is code; whitespace-only reformatting (no comment involved) is NOT comment-only, and in
//     Python the leading indentation is part of the code and is compared exactly.
//
// Pure: no filesystem, no git. Kill switch lives in review-task.js (AGENT_MANAGER_REVIEW_COMMENT_ONLY_CHECK=false).

const FAMILY = {
  js: 'c', mjs: 'c', cjs: 'c', ts: 'c', tsx: 'c', jsx: 'c',
  py: 'py',
  sh: 'hash', bash: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash',
};

function familyOf(file) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(file || ''));
  return m ? FAMILY[m[1].toLowerCase()] || null : null;
}

// ---------------------------------------------------------------------------------------------------- diff parsing
// -> { files: [{ path, eligible, why?, hunks: [{ top, lines: [{ t: ' '|'+'|'-', text }] }] }] }
function parseDiff(rawDiff) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const line of String(rawDiff || '').replace(/\r\n/g, '\n').split('\n')) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      file = { path: head[2], eligible: true, hunks: [] };
      if (head[1] !== head[2]) { file.eligible = false; file.why = `renamed ${head[1]} -> ${head[2]}`; }
      files.push(file); hunk = null; continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (/^(new file mode|deleted file mode)/.test(line)) { file.eligible = false; file.why = line.startsWith('new') ? 'new file' : 'deleted file'; continue; }
      if (/^(rename from|rename to|copy from|copy to|Binary files|GIT binary patch)/.test(line)) { file.eligible = false; file.why = line; continue; }
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { hunk = { top: h[1] === '1' && h[2] === '1', lines: [] }; file.hunks.push(hunk); continue; }
    if (!hunk) continue;
    const t = line[0];
    if (t === ' ' || t === '+' || t === '-') hunk.lines.push({ t, text: line.slice(1) });
    else if (line === '' ) hunk.lines.push({ t: ' ', text: '' }); // an empty context line some tools emit without its leading space
    // '\ No newline at end of file' and anything else is ignored
  }
  return { files };
}

// ---------------------------------------------------------------------------------------------------- per-language line scanning
// Each scanner is fed the lines of ONE side of a hunk in order and returns, per line, { code, comment } where `code` is the line with comments removed and
// `comment` says the line carried comment text. State (open block comment, open docstring, open string) flows from line to line.

function scanC(lines) {
  const out = [];
  let block = false;
  let template = false;
  for (const raw of lines) {
    let code = '';
    let comment = false;
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      const n = raw[i + 1];
      if (block) {
        comment = true;
        const end = raw.indexOf('*/', i);
        if (end === -1) { i = raw.length; } else { block = false; i = end + 2; code += ' '; }
        continue;
      }
      if (template) {
        code += c; i += 1;
        if (c === '\\' && i < raw.length) { code += raw[i]; i += 1; } else if (c === '`') template = false;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < raw.length && raw[j] !== c) j += raw[j] === '\\' ? 2 : 1;
        code += raw.slice(i, Math.min(j + 1, raw.length));
        i = j + 1;
        continue;
      }
      if (c === '`') { template = true; code += c; i += 1; continue; }
      if (c === '/' && n === '/') { comment = true; i = raw.length; continue; }
      if (c === '/' && n === '*') {
        comment = true;
        const end = raw.indexOf('*/', i + 2);
        if (end === -1) { block = true; i = raw.length; } else { i = end + 2; code += ' '; }
        continue;
      }
      code += c; i += 1;
    }
    out.push({ code: code.replace(/\s+/g, ' ').trim(), comment });
  }
  return out;
}

function scanHash(lines) {
  const out = [];
  for (const raw of lines) {
    let code = '';
    let comment = false;
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < raw.length && raw[j] !== c) j += raw[j] === '\\' ? 2 : 1;
        code += raw.slice(i, Math.min(j + 1, raw.length));
        i = j + 1;
        continue;
      }
      // a '#' starts a comment at the start of a line or after whitespace (not in `${#var}`, `a#b`, a URL fragment)
      if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) { comment = true; i = raw.length; continue; }
      code += c; i += 1;
    }
    out.push({ code: code.replace(/\s+/g, ' ').trim(), comment });
  }
  return out;
}

// Python. `top`: the hunk starts at line 1 of the file. A triple-quoted string that opens a line is a DOCSTRING (comment) only when the previous non-blank
// line of this side ends with ':' and starts a def/class (or the string is the first statement of the file); any other triple-quoted string is code.
function scanPy(lines, top) {
  const out = [];
  let doc = null;     // delimiter of an open docstring
  let str3 = null;    // delimiter of an open triple-quoted STRING (code)
  let prevCode = top ? '<file top>' : null;
  for (const raw of lines) {
    let code = '';
    let comment = false;
    let i = 0;
    const lead = raw.match(/^[ \t]*/)[0];
    if (doc) {
      comment = true;
      const end = raw.indexOf(doc);
      if (end === -1) { out.push({ code: '', comment: true }); continue; }
      doc = null; i = end + 3;
    } else if (str3) {
      const end = raw.indexOf(str3);
      if (end === -1) { out.push({ code: raw, comment: false }); continue; }
      code += raw.slice(0, end + 3); str3 = null; i = end + 3;
    }
    while (i < raw.length) {
      const c = raw[i];
      const tri = raw.startsWith('"""', i) ? '"""' : raw.startsWith("'''", i) ? "'''" : null;
      if (tri) {
        const startsLine = raw.slice(0, i).trim() === '';
        const afterDef = prevCode === '<file top>' || (prevCode !== null && /^(async\s+def|def|class)\b.*:\s*$/.test(prevCode));
        const end = raw.indexOf(tri, i + 3);
        if (startsLine && afterDef) {
          comment = true;
          if (end === -1) { doc = tri; i = raw.length; } else { i = end + 3; }
        } else if (end === -1) { str3 = tri; code += raw.slice(i); i = raw.length; } else { code += raw.slice(i, end + 3); i = end + 3; }
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < raw.length && raw[j] !== c) j += raw[j] === '\\' ? 2 : 1;
        code += raw.slice(i, Math.min(j + 1, raw.length));
        i = j + 1;
        continue;
      }
      if (c === '#') { comment = true; i = raw.length; continue; }
      code += c; i += 1;
    }
    const kept = (lead + code.trim()).trimEnd();      // indentation is part of the code in Python
    out.push({ code: code.trim() ? kept : '', comment });
    if (code.trim()) prevCode = code.trim();
  }
  return out;
}

const SCANNERS = { c: (lines) => scanC(lines), hash: (lines) => scanHash(lines), py: (lines, top) => scanPy(lines, top) };

// ---------------------------------------------------------------------------------------------------- analysis
// -> { commentOnly, files: [{ path, removed, added }], reason }
function analyzeCommentOnly(rawDiff) {
  const { files } = parseDiff(rawDiff);
  if (!files.length) return { commentOnly: false, files: [], reason: 'no parsable diff' };
  const summary = [];
  for (const file of files) {
    if (!file.eligible) return { commentOnly: false, files: [], reason: `${file.path}: ${file.why}` };
    const family = familyOf(file.path);
    if (!family) return { commentOnly: false, files: [], reason: `${file.path}: not a supported code file` };
    if (!file.hunks.length) return { commentOnly: false, files: [], reason: `${file.path}: no hunks` };
    const removedCode = [];
    const addedCode = [];
    let commentTouched = false;
    let removed = 0;
    let added = 0;
    for (const hunk of file.hunks) {
      const oldSide = hunk.lines.filter((l) => l.t !== '+');
      const newSide = hunk.lines.filter((l) => l.t !== '-');
      const oldScan = SCANNERS[family](oldSide.map((l) => l.text), hunk.top);
      const newScan = SCANNERS[family](newSide.map((l) => l.text), hunk.top);
      oldSide.forEach((l, k) => { if (l.t === '-') { removed += 1; if (oldScan[k].comment) commentTouched = true; if (oldScan[k].code) removedCode.push(oldScan[k].code); } });
      newSide.forEach((l, k) => { if (l.t === '+') { added += 1; if (newScan[k].comment) commentTouched = true; if (newScan[k].code) addedCode.push(newScan[k].code); } });
    }
    if (!commentTouched) return { commentOnly: false, files: [], reason: `${file.path}: no comment text is involved (a code or whitespace change)` };
    if (removedCode.length !== addedCode.length || removedCode.some((c, k) => c !== addedCode[k])) {
      return { commentOnly: false, files: [], reason: `${file.path}: the code itself changes, not only comments` };
    }
    summary.push({ path: file.path, removed, added });
  }
  return { commentOnly: true, files: summary, reason: `${summary.length} file(s) with only comment or docstring changes` };
}

module.exports = { analyzeCommentOnly, parseDiff, familyOf };
