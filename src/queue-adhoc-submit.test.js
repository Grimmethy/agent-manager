'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'queue-adhoc-submit.js');

describe('queue-adhoc-submit CLI', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-submit-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Each case gets its own pipeline dir so one case's queue entries can't leak into another's assertions.
  function makePipeline() {
    const dir = fs.mkdtempSync(path.join(root, 'pipeline-'));
    fs.writeFileSync(
      path.join(dir, 'task-domains.json'),
      JSON.stringify({ default: {}, adhoc: {}, other_domain: {} }),
    );
    return dir;
  }

  function runSubmit(input) {
    return spawnSync(process.execPath, [SCRIPT, JSON.stringify(input)], {
      env: { ...process.env, AGENT_MANAGER_REPO_ROOT: root },
      encoding: 'utf8',
    });
  }

  it('happy path: prints {id, filePath} and writes a record matching the input', () => {
    const pipelineDir = makePipeline();
    const input = {
      title: 'Submit CLI happy path',
      promptContext: { rawText: 'do the thing' },
      premium: true,
      pipelineDir,
      raisedFrom: 'brain-dump-42',
    };

    const result = runSubmit(input);
    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);

    const out = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(typeof out.filePath, 'string');
    assert.ok(fs.existsSync(out.filePath), 'record file must exist at filePath');

    const record = JSON.parse(fs.readFileSync(out.filePath, 'utf8'));
    assert.equal(record.id, out.id);
    assert.equal(record.title, input.title);
    assert.equal(record.promptContext.rawText, input.promptContext.rawText);
    assert.equal(record.premiumPriority, true);
    assert.equal(record.raisedFrom, input.raisedFrom);
  });

  it('empty title: exits 1, writes to stderr, and creates no queue/adhoc entries', () => {
    const pipelineDir = makePipeline();
    const result = runSubmit({
      title: '',
      promptContext: { rawText: 'ignored' },
      pipelineDir,
    });

    assert.equal(result.status, 1);
    assert.notEqual(result.stderr.trim(), '', 'stderr must explain the failure');

    const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
    const entries = fs.existsSync(adhocDir) ? fs.readdirSync(adhocDir) : [];
    assert.deepEqual(entries, [], 'no queue/adhoc entries may be written on a bad title');
  });
});
