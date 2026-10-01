'use strict';

// Inert-addition check for the review step (brain dump #1665, 2026-10-01).
//
// Why: of 10 needs-work branches examined on 2026-09-30, four were "half a feature" -- the draft added something nothing uses: a field no code reads
// (knownUrlExclusions), a blockedStage no sweep re-admits ('critique'), static js files index.html never loads (9 functions undefined in the page), a reworded
// message at a reconstruct path while the writer was left unchanged. Passing tests do not catch that: the new code is simply never reached.
//
// What: given a unified diff, report the NEW definitions (functions, classes, whole new source files) that nothing else references. A new definition can
// only be referenced from two places: other lines the same diff adds (in non-test files), or code already on the base ref (a call site waiting for the
// function). So this needs no worktree: the diff's added lines plus one `git grep` on the base ref per candidate. Advisory by design -- a helper that a
// sibling hub task wires later is legitimate, so the caller decides what to do with the list.
//
// Not counted as a reference: the definition itself, comments, module.exports / exports. / __all__ lines (exporting is not using), and test files (a
// function used only by its own test is still inert). A multi-line `module.exports = { ... }` block is skipped as a whole.
//
// Never throws: any failure to look something up means "unknown", which is never reported as inert.

const path = require('path');
const { execFileSync } = require('child_process');

const MAX_CANDIDATES = 40;
const BROWSER_LOAD_RE = /(?:\bsrc|\bhref)\s*=|\bimport\b/;
const TEMPLATE_RE = /\.(?:html|jinja2?|j2)$/;
const NAME_STOPLIST = new Set(['main', 'test', 'run', 'get', 'set', 'init', 'setUp', 'tearDown', 'constructor', 'render', 'handler', 'wrapper', 'helper', 'callback']);
const TEST_PATH_RE = /(^|\/)test_[^/]*\.py$|_test\.py$|\.(?:test|spec)\.[cm]?js$|(^|\/)(?:tests?|__tests__)\//;
const SOURCE_RE = /\.(?:[cm]?js|py)$/;

function isTestPath(file) { return TEST_PATH_RE.test(String(file || '')); }

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Files the diff touches: { file, isNew, isDeleted, added: [{ line, text }] } (line = new-file line number).
function parseDiffFiles(diff) {
  const files = [];
  for (const chunk of String(diff || '').split(/^(?=diff --git )/m)) {
    const head = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!head) continue;
    const first = chunk.search(/^@@ /m);
    const header = first < 0 ? chunk : chunk.slice(0, first);
    if (/^(?:Binary files|GIT binary patch)/m.test(chunk)) continue;
    const entry = { file: head[2], isNew: /^new file mode/m.test(header), isDeleted: /^deleted file mode/m.test(header), isRename: /^rename from /m.test(header), added: [] };
    if (first >= 0) {
      for (const hunk of chunk.slice(first).split(/^(?=@@ )/m)) {
        const hh = hunk.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (!hh) continue;
        let n = Number(hh[1]);
        for (const line of hunk.split('\n').slice(1)) {
          if (line.startsWith('\\') || line.startsWith('-')) continue;
          if (line.startsWith('+')) { entry.added.push({ line: n, text: line.slice(1) }); n += 1; }
          else if (line.startsWith(' ')) n += 1;
        }
      }
    }
    files.push(entry);
  }
  return files;
}

const JS_DEF_RES = [
  /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/,
  /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^class\s+([A-Za-z_$][\w$]*)\b/,
];
const PY_DEF_RES = [/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, /^class\s+([A-Za-z_]\w*)\b/];

// New top-level definitions the diff adds to a file: column 0 only, so methods and nested helpers are not candidates.
function topLevelDefinitions(entry) {
  const res = entry.file.endsWith('.py') ? PY_DEF_RES : JS_DEF_RES;
  const out = [];
  for (const { line, text } of entry.added) {
    if (!text) continue;                      // the patterns are anchored at column 0, so methods and nested helpers never match
    for (const re of res) {
      const m = text.match(re);
      if (m) {
        const name = m[1];
        if (name.length >= 4 && !NAME_STOPLIST.has(name)) out.push({ kind: /^class\b/.test(text) ? 'class' : 'function', name, file: entry.file, line });
        break;
      }
    }
  }
  return out;
}

function isEntrypointFile(entry) {
  const body = entry.added.map((a) => a.text).join('\n');
  return /^#!/.test(body) || /require\.main\s*===\s*module/.test(body) || /if\s+__name__\s*==\s*['"]__main__['"]/.test(body);
}

// Added lines that could reference something: not comments, not export lists, and (multi-line module.exports blocks aside) in non-test files.
function referenceLines(files) {
  const out = [];
  for (const entry of files) {
    if (entry.isDeleted || isTestPath(entry.file)) continue;
    let inExports = false;
    for (const { line, text } of entry.added) {
      const t = text.trim();
      if (inExports) { if (/^\}/.test(t)) inExports = false; continue; }
      if (!t || /^(?:\/\/|\/\*|\*|#)/.test(t)) continue;
      if (/^(?:module\.exports\b|exports\.|__all__\b|export\s*\{)/.test(t)) {
        if (/[{[(]\s*$/.test(t)) inExports = true;
        continue;
      }
      out.push({ file: entry.file, line, text: t });
    }
  }
  return out;
}

function defaultGrep(repoRoot, baseRef, pattern, { fixed = false } = {}) {
  try {
    const args = ['-C', repoRoot, 'grep', '-l', ...(fixed ? ['-F'] : ['-w', '-E']), '-e', pattern, baseRef, '--', '.',
      ':(exclude)*.test.js', ':(exclude)*.test.mjs', ':(exclude)*.spec.js', ':(exclude)*test_*.py', ':(exclude)*_test.py', ':(exclude)*/tests/*', ':(exclude)*/__tests__/*', ':(exclude)*.md'];
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).split('\n').filter(Boolean);
  } catch (e) {
    if (e && e.status === 1) return [];          // git grep: no match
    throw e;
  }
}

// Files on the base ref (non-test, non-doc) that mention `pattern`, as repo-relative paths. `excludeFile` is the definition's own file.
function baseReferenceFiles(grep, repoRoot, baseRef, pattern, opts) {
  return grep(repoRoot, baseRef, pattern, opts).map((l) => l.replace(new RegExp(`^${escapeRe(baseRef)}:`), ''));
}

/**
 * @returns {{ considered: number, inert: Array<{kind:'function'|'class'|'file', name:string, file:string, line:number}>, unknown: number }}
 */
function findInertAdditions({ rawDiff, repoRoot, baseRef, grep = defaultGrep } = {}) {
  const result = { considered: 0, inert: [], unknown: 0 };
  try {
    const files = parseDiffFiles(rawDiff).filter((f) => !f.isDeleted && !f.isRename);
    const refs = referenceLines(files);
    const candidates = [];
    for (const entry of files) {
      if (isTestPath(entry.file)) continue;
      if (entry.isNew && SOURCE_RE.test(entry.file)) {
        if (isEntrypointFile(entry)) continue;
        const base = path.basename(entry.file);
        const modName = base.replace(/\.[^.]+$/, '');
        // Files under static/ are served to the browser, where require() does not exist: only a <script src>/<link href> or an ES import loads them.
        candidates.push({ kind: 'file', name: entry.file, file: entry.file, line: 1, base, modName, isPy: base.endsWith('.py'), browser: /(^|\/)static\//.test(entry.file) });
      } else if (!entry.isNew && SOURCE_RE.test(entry.file)) {
        candidates.push(...topLevelDefinitions(entry));
      }
    }
    for (const c of candidates.slice(0, MAX_CANDIDATES)) {
      result.considered += 1;
      let referenced = false;
      if (c.kind === 'file') {
        // A new source file is used when something else names it: require('./x.js'), <script src=".../x.js">, `from pkg import x`, `python -m x`.
        const re = c.isPy ? new RegExp(`(?<![\\w])${escapeRe(c.modName)}(?![\\w])`) : new RegExp(`(?<![\\w.-])${escapeRe(c.base)}(?![\\w-])|(?<![\\w.-])${escapeRe(c.modName)}(?:['"/)])`);
        referenced = refs.some((r) => r.file !== c.file && re.test(r.text) && (!c.browser || BROWSER_LOAD_RE.test(r.text)));
        if (!referenced) {
          try {
            referenced = baseReferenceFiles(grep, repoRoot, baseRef, c.isPy ? c.modName : c.base, { fixed: !c.isPy }).some((f) => f !== c.file && (!c.browser || TEMPLATE_RE.test(f)));
          } catch { result.unknown += 1; continue; }
        }
      } else {
        const re = new RegExp(`(?<![\\w$])${escapeRe(c.name)}(?![\\w$])`);
        referenced = refs.some((r) => !(r.file === c.file && r.line === c.line) && re.test(r.text));
        if (!referenced) {
          try {
            referenced = baseReferenceFiles(grep, repoRoot, baseRef, c.name).length > 0;
          } catch { result.unknown += 1; continue; }
        }
      }
      if (!referenced) result.inert.push({ kind: c.kind, name: c.kind === 'file' ? path.basename(c.file) : c.name, file: c.file, line: c.line });
    }
  } catch {
    result.unknown += 1;
  }
  return result;
}

module.exports = { findInertAdditions, parseDiffFiles, topLevelDefinitions, referenceLines, isTestPath, isEntrypointFile, MAX_CANDIDATES };
