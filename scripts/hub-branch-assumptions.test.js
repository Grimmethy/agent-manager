'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { collectRows, formatRows, buildBlock, spliceBlock, run, START, END } = require('./hub-branch-assumptions');

test('collectRows returns sorted rows with all four terms', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-branch-test-'));
  try {
    // Create fixture files with known terms at known lines
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.js'), 'line1\nagent/decompose-X\nline3\n');

    const pythonDir = path.join(tmpDir, 'python');
    fs.mkdirSync(pythonDir, { recursive: true });
    fs.writeFileSync(path.join(pythonDir, 'b.py'), 'line1\nhubSiblingConflicts\nline3\n');

    const scriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'c.sh'), 'line1\nreadyToMerge\nline3\nhub_for_branch\n');

    const rows = collectRows(tmpDir);

    // All four terms should appear
    const terms = rows.map(r => r.term);
    assert.ok(terms.includes('agent/decompose-'), 'should include agent/decompose-');
    assert.ok(terms.includes('hubSiblingConflicts'), 'should include hubSiblingConflicts');
    assert.ok(terms.includes('readyToMerge'), 'should include readyToMerge');
    assert.ok(terms.includes('hub_for_branch'), 'should include hub_for_branch');

    // Verify row format
    for (const row of rows) {
      assert.ok(typeof row.path === 'string', 'row should have path');
      assert.ok(typeof row.line === 'number', 'row should have line');
      assert.ok(typeof row.term === 'string', 'row should have term');
      assert.ok(typeof row.text === 'string', 'row should have text');
    }

    // Rows should be sorted by path then line
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      assert.ok(
        prev.path < curr.path || (prev.path === curr.path && prev.line <= curr.line),
        `rows should be sorted: ${prev.path}:${prev.line} before ${curr.path}:${curr.line}`
      );
    }

    // Verify specific rows exist
    const srcRow = rows.find(r => r.path === 'src/a.js' && r.term === 'agent/decompose-');
    assert.ok(srcRow, 'should find src/a.js:2 agent/decompose-');
    assert.strictEqual(srcRow.line, 2);

    const pythonRow = rows.find(r => r.path === 'python/b.py' && r.term === 'hubSiblingConflicts');
    assert.ok(pythonRow, 'should find python/b.py:2 hubSiblingConflicts');
    assert.strictEqual(pythonRow.line, 2);

    const scriptRow1 = rows.find(r => r.path === 'scripts/c.sh' && r.term === 'readyToMerge');
    assert.ok(scriptRow1, 'should find scripts/c.sh:2 readyToMerge');
    assert.strictEqual(scriptRow1.line, 2);

    const scriptRow2 = rows.find(r => r.path === 'scripts/c.sh' && r.term === 'hub_for_branch');
    assert.ok(scriptRow2, 'should find scripts/c.sh:4 hub_for_branch');
    assert.strictEqual(scriptRow2.line, 4);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('run writes START/END markers with correct row format', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-branch-test-'));
  try {
    // Create fixture files
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.js'), 'agent/decompose-X\n');

    const pythonDir = path.join(tmpDir, 'python');
    fs.mkdirSync(pythonDir, { recursive: true });
    fs.writeFileSync(path.join(pythonDir, 'b.py'), 'hubSiblingConflicts\n');

    const scriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'c.sh'), 'readyToMerge\nhub_for_branch\n');

    // First run
    const result = run(tmpDir);
    const docPath = path.join(tmpDir, 'Docs', 'PARALLEL_HUB_BRANCHES.md');
    const output = fs.readFileSync(docPath, 'utf8');

    // Verify markers exist
    assert.ok(output.includes(START), 'output should contain START marker');
    assert.ok(output.includes(END), 'output should contain END marker');

    // Verify all four terms appear in the output
    assert.ok(output.includes('agent/decompose-'), 'output should include agent/decompose-');
    assert.ok(output.includes('hubSiblingConflicts'), 'output should include hubSiblingConflicts');
    assert.ok(output.includes('readyToMerge'), 'output should include readyToMerge');
    assert.ok(output.includes('hub_for_branch'), 'output should include hub_for_branch');

    // Verify row format (path:line  term  snippet)
    const lines = output.split('\n');
    const codeBlockStart = lines.indexOf('```text');
    assert.ok(codeBlockStart !== -1, 'output should contain ```text block');

    let foundValidRow = false;
    for (let i = codeBlockStart + 1; i < lines.length; i++) {
      if (lines[i] === '```') break;
      const line = lines[i];
      // Match pattern: path:line  term  snippet (two spaces between fields)
      if (/^[^:]+:\d+  \S+  .+$/.test(line)) {
        foundValidRow = true;
      }
    }
    assert.ok(foundValidRow, 'should find at least one valid row in format path:line  term  snippet');

    // Verify specific rows
    assert.ok(output.includes('src/a.js:1  agent/decompose-  agent/decompose-X'), 'should include src/a.js row');
    assert.ok(output.includes('python/b.py:1  hubSiblingConflicts  hubSiblingConflicts'), 'should include python/b.py row');
    assert.ok(output.includes('scripts/c.sh:1  readyToMerge  readyToMerge'), 'should include scripts/c.sh:1 row');
    assert.ok(output.includes('scripts/c.sh:2  hub_for_branch  hub_for_branch'), 'should include scripts/c.sh:2 row');

    // Verify result object
    assert.strictEqual(result.changed, true, 'first run should change the file');
    assert.ok(result.rows > 0, 'result should report rows count');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('second run produces identical output (idempotency)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-branch-test-'));
  try {
    // Create fixture files
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.js'), 'agent/decompose-X\nhubSiblingConflicts\n');

    const pythonDir = path.join(tmpDir, 'python');
    fs.mkdirSync(pythonDir, { recursive: true });
    fs.writeFileSync(path.join(pythonDir, 'b.py'), 'readyToMerge\nhub_for_branch\n');

    const scriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'c.sh'), 'agent/decompose-Y\n');

    // First run
    const result1 = run(tmpDir);
    const docPath = path.join(tmpDir, 'Docs', 'PARALLEL_HUB_BRANCHES.md');
    const output1 = fs.readFileSync(docPath, 'utf8');

    // Second run (idempotency check)
    const result2 = run(tmpDir);
    const output2 = fs.readFileSync(docPath, 'utf8');

    // Outputs should be identical
    assert.strictEqual(output1, output2, 'second run should produce identical output');

    // Second run should report no change
    assert.strictEqual(result2.changed, false, 'second run should report no change');

    // Verify markers still present
    assert.ok(output2.includes(START), 'output should still contain START marker');
    assert.ok(output2.includes(END), 'output should still contain END marker');

    // Verify all terms still present
    assert.ok(output2.includes('agent/decompose-'), 'output should still include agent/decompose-');
    assert.ok(output2.includes('hubSiblingConflicts'), 'output should still include hubSiblingConflicts');
    assert.ok(output2.includes('readyToMerge'), 'output should still include readyToMerge');
    assert.ok(output2.includes('hub_for_branch'), 'output should still include hub_for_branch');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildBlock formats rows correctly', () => {
  const rows = [
    { path: 'src/a.js', line: 1, term: 'agent/decompose-', text: 'agent/decompose-X' },
    { path: 'python/b.py', line: 2, term: 'hubSiblingConflicts', text: 'hubSiblingConflicts' },
  ];

  const block = buildBlock(rows);
  assert.ok(block.includes(START), 'block should contain START marker');
  assert.ok(block.includes(END), 'block should contain END marker');
  assert.ok(block.includes('```text'), 'block should contain code block');
  assert.ok(block.includes('src/a.js:1  agent/decompose-  agent/decompose-X'), 'block should include first row');
  assert.ok(block.includes('python/b.py:2  hubSiblingConflicts  hubSiblingConflicts'), 'block should include second row');
  assert.ok(block.includes('```'), 'block should close code block');
});

test('buildBlock with empty rows returns (none)', () => {
  const block = buildBlock([]);
  assert.ok(block.includes(START), 'block should contain START marker');
  assert.ok(block.includes(END), 'block should contain END marker');
  assert.ok(block.includes('(none)'), 'block should contain (none) for empty rows');
});

test('spliceBlock adds markers when absent', () => {
  const existing = '# Title\n\nSome content\n';
  const block = '<!-- HUB-BRANCH-ASSUMPTIONS:START -->\n```text\nsrc/a.js:1  agent/decompose-  test\n```\n<!-- HUB-BRANCH-ASSUMPTIONS:END -->';

  const result = spliceBlock(existing, block);
  assert.ok(result.includes(START), 'result should contain START marker');
  assert.ok(result.includes(END), 'result should contain END marker');
  assert.ok(result.includes('# Title'), 'result should preserve existing content');
  assert.ok(result.includes('Some content'), 'result should preserve existing content');
});

test('spliceBlock replaces existing markers', () => {
  const existing = '# Title\n\n<!-- HUB-BRANCH-ASSUMPTIONS:START -->\nold content\n<!-- HUB-BRANCH-ASSUMPTIONS:END -->\n\nFooter\n';
  const block = '<!-- HUB-BRANCH-ASSUMPTIONS:START -->\nnew content\n<!-- HUB-BRANCH-ASSUMPTIONS:END -->';

  const result = spliceBlock(existing, block);
  assert.ok(result.includes('new content'), 'result should contain new block content');
  assert.ok(!result.includes('old content'), 'result should not contain old block content');
  assert.ok(result.includes('# Title'), 'result should preserve header');
  assert.ok(result.includes('Footer'), 'result should preserve footer');
});

test('spliceBlock throws on malformed markers', () => {
  const malformed1 = '<!-- HUB-BRANCH-ASSUMPTIONS:START --><!-- HUB-BRANCH-ASSUMPTIONS:END --><!-- HUB-BRANCH-ASSUMPTIONS:START -->';
  assert.throws(() => spliceBlock(malformed1, 'block'), /malformed/);

  const malformed2 = '<!-- HUB-BRANCH-ASSUMPTIONS:END --><!-- HUB-BRANCH-ASSUMPTIONS:START -->';
  assert.throws(() => spliceBlock(malformed2, 'block'), /malformed/);
});
