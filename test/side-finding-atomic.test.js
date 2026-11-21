'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { writeSideFindingInbox, inboxDir } = require('../src/side-finding');

function makePipeline() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hub0668-atomic-'));
}

function listInbox(pipelineDir) {
  const dir = inboxDir(pipelineDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

const FINDING = { title: 'Atomic write check', body: 'Body text for the atomic write check.' };
const OPTS_BASE = {
  source: 'test-source',
  taskId: 'HUB0668',
  stage: 'implement',
  conceptId: 'concept-atomic',
  repoRoot: '/tmp/fake-repo-root',
};

test('case A: successful write leaves exactly one sf-*.json that parses to the expected record', () => {
  const pipelineDir = makePipeline();
  try {
    writeSideFindingInbox(FINDING, { ...OPTS_BASE, pipelineDir });

    const sfFiles = listInbox(pipelineDir).filter((n) => /^sf-.*\.json$/.test(n));
    assert.equal(sfFiles.length, 1, `expected exactly one sf-*.json, got ${JSON.stringify(sfFiles)}`);

    const record = JSON.parse(fs.readFileSync(path.join(inboxDir(pipelineDir), sfFiles[0]), 'utf8'));
    assert.equal(record.title, FINDING.title);
    assert.equal(record.body, FINDING.body);
    assert.equal(record.source, OPTS_BASE.source);
    assert.equal(record.taskId, OPTS_BASE.taskId);
    assert.equal(record.stage, OPTS_BASE.stage);
    assert.equal(record.conceptId, OPTS_BASE.conceptId);
    assert.equal(record.repoRoot, OPTS_BASE.repoRoot);
    assert.equal(typeof record.extractedAt, 'string');
  } finally {
    fs.rmSync(pipelineDir, { recursive: true, force: true });
  }
});

test('case B: forced failure (inbox path is a regular file) does not throw out of writeSideFindingInbox', () => {
  const pipelineDir = makePipeline();
  const origWarn = console.warn;
  let warnCount = 0;
  try {
    fs.mkdirSync(path.join(pipelineDir, 'queue'), { recursive: true });
    // A regular file where the inbox directory should be makes mkdirSync fail.
    fs.writeFileSync(inboxDir(pipelineDir), 'not a directory');

    console.warn = () => { warnCount += 1; };
    assert.doesNotThrow(() => writeSideFindingInbox(FINDING, { ...OPTS_BASE, pipelineDir }));
    assert.equal(warnCount, 1, 'expected exactly one non-fatal warning');
  } finally {
    console.warn = origWarn;
    fs.rmSync(pipelineDir, { recursive: true, force: true });
  }
});

test('case C: mid-write ENOSPC leaves no partial sf-*.json behind', () => {
  const pipelineDir = makePipeline();
  const realFsync = fs.fsyncSync;
  const origWarn = console.warn;
  let warnCount = 0;
  console.warn = () => { warnCount += 1; };
  try {
    // The atomic helper writes to a temp file, then fsyncs, then renames. Failing fsync
    // injects ENOSPC after the bytes are written to the temp file but before the rename.
    fs.fsyncSync = function () {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    assert.doesNotThrow(() => writeSideFindingInbox(FINDING, { ...OPTS_BASE, pipelineDir }));
  } finally {
    fs.fsyncSync = realFsync;
    console.warn = origWarn;
  }

  try {
    assert.equal(warnCount, 1, 'expected the injected ENOSPC to be caught and logged once');
    const entries = listInbox(pipelineDir);
    const partial = entries.filter((n) => /^sf-.*\.json$/.test(n));
    const temps = entries.filter((n) => /^\.sf-.*\.tmp-/.test(n));
    assert.deepEqual(
      partial,
      [],
      `truncated sf-*.json left behind; write is not atomic (temp leftovers: ${JSON.stringify(temps)})`,
    );
  } finally {
    fs.rmSync(pipelineDir, { recursive: true, force: true });
  }
});
