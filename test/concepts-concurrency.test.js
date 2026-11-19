'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const concepts = require('../src/concepts.js');

const MODULE = path.resolve(__dirname, '../src/concepts.js');

function runChild(script, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script, ...args], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function readConcepts(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'concepts.json'), 'utf8'));
}

test('8 processes x 50 increments yield exactly 400', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concepts-conc-'));
  try {
    const created = concepts.createConcept({ name: 'Counter Test' }, dir);
    const script = `const c = require(${JSON.stringify(MODULE)}); for (let i = 0; i < 50; i++) c.recordConceptBuildTally(process.argv[1], process.argv[2], 'scratch');`;
    await Promise.all(Array.from({ length: 8 }, () => runChild(script, [dir, created.id])));
    const row = readConcepts(dir).concepts.find((c) => c.id === created.id);
    assert.strictEqual(row.builtFromScratchCount, 400);
    assert.ok(!fs.existsSync(path.join(dir, 'concepts.json.lock')), 'lock file left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent createConcept with the same name yields one row', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concepts-conc-'));
  try {
    const script = `const c = require(${JSON.stringify(MODULE)}); c.createConcept({ name: 'Same Name' }, process.argv[1]);`;
    await Promise.all([runChild(script, [dir]), runChild(script, [dir])]);
    const rows = readConcepts(dir).concepts.filter((c) => c.slug === 'same-name');
    assert.strictEqual(rows.length, 1);
    assert.ok(!fs.existsSync(path.join(dir, 'concepts.json.lock')), 'lock file left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
