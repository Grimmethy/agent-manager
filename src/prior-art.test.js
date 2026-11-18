'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isPriorArtEnabled,
  extractTerms,
  buildPriorArtBlock,
  buildPriorArtForDiff,
} = require('./prior-art');

const SRC = [
  "'use strict';",
  '/* Frobnicates the widget.',
  ' * Keep the cache warm.',
  ' */',
  'function frobnicateWidget() {}',
  '',
].join('\n');

const TEST = [
  '// pins frobnicateWidget behaviour',
  "test('pins', () => frobnicateWidget());",
  '',
].join('\n');

function mkRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-art-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function withEnv(value, fn) {
  const prev = process.env.AGENT_MANAGER_ADHOC_PRIOR_ART;
  if (value === undefined) delete process.env.AGENT_MANAGER_ADHOC_PRIOR_ART;
  else process.env.AGENT_MANAGER_ADHOC_PRIOR_ART = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_ADHOC_PRIOR_ART;
    else process.env.AGENT_MANAGER_ADHOC_PRIOR_ART = prev;
  }
}

test('handled and pinned hits are both reported, test file tagged [pinning]', async () => {
  const root = mkRoot({ 'src/widget.js': SRC, 'src/widget.test.js': TEST });
  try {
    const block = await withEnv(undefined, () =>
      buildPriorArtBlock('Rename frobnicateWidget', [root], { max: 5 }));
    assert.match(block, /^PRIOR ART:/);
    assert.match(block, /src\/widget\.js:5 \[handled\]/);
    assert.match(block, /src\/widget\.test\.js:2 \[pinning\]/);
  } finally {
    cleanup(root);
  }
});

test('non-test hits are ordered before test hits', async () => {
  const root = mkRoot({ 'src/widget.js': SRC, 'src/widget.test.js': TEST });
  try {
    const block = await withEnv(undefined, () =>
      buildPriorArtBlock('frobnicateWidget', [root]));
    const handled = block.indexOf('src/widget.js:5');
    const pinning = block.indexOf('src/widget.test.js:2');
    assert.ok(handled >= 0 && pinning >= 0, block);
    assert.ok(handled < pinning, block);
  } finally {
    cleanup(root);
  }
});

test('cap limits the number of rendered hits and keeps handled hits first', async () => {
  const root = mkRoot({ 'src/widget.js': SRC, 'src/widget.test.js': TEST });
  try {
    const block = await withEnv(undefined, () =>
      buildPriorArtBlock('frobnicateWidget', [root], { max: 1 }));
    const entries = block.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(entries.length, 1, block);
    assert.match(entries[0], /src\/widget\.js:5 \[handled\]/);
    assert.doesNotMatch(block, /widget\.test\.js/);
  } finally {
    cleanup(root);
  }
});

test('no hits yields exactly PRIOR ART: none found', async () => {
  const root = mkRoot({ 'src/a.js': 'const x = 1;\n' });
  try {
    const block = await withEnv(undefined, () =>
      buildPriorArtBlock('zzqqxxyy', [root]));
    assert.equal(block, 'PRIOR ART: none found');
  } finally {
    cleanup(root);
  }
});

test('comment capture keeps the nearest 6 lines of the comment block', async () => {
  const comment = Array.from({ length: 10 }, (_, i) => `// comment line ${i + 1}`);
  const src = [...comment, 'function frobnicateWidget() {}', ''].join('\n');
  const root = mkRoot({ 'lib/long.js': src });
  try {
    const block = await withEnv(undefined, () =>
      buildPriorArtBlock('frobnicateWidget', [root]));
    assert.match(block, /lib\/long\.js:11 \[handled\]/);
    assert.ok(block.includes('comment line 10'), block);
    assert.ok(block.includes('comment line 5'), block);
    assert.ok(!block.includes('comment line 4'), block);
  } finally {
    cleanup(root);
  }
});

test('comment capture includes a multi-line block above the hit', async () => {
  const root = mkRoot({ 'src/widget.js': SRC });
  try {
    const block = await withEnv(undefined, () =>
      buildPriorArtBlock('frobnicateWidget', [root]));
    assert.ok(block.includes('Frobnicates the widget.'), block);
    assert.ok(block.includes('Keep the cache warm.'), block);
  } finally {
    cleanup(root);
  }
});

test('git path: finds an untracked fixture inside a git repo', async () => {
  const root = mkRoot({ 'src/widget.js': SRC });
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const block = await withEnv(undefined, () =>
      buildPriorArtBlock('frobnicateWidget', [root]));
    assert.match(block, /src\/widget\.js:5 \[handled\]/);
  } finally {
    cleanup(root);
  }
});

test('extractTerms: quoted phrases, identifiers, dedupe, stop-words, cap of 6', () => {
  const terms = extractTerms('Rename "the cache" and frobnicateWidget in widget_mod, frobnicateWidget');
  assert.ok(terms.includes('the cache'), JSON.stringify(terms));
  assert.ok(terms.includes('frobnicateWidget'), JSON.stringify(terms));
  assert.ok(terms.includes('widget_mod'), JSON.stringify(terms));
  assert.ok(!terms.includes('and'), JSON.stringify(terms));
  assert.equal(terms.filter((t) => t === 'frobnicateWidget').length, 1);

  const many = extractTerms('alpha1 bravo2 charlie3 delta4 echo5 foxtrot6 golf7 hotel8');
  assert.equal(many.length, 6);
});

test('buildPriorArtForDiff searches only added lines', async () => {
  const root = mkRoot({ 'src/widget.js': SRC });
  try {
    const diff = [
      '--- a/src/widget.js',
      '+++ b/src/widget.js',
      '@@ -1 +1 @@',
      '-zzqqxxyy();',
      '+frobnicateWidget();',
      '',
    ].join('\n');
    const block = await withEnv(undefined, () => buildPriorArtForDiff(diff, [root]));
    assert.match(block, /src\/widget\.js:5 \[handled\]/);

    const removedOnly = [
      '--- a/src/widget.js',
      '+++ b/src/widget.js',
      '-frobnicateWidget();',
      '',
    ].join('\n');
    const none = await withEnv(undefined, () => buildPriorArtForDiff(removedOnly, [root]));
    assert.equal(none, 'PRIOR ART: none found');
  } finally {
    cleanup(root);
  }
});

test('kill-switch: AGENT_MANAGER_ADHOC_PRIOR_ART=false disables both builders', async () => {
  const root = mkRoot({ 'src/widget.js': SRC });
  try {
    await withEnv('false', async () => {
      assert.equal(isPriorArtEnabled(), false);
      assert.equal(await buildPriorArtBlock('frobnicateWidget', [root]), '');
      assert.equal(await buildPriorArtForDiff('+frobnicateWidget();\n', [root]), '');
    });
    await withEnv('off', () => {
      assert.equal(isPriorArtEnabled(), true);
    });
    await withEnv(undefined, () => {
      assert.equal(isPriorArtEnabled(), true);
    });
  } finally {
    cleanup(root);
  }
});
