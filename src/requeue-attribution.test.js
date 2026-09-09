'use strict';

// Unit tests for requeue-attribution.js's classifier (2026-09-08). Real throwaway sqlite
// dbs throughout (requeue-attribution.db, task-links.db, and a synthetic model-stats.db
// fixture for the GPU-contention overlap query) -- mirrors this session's own established
// convention of exercising real db-backed modules as the real subprocess/reader they're
// built to be, not mocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeModelCallsFixture(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE model_calls (
      call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at TEXT NOT NULL, latency_ms INTEGER
    );
    CREATE INDEX idx_model_calls_task_id ON model_calls(task_id);
  `);
  const stmt = db.prepare('INSERT INTO model_calls (call_id, task_id, started_at, latency_ms) VALUES (?, ?, ?, ?)');
  for (const r of rows) stmt.run(r.callId, r.taskId, r.startedAt, r.latencyMs);
  db.close();
}

function withFreshEnv(fn) {
  const dir = freshDir('requeue-attribution-test-');
  process.env.AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH = path.join(dir, 'requeue-attribution.db');
  process.env.AGENT_MANAGER_TASK_LINKS_DB_PATH = path.join(dir, 'task-links.db');
  process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH = path.join(dir, 'model-stats.db');
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  for (const mod of ['./requeue-attribution.js', './requeue-attribution-client.js', './task-links-client.js']) {
    delete require.cache[require.resolve(mod)];
  }
  const ra = require('./requeue-attribution.js');
  ra._resetFallbackRateLimitForTests();
  return fn(ra, dir);
}

test('structured-signal path (BLOCKER-TYPE) resolves without any model call', async () => {
  await withFreshEnv(async (ra) => {
    let modelCalls = 0;
    const fakeCallModel = async () => { modelCalls++; return { response: 'CAUSE: genuine-bug' }; };
    const task = { id: 't1', blockedReason: 'BLOCKER-TYPE: infra-error something broke' };
    const { category } = await ra.classifyRequeue(task, { requeueWriter: 'test', repoRoot: process.env.AGENT_MANAGER_REPO_ROOT, callModel: fakeCallModel });
    assert.equal(category, 'infra-error');
    assert.equal(modelCalls, 0, 'a structured signal must never spend a model call');
  });
});

test('structured-signal path (stalenessFlag.reason) resolves without any model call', async () => {
  await withFreshEnv(async (ra) => {
    let modelCalls = 0;
    const fakeCallModel = async () => { modelCalls++; return { response: 'CAUSE: genuine-bug' }; };
    const task = { id: 't1', stalenessFlag: { reason: 'decompose-loop' } };
    const { category } = await ra.classifyRequeue(task, { requeueWriter: 'test', repoRoot: process.env.AGENT_MANAGER_REPO_ROOT, callModel: fakeCallModel });
    assert.equal(category, 'decompose-loop');
    assert.equal(modelCalls, 0);
  });
});

test('an Ollama-timeout reason with a real overlapping model_calls row from ANOTHER task classifies as gpu-contention, no model call', async () => {
  await withFreshEnv(async (ra, dir) => {
    const now = Date.now();
    makeModelCallsFixture(path.join(dir, 'model-stats.db'), [
      { callId: 'c1', taskId: 'other-task', startedAt: new Date(now - 5000).toISOString(), latencyMs: 20000 },
    ]);
    let modelCalls = 0;
    const fakeCallModel = async () => { modelCalls++; return { response: 'CAUSE: genuine-bug' }; };
    const task = { id: 't1', blockedReason: 'Ollama request timed out after 240000ms' };
    const { category } = await ra.classifyRequeue(task, { requeueWriter: 'test', repoRoot: process.env.AGENT_MANAGER_REPO_ROOT, callModel: fakeCallModel, now });
    assert.equal(category, 'gpu-contention');
    assert.equal(modelCalls, 0, 'a real deterministic GPU-contention match must never spend a model call');
  });
});

test('an Ollama-timeout reason with NO overlapping model_calls row falls through to the fallback model call', async () => {
  await withFreshEnv(async (ra, dir) => {
    const now = Date.now();
    makeModelCallsFixture(path.join(dir, 'model-stats.db'), [
      { callId: 'c1', taskId: 'other-task', startedAt: new Date(now - 3600000).toISOString(), latencyMs: 1000 }, // way outside the window
    ]);
    let modelCalls = 0;
    const fakeCallModel = async () => { modelCalls++; return { response: 'CAUSE: transient-infra' }; };
    const task = { id: 't1', blockedReason: 'Ollama request timed out after 240000ms' };
    const { category } = await ra.classifyRequeue(task, { requeueWriter: 'test', repoRoot: process.env.AGENT_MANAGER_REPO_ROOT, callModel: fakeCallModel, now });
    assert.equal(category, 'transient-infra');
    assert.equal(modelCalls, 1);
  });
});

test('the fallback model call is rate-limited -- the (N+1)th call in a window is skipped, classified unclassified', async () => {
  await withFreshEnv(async (ra) => {
    let modelCalls = 0;
    const fakeCallModel = async () => { modelCalls++; return { response: 'CAUSE: genuine-bug' }; };
    const now = Date.now();
    const max = Number(process.env.AGENT_MANAGER_REQUEUE_ATTRIBUTION_FALLBACK_RATE_LIMIT) || 5;
    for (let i = 0; i < max; i++) {
      const task = { id: `t-${i}`, blockedReason: `some genuinely novel unstructured reason ${i}` };
      // eslint-disable-next-line no-await-in-loop
      await ra.classifyRequeue(task, { requeueWriter: 'test', repoRoot: process.env.AGENT_MANAGER_REPO_ROOT, callModel: fakeCallModel, now });
    }
    assert.equal(modelCalls, max);

    const overflowTask = { id: 't-overflow', blockedReason: 'some genuinely novel unstructured reason overflow' };
    const { category } = await ra.classifyRequeue(overflowTask, { requeueWriter: 'test', repoRoot: process.env.AGENT_MANAGER_REPO_ROOT, callModel: fakeCallModel, now });
    assert.equal(modelCalls, max, 'the rate-limited call must not reach the fallback model at all');
    assert.equal(category, 'unclassified');
  });
});

test('signature normalization strips timestamps/ids/paths but keeps error-code-shaped tokens (same category+text -> same signature)', () => {
  withFreshEnv((ra) => {
    const sigA = ra.buildSignature('transient-infra', 'ECONNREFUSED at 2026-09-08T10:00:00Z in src/local-client.js (abc123def456)');
    const sigB = ra.buildSignature('transient-infra', 'ECONNREFUSED at 2026-09-08T12:30:00Z in src/local-client.js (fed654cba321)');
    assert.equal(sigA, sigB, 'only the timestamp/hex-id/path differ -- must normalize to the same signature');

    const sigDifferentCause = ra.buildSignature('gpu-contention', 'ECONNREFUSED at 2026-09-08T10:00:00Z in src/local-client.js (abc123def456)');
    assert.notEqual(sigA, sigDifferentCause, 'a different category must produce a different signature even with the same text');
  });
});

test('checkAndEscalate does not write a forensics-request file while the long-window count is still below threshold', () => {
  withFreshEnv((ra, dir) => {
    const { recordRequeueCause } = require('./requeue-attribution-client.js');
    const now = Date.now();
    const signature = 'belowthreshold1234567';
    // Only 1 occurrence -- below ESCALATION_LONG_THRESHOLD (2).
    recordRequeueCause({ taskId: 't-0', signature, requeueWriter: 'test' });
    ra.checkAndEscalate(signature, 't-latest', { repoRoot: dir, now });
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'forensics-requests')), false);
  });
});

test('checkAndEscalate writes a real forensics-request file once longCount/shortCount both cross threshold', () => {
  withFreshEnv((ra, dir) => {
    const { recordRequeueCause } = require('./requeue-attribution-client.js');
    const now = Date.now();
    const signature = 'deadbeefcafe1234567890';
    // 3 occurrences, all inside both the short (6h) and long (3d) windows.
    for (let i = 0; i < 3; i++) {
      recordRequeueCause({ taskId: `t-${i}`, signature, requeueWriter: 'test' });
    }
    ra.checkAndEscalate(signature, 't-latest', { repoRoot: dir, now });

    const requestPath = path.join(dir, 'queue', 'forensics-requests', `requeue-attribution-${signature.slice(0, 12)}.json`);
    assert.ok(fs.existsSync(requestPath));
    const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    assert.equal(req.taskId, 't-latest');
    assert.equal(req.requeueAttributionSignature, signature);
  });
});

test('checkAndEscalate does not overwrite an already-filed request for the same signature', () => {
  withFreshEnv((ra, dir) => {
    const { recordRequeueCause } = require('./requeue-attribution-client.js');
    const now = Date.now();
    const signature = 'deadbeefcafe1234567890';
    for (let i = 0; i < 3; i++) recordRequeueCause({ taskId: `t-${i}`, signature, requeueWriter: 'test' });
    ra.checkAndEscalate(signature, 't-first', { repoRoot: dir, now });

    const requestPath = path.join(dir, 'queue', 'forensics-requests', `requeue-attribution-${signature.slice(0, 12)}.json`);
    const before = fs.readFileSync(requestPath, 'utf8');
    ra.checkAndEscalate(signature, 't-second-should-not-overwrite', { repoRoot: dir, now: now + 1000 });
    const after = fs.readFileSync(requestPath, 'utf8');
    assert.equal(before, after);
  });
});

test('classifyRequeue writes a real requeue_causes row and a task-links contributes-to-signature link', async () => {
  await withFreshEnv(async (ra, dir) => {
    const task = { id: 'real-task-1', blockedReason: 'BLOCKER-TYPE: budget-exhausted ran out of turns' };
    const { signature } = await ra.classifyRequeue(task, { requeueWriter: 'needs-clarification-triage', blockedStage: 'implement', repoRoot: process.env.AGENT_MANAGER_REPO_ROOT });

    const raDb = new DatabaseSync(path.join(dir, 'requeue-attribution.db'), { readOnly: true });
    const row = raDb.prepare('SELECT * FROM requeue_causes WHERE task_id = ?').get('real-task-1');
    raDb.close();
    assert.ok(row);
    assert.equal(row.signature, signature);
    assert.equal(row.requeue_writer, 'needs-clarification-triage');
    assert.equal(row.blocked_stage, 'implement');

    const linksDb = new DatabaseSync(path.join(dir, 'task-links.db'), { readOnly: true });
    const link = linksDb.prepare('SELECT * FROM task_links WHERE source_id = ?').get('real-task-1');
    linksDb.close();
    assert.ok(link);
    assert.equal(link.target_id, signature);
    assert.equal(link.type, 'contributes-to-signature');
  });
});

// --- actor dimension + the manual-requeue CLI (2026-09-09, Ghost-in-the-Machine telemetry) ---

test('classifyRequeue threads actor through to the requeue_causes row (default pipeline-mechanism)', async () => {
  await withFreshEnv(async (ra, dir) => {
    await ra.classifyRequeue({ id: 'mech-1', blockedReason: 'x' }, { requeueWriter: 'blocked-drain', repoRoot: dir });
    await ra.classifyRequeue({ id: 'hand-1', blockedReason: 'x' }, { requeueWriter: 'operator-manual', actor: 'operator-manual', repoRoot: dir });
    const db = new DatabaseSync(path.join(dir, 'requeue-attribution.db'), { readOnly: true });
    assert.equal(db.prepare('SELECT actor FROM requeue_causes WHERE task_id = ?').get('mech-1').actor, 'pipeline-mechanism');
    assert.equal(db.prepare('SELECT actor FROM requeue_causes WHERE task_id = ?').get('hand-1').actor, 'operator-manual');
    db.close();
  });
});

test('classifyRequeue with skipFallbackModel never calls the model even for an unstructured reason', async () => {
  await withFreshEnv(async (ra, dir) => {
    let called = false;
    const callModel = async () => { called = true; return { response: 'CAUSE: genuine-bug' }; };
    const { category } = await ra.classifyRequeue(
      { id: 'skip-1', blockedReason: 'some freeform reason with no structured signal' },
      { requeueWriter: 'operator-manual', actor: 'operator-manual', skipFallbackModel: true, callModel, repoRoot: dir },
    );
    assert.equal(called, false);
    assert.equal(category, 'unclassified');
  });
});

test('the `classify` CLI records an operator-manual row and prints {signature,category}', async () => {
  await withFreshEnv(async (ra, dir) => {
    const { execFileSync } = require('child_process');
    const payloadPath = path.join(dir, 'payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify({
      task: { id: 'cli-task-1', blockedReason: 'BLOCKER-TYPE: infra-error a command failed' },
      reasonHint: 'manually requeued from blocked/',
      requeueWriter: 'operator-manual',
      actor: 'operator-manual',
    }));
    const out = execFileSync('node', [path.join(__dirname, 'requeue-attribution.js'), 'classify', payloadPath], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: dir, AGENT_MANAGER_REPO_ROOT: dir },
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.category, 'infra-error');
    assert.ok(parsed.signature);
    const db = new DatabaseSync(path.join(dir, 'requeue-attribution.db'), { readOnly: true });
    const row = db.prepare('SELECT * FROM requeue_causes WHERE task_id = ?').get('cli-task-1');
    db.close();
    assert.equal(row.actor, 'operator-manual');
    assert.equal(row.requeue_writer, 'operator-manual');
  });
});
