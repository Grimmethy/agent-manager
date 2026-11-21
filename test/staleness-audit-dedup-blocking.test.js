'use strict';

// Blocking must be exact: the prefix-filter candidate path has to flag the same pairs as a
// brute-force scan. Guards are disabled on both sides here so the comparison isolates the
// Jaccard decision; the guards are checked separately below.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  findDuplicateTask, buildDupIndex, normalizeTaskTokens, namesDisjointFiles, relatedAsHubAndChild,
} = require('../src/staleness-audit-dedup.js');
const { jaccardSimilarity } = require('../src/text-similarity.js');

const NO_GUARDS = { relationCheck: false, siblingCheck: false, fileDisjointCheck: false };
const ENV = 'AGENT_MANAGER_STALENESS_DUP_SIMILARITY';

const VOCAB = ('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike '
  + 'november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu '
  + 'ledger scanner dispatch router queue worker claim stale marker retry').split(' ');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCorpus(seed, n) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const len = 4 + Math.floor(r() * 9);
    const words = [];
    for (let k = 0; k < len; k += 1) words.push(VOCAB[Math.floor(r() * VOCAB.length)]);
    out.push({
      id: `task-${String(i).padStart(4, '0')}`,
      title: words.slice(0, 4).join(' '),
      promptContext: { rawText: words.slice(4).join(' ') },
    });
  }
  // Plant exact clones so every threshold (including 0.9) has real duplicate pairs to match.
  for (let i = 0; i < n; i += 10) {
    out.push({ ...out[i], id: `task-dup-${String(i).padStart(4, '0')}` });
  }
  return out;
}

// Mirrors findDuplicateTask's decision with no guards: first-in-order best, strict '>'.
function bruteForce(task, corpus, threshold) {
  const mine = normalizeTaskTokens(task);
  if (mine.size < 4) return null;
  let best = null;
  for (const other of corpus) {
    if (other.id === task.id) continue;
    const sim = jaccardSimilarity(mine, normalizeTaskTokens(other));
    if (sim >= threshold && (!best || sim > best.sim)) {
      best = { id: other.id, sim: Number(sim.toFixed(2)) };
    }
  }
  return best;
}

function withThreshold(value, fn) {
  const prev = process.env[ENV];
  process.env[ENV] = String(value);
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev;
  }
}

for (const t of [0.5, 0.6, 0.9]) {
  test(`blocked and brute-force results match at threshold ${t}`, () => {
    withThreshold(t, () => {
      const corpus = makeCorpus(1234 + Math.round(t * 100), 120);
      const index = buildDupIndex(corpus, t);
      let flagged = 0;
      for (const task of corpus) {
        const expected = bruteForce(task, corpus, t);
        const lazy = findDuplicateTask(task, corpus, NO_GUARDS);
        const prebuilt = findDuplicateTask(task, corpus, { ...NO_GUARDS, index });
        const norm = (r) => (r ? { id: r.id, sim: r.sim } : null);
        assert.deepStrictEqual(norm(lazy), expected, `lazy index mismatch for ${task.id}`);
        assert.deepStrictEqual(norm(prebuilt), expected, `prebuilt index mismatch for ${task.id}`);
        if (expected) flagged += 1;
      }
      assert.ok(flagged > 0, `fixture should contain flagged pairs at threshold ${t}`);
    });
  });
}

test('hub and its decomposed child are not flagged by the default guards', () => {
  const text = 'split ledger scanner queue worker claim retry stale marker dispatch';
  const hub = { id: 'hub-ledger-scanner', title: 'Decompose src/ledger-scan.js into modules', promptContext: { rawText: text } };
  const child = {
    id: 'hub-ledger-scanner-1',
    title: 'Decompose src/ledger-scan.js into modules',
    promptContext: { rawText: text, decomposedFrom: 'hub-ledger-scanner' },
  };
  assert.strictEqual(relatedAsHubAndChild(child, hub), true);
  assert.strictEqual(findDuplicateTask(child, [hub]), null);
  assert.ok(findDuplicateTask(child, [hub], NO_GUARDS), 'sanity: pair would be flagged without guards');
});

test('tasks naming disjoint files are not flagged by the default guards', () => {
  const shared = 'retry claim stale marker dispatch ledger scanner worker queue';
  const a = { id: 'task-alpha', title: 'Fix src/alpha-router.js', promptContext: { rawText: shared } };
  const b = { id: 'task-bravo', title: 'Fix src/bravo-queue.js', promptContext: { rawText: shared } };
  assert.strictEqual(namesDisjointFiles(a, b), true);
  assert.strictEqual(findDuplicateTask(a, [b]), null);
  assert.ok(findDuplicateTask(a, [b], { fileDisjointCheck: false, relationCheck: false, siblingCheck: false }), 'sanity: pair would be flagged without the file guard');
});
