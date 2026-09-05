'use strict';

// Regression coverage for the exact failure classes that defeated three prior attempts at
// a hand-rolled character-by-character JS lexer (see extract-core-ui.js's own header): a
// comment opening inside a template-literal ${} expression, and an apostrophe inside a
// template literal's HTML-prose text. The oracle-based approach (V8 itself as ground
// truth via vm.Script) should never desync on either, by construction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'extract-core-ui.js');

function runOn(html, functions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-core-ui-test-'));
  const htmlPath = path.join(dir, 'index.html');
  fs.writeFileSync(htmlPath, html);
  const args = [SCRIPT, '--html', htmlPath, '--functions', functions.join(',')];
  try {
    const out = execFileSync('node', args, { encoding: 'utf8' });
    return { code: 0, out, dir, htmlPath };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || ''), dir, htmlPath };
  }
}

test('resolves a function whose template literal contains a comment inside a ${} expression -- the exact desync class that defeated the hand-rolled scanner', () => {
  const html = `<script>
function renderThing(x) {
  const label = \`value: \${/* a comment right here */ x}\`;
  return label;
}
function afterIt() { return 1; }
</script>`;
  const { code, out } = runOn(html, ['renderThing', 'afterIt']);
  assert.equal(code, 0, out);
  assert.match(out, /OK\s+renderThing/);
  assert.match(out, /OK\s+afterIt/);
});

test('resolves a function whose template literal contains an HTML-prose apostrophe', () => {
  const html = `<script>
function renderNote() {
  return \`don't worry, this isn't a string close\`;
}
function afterIt() { return 1; }
</script>`;
  const { code, out } = runOn(html, ['renderNote', 'afterIt']);
  assert.equal(code, 0, out);
  assert.match(out, /OK\s+renderNote/);
  assert.match(out, /OK\s+afterIt/);
});

test('resolves an async function containing a real await expression', () => {
  const html = `<script>
async function loadIt(url) {
  const r = await fetch(url);
  return r.json();
}
</script>`;
  const { code, out } = runOn(html, ['loadIt']);
  assert.equal(code, 0, out);
  assert.match(out, /OK\s+loadIt/);
});

test('reports (does not silently accept) a function whose declaration is not found', () => {
  const html = '<script>\nfunction realOne() { return 1; }\n</script>';
  const { code, out } = runOn(html, ['realOne', 'doesNotExist']);
  assert.equal(code, 1);
  assert.match(out, /OK\s+realOne/);
  assert.match(out, /FAIL doesNotExist: declaration not found/);
});

test('does not match a call site as a declaration', () => {
  const html = `<script>
wireThing(x, y);
function wireThing(a, b) { return a + b; }
</script>`;
  const { code, out } = runOn(html, ['wireThing']);
  assert.equal(code, 0, out);
  assert.match(out, /OK\s+wireThing/);
});

test('--write extracts the requested functions verbatim into core-ui.js and removes them from the HTML, preserving an untouched sibling', () => {
  const html = `<script>
const KEEP_ME = 1;
function moveMe(x) {
  return \`moved: \${x}\`;
}
function stayHere() {
  return KEEP_ME;
}
</script>`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-core-ui-write-test-'));
  const htmlPath = path.join(dir, 'index.html');
  fs.writeFileSync(htmlPath, html);
  const cwdBefore = process.cwd();
  process.chdir(dir);
  try {
    execFileSync('node', [SCRIPT, '--html', htmlPath, '--functions', 'moveMe', '--write'], { encoding: 'utf8' });
    const coreUi = fs.readFileSync(path.join(dir, 'python/dashboard/static/js/core-ui.js'), 'utf8');
    assert.match(coreUi, /function moveMe\(x\)/);
    assert.match(coreUi, /moved: \$\{x\}/);

    const newHtml = fs.readFileSync(htmlPath, 'utf8');
    assert.doesNotMatch(newHtml, /function moveMe/);
    assert.match(newHtml, /function stayHere/, 'untouched sibling function must survive');
    assert.match(newHtml, /const KEEP_ME = 1;/, 'untouched sibling declaration must survive');
    assert.match(newHtml, /core-ui\.js/, 'a src= tag for the new file must be inserted');
  } finally {
    process.chdir(cwdBefore);
  }
});
