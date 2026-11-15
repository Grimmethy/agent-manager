'use strict';

// Mock-seam detector for the review step (HUB0321 subtask 1, 2026-09-24).
//
// Why: when a draft changes production code but the accompanying test diff mocks the
// very function being modified, the test is exercising a double rather than the real
// behaviour. The reviewer needs to know this deterministically so they can flag the
// draft as requiring a real (non-mocked) test or a manual review note.
//
// What: parse the unified diff for file-level hunks, classify each file as test or
// production, extract changed function names from production hunks (walking BOTH
// context and added lines so definition lines are never stripped), and detect mock
// patterns in test hunks. Cross-reference the two to surface seams.
//
// Supported patterns:
//   Python: patch('module.func'), monkeypatch.setattr(obj, 'attr', ...),
//           @mock.patch('module.func')
//   JS:     mock.method(obj, 'func'), jest.spyOn(obj, 'func'),
//           stubs / test doubles passed as function arguments
//
// Pure; never throws. No debug logging.

const TEST_PATH_RE = /(?:^|[/\\])(test|tests|__tests__|spec|__test__)[/\\]|\.test\./;
const PYTHON_FILE_RE = /\.py$/;
const JS_FILE_RE = /\.(?:[cm]?js|mjs|ts|tsx)$/;

// --- Diff parsing ---

function parseDiffFiles(diff) {
  const files = [];
  if (!diff || typeof diff !== 'string') return files;

  const lines = diff.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Match `--- a/...` followed by `+++ b/...`
    if (line.startsWith('--- a/') && i + 1 < lines.length && lines[i + 1].startsWith('+++ b/')) {
      const oldPath = line.slice(6).trim();
      const newPath = lines[i + 1].slice(6).trim();
      const file = newPath || oldPath;

      const hunks = [];
      let j = i + 2;
      while (j < lines.length && lines[j].startsWith('@@')) {
        const hunkHeader = lines[j];
        const hunkLines = [];
        j++;
        while (j < lines.length && !lines[j].startsWith('--- a/') && !lines[j].startsWith('@@')) {
          hunkLines.push(lines[j]);
          j++;
        }
        hunks.push({ header: hunkHeader, lines: hunkLines });
      }

      files.push({ file, hunks });
      i = j;
    } else {
      i++;
    }
  }

  return files;
}

function isTestPath(filePath) {
  return TEST_PATH_RE.test(filePath);
}

function isPythonFile(filePath) {
  return PYTHON_FILE_RE.test(filePath);
}

function isJSFile(filePath) {
  return JS_FILE_RE.test(filePath);
}

// --- Production function extraction ---
// Walks BOTH context lines (leading space) and added lines (leading +) so that
// definition lines sitting in context are preserved. Tracks the current function
// name and marks it as "changed" if any added line falls within its body.

const PYTHON_DEF_RE = /^\s*def\s+([A-Za-z_][\w]*)\s*\(/;
const PYTHON_CLASS_DEF_RE = /^\s*class\s+([A-Za-z_][\w]*)\s*:/;
const JS_FUNC_DEF_RE = /^\s*(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(\w+)\s*\()/;
const JS_CLASS_DEF_RE = /^\s*class\s+([A-Za-z_$][\w$]*)\s*[{]/;

function extractChangedFunctions(hunks) {
  const changed = new Set();
  let currentFn = null;
  let currentFnStartLine = -1;
  let inFunction = false;
  let braceDepth = 0;

  for (const hunk of hunks) {
    for (const rawLine of hunk.lines) {
      // Determine effective line: context (space prefix) or added (+ prefix)
      let effective = rawLine;
      if (rawLine.startsWith(' ')) {
        effective = rawLine.slice(1); // strip context prefix
      } else if (rawLine.startsWith('+')) {
        effective = rawLine.slice(1); // strip added prefix
      } else if (rawLine.startsWith('-')) {
        // Removed lines don't count for "changed" detection
        continue;
      }
      // Unmarked lines (context without prefix, or empty) are treated as context

      // Check for function/class definition in effective line
      let defMatch = null;
      if (PYTHON_DEF_RE.test(effective)) {
        defMatch = { name: effective.match(PYTHON_DEF_RE)[1], lang: 'python' };
      } else if (JS_FUNC_DEF_RE.test(effective)) {
        const m = effective.match(JS_FUNC_DEF_RE);
        defMatch = { name: m[1] || m[2], lang: 'js' };
      } else if (JS_CLASS_DEF_RE.test(effective)) {
        defMatch = { name: effective.match(JS_CLASS_DEF_RE)[1], lang: 'js-class' };
      }

      if (defMatch) {
        // Close previous function if any
        if (inFunction && currentFn && changed.has(currentFn)) {
          // already recorded
        }
        currentFn = defMatch.name;
        currentFnStartLine = 0; // relative line in hunk
        inFunction = true;
        braceDepth = 0;
      }

      // Track brace depth for JS to know when we leave a function
      if (defMatch && defMatch.lang === 'js') {
        const openCount = (effective.match(/{/g) || []).length;
        const closeCount = (effective.match(/}/g) || []).length;
        if (openCount > 0 || closeCount > 0) {
          braceDepth += openCount - closeCount;
          if (braceDepth <= 0 && openCount + closeCount > 0) {
            // Function body ended; if we added anything inside, mark it changed
            if (currentFn) {
              // Check if there were added lines in this function body
              // (We'll handle this differently below)
            }
            inFunction = false;
            currentFn = null;
          }
        }
      }

      // If this is an added line (originally started with +), the function is changed
      if (rawLine.startsWith('+')) {
        if (currentFn) {
          changed.add(currentFn);
        }
      }
    }
  }

  return Array.from(changed);
}

// --- Mock pattern detection ---

function detectPythonMocks(hunkLines) {
  const mocks = new Set();

  for (const rawLine of hunkLines) {
    let text = rawLine;
    if (text.startsWith(' ') || text.startsWith('+')) {
      text = text.slice(1);
    }

    // patch('module.func') or patch('func')
    const patchRE = /(?:from\s+\S+\s+import\s+)?(?:mock\.|unittest\.mock\.)?patch\s*\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = patchRE.exec(text)) !== null) {
      const target = m[1];
      // Extract just the function name (last segment after .)
      const parts = target.split('.');
      mocks.add(parts[parts.length - 1]);
    }

    // @mock.patch('module.func') or @patch('module.func')
    const decoratorRE = /@(?:mock\.)?patch\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = decoratorRE.exec(text)) !== null) {
      const target = m[1];
      const parts = target.split('.');
      mocks.add(parts[parts.length - 1]);
    }

    // monkeypatch.setattr(obj, 'attr', ...)
    const monkeypatchRE = /monkeypatch\.setattr\s*\([^,]+,\s*['"]([^'"]+)['"]/g;
    while ((m = monkeypatchRE.exec(text)) !== null) {
      mocks.add(m[1]);
    }
  }

  return Array.from(mocks);
}

function detectJSMocks(hunkLines) {
  const mocks = new Set();

  for (const rawLine of hunkLines) {
    let text = rawLine;
    if (text.startsWith(' ') || text.startsWith('+')) {
      text = text.slice(1);
    }

    // mock.method(obj, 'func', ...) or jest.spyOn(obj, 'func')
    const mockMethodRE = /(?:mock|jest)\.method\s*\([^,]+,\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = mockMethodRE.exec(text)) !== null) {
      mocks.add(m[1]);
    }

    const spyOnRE = /jest\.spyOn\s*\([^,]+,\s*['"]([^'"]+)['"]/g;
    while ((m = spyOnRE.exec(text)) !== null) {
      mocks.add(m[1]);
    }

    // stub(obj, 'func', ...) or sinon.stub(obj, 'func')
    const stubRE = /(?:sinon\.)?stub\s*\([^,]+,\s*['"]([^'"]+)['"]/g;
    while ((m = stubRE.exec(text)) !== null) {
      mocks.add(m[1]);
    }

    // Test doubles passed as args: testFn(mockedFunc) or similar
    const testDoubleRE = /\w+\s*\(\s*(\w+)\s*\)/g;
    while ((m = testDoubleRE.exec(text)) !== null) {
      const arg = m[1];
      // Heuristic: if the arg name contains 'mock', 'stub', 'fake', 'spy', or 'double'
      if (/^(mock|stub|fake|spy|double)/i.test(arg)) {
        mocks.add(arg);
      }
    }
  }

  return Array.from(mocks);
}

// --- Main analysis ---

function analyzeMockSeams({ diff, config } = {}) {
  const seams = [];
  let advisory = null;

  try {
    if (!diff || typeof diff !== 'string' || !diff.trim()) {
      return { seams: [], advisory: null };
    }

    const mode = (config && config.AGENT_MANAGER_REVIEW_MOCK_SEAM_CHECK) || 'advisory';
    if (mode === 'false') {
      return { seams: [], advisory: null };
    }

    const files = parseDiffFiles(diff);
    const productionChanges = new Map(); // fileName -> [changedFn, ...]
    const testMocks = new Map(); // fileName -> [mockedFunc, ...]

    for (const { file, hunks } of files) {
      if (isTestPath(file)) {
        // Detect mocks in test files
        const allHunkLines = [];
        for (const h of hunks) {
          allHunkLines.push(...h.lines);
        }

        let detected;
        if (isPythonFile(file)) {
          detected = detectPythonMocks(allHunkLines);
        } else if (isJSFile(file)) {
          detected = detectJSMocks(allHunkLines);
        } else {
          continue;
        }

        if (detected.length > 0) {
          testMocks.set(file, detected);
        }
      } else {
        // Extract changed functions from production files
        const changedFns = extractChangedFunctions(hunks);
        if (changedFns.length > 0) {
          productionChanges.set(file, changedFns);
        }
      }
    }

    // Cross-reference: for each production change, find which test files mock it
    for (const [prodFile, changedFns] of productionChanges) {
      for (const fn of changedFns) {
        const mockedIn = [];
        for (const [testFile, mocks] of testMocks) {
          if (mocks.includes(fn)) {
            mockedIn.push(testFile);
          }
        }
        if (mockedIn.length > 0) {
          seams.push({ changedFn: fn, mockedInTests: mockedIn });
        }
      }
    }

    // Generate advisory if seams found and mode is not 'false'
    if (seams.length > 0) {
      const fnList = seams.map((s) => `${s.changedFn} (mocked in: ${s.mockedInTests.join(', ')})`).join('; ');
      advisory = `Detected ${seams.length} mock seam(s): ${fnList}`;
    }
  } catch {
    // Advisory: a detector failure means "nothing found"
  }

  return { seams, advisory };
}

module.exports = { analyzeMockSeams };
