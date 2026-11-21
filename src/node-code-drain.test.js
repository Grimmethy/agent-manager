'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { drainStep, finishDrain, readLaneStatuses } = require('./node-code-drain.js');
const { PENDING_FILE } = require('./node-code-restart.js');

const NEW_SHA = `aaaaaaaa${'b'.repeat(32)}`;
const NOW = Date.parse('2026-11-16T12:00:00.000Z');

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-code-drain-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeRecord(dir, overrides = {}) {
  fs.mkdirSync(path.join(dir, 'instances'), { recursive: true });
  const record = {
    oldSha: 'c'.repeat(40),
    newSha: NEW_SHA,
    units: true,
    pipeline: true,
    matched: { units: [], pipeline: [] },
    since: new Date(NOW - 60000).toISOString(),
    alerted: false,
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'instances', PENDING_FILE), JSON.stringify(record));
  return record;
}

function readRecordFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'instances', PENDING_FILE), 'utf8'));
}

function fakes({ pause = null, lanes = ['idle'], draft = false } = {}) {
  const calls = { readPause: 0, setPause: [], clearPause: 0, notify: [], lanes: 0, drafts: 0 };
  return {
    calls,
    pauses: {
      readPause: () => {
        calls.readPause += 1;
        return pause;
      },
      setPause: (scope, opts) => {
        calls.setPause.push({ scope, ...opts });
        return null;
      },
      clearPause: () => {
        calls.clearPause += 1;
        return true;
      },
    },
    lanes: () => {
      calls.lanes += 1;
      return lanes;
    },
    drafts: () => {
      calls.drafts += 1;
      return draft;
    },
    notify: (message) => {
      calls.notify.push(message);
      return { sent: true };
    },
  };
}

test('no record means none and no calls', () => {
  withDir((dir) => {
    const f = fakes();
    assert.strictEqual(drainStep({ pipelineDir: dir, env: {}, now: NOW, ...f }), 'none');
    assert.strictEqual(f.calls.readPause, 0);
    assert.strictEqual(f.calls.setPause.length, 0);
    assert.strictEqual(f.calls.clearPause, 0);
    assert.strictEqual(f.calls.notify.length, 0);
    assert.strictEqual(f.calls.lanes, 0);
    assert.strictEqual(f.calls.drafts, 0);
  });
});

test('foreign pause is never written over or cleared, one notice over five calls', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = fakes({ pause: { source: 'operator', reason: 'manual' } });
    for (let i = 0; i < 5; i += 1) {
      assert.strictEqual(drainStep({ pipelineDir: dir, env: {}, now: NOW, ...f }), 'blocked');
    }
    assert.strictEqual(f.calls.setPause.length, 0);
    assert.strictEqual(f.calls.clearPause, 0);
    assert.strictEqual(f.calls.notify.length, 1);
    assert.strictEqual(f.calls.notify[0].key, 'code-restart-blocked:aaaaaaaa');
    assert.strictEqual(readRecordFile(dir).alerted, true);
  });
});

test('busy lane waits and the own pause is set with newSha8 in the reason', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = fakes({ lanes: ['busy'] });
    assert.strictEqual(drainStep({ pipelineDir: dir, env: {}, now: NOW, ...f }), 'waiting');
    assert.strictEqual(f.calls.setPause.length, 1);
    assert.strictEqual(f.calls.setPause[0].scope, 'node');
    assert.strictEqual(f.calls.setPause[0].source, 'code-sync');
    assert.ok(f.calls.setPause[0].reason.includes('aaaaaaaa'));
    assert.strictEqual(f.calls.setPause[0].ttlMin, 5);
    assert.strictEqual(f.calls.clearPause, 0);
  });
});

test('in-flight draft waits even when every lane is idle', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = fakes({ lanes: ['idle', 'disabled'], draft: true });
    assert.strictEqual(drainStep({ pipelineDir: dir, env: {}, now: NOW, ...f }), 'waiting');
  });
});

test('idle and disabled lanes with no draft return ready', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = fakes({ lanes: ['idle', 'disabled'], draft: false });
    assert.strictEqual(drainStep({ pipelineDir: dir, env: {}, now: NOW, ...f }), 'ready');
    assert.strictEqual(f.calls.clearPause, 0);
  });
});

test('own pause is refreshed on every non-foreign call', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = fakes({ lanes: ['busy'] });
    for (let i = 0; i < 3; i += 1) drainStep({ pipelineDir: dir, env: {}, now: NOW, ...f });
    assert.strictEqual(f.calls.setPause.length, 3);
  });
});

test('past the default limit returns stuck, alerts once, clears nothing', () => {
  withDir((dir) => {
    writeRecord(dir, { since: new Date(NOW - 31 * 60 * 1000).toISOString() });
    const f = fakes({ lanes: ['busy'] });
    for (let i = 0; i < 3; i += 1) {
      assert.strictEqual(drainStep({ pipelineDir: dir, env: {}, now: NOW, ...f }), 'stuck');
    }
    assert.strictEqual(f.calls.clearPause, 0);
    assert.strictEqual(f.calls.setPause.length, 0);
    assert.strictEqual(f.calls.notify.length, 1);
    assert.strictEqual(f.calls.notify[0].key, 'code-restart-stuck:aaaaaaaa');
    assert.strictEqual(readRecordFile(dir).stuckAlerted, true);
  });
});

test('custom AGENT_MANAGER_CODE_DRAIN_MAX_MIN is honoured', () => {
  withDir((dir) => {
    writeRecord(dir, { since: new Date(NOW - 11 * 60 * 1000).toISOString() });
    const f = fakes({ lanes: ['busy'] });
    assert.strictEqual(drainStep({ pipelineDir: dir, env: { AGENT_MANAGER_CODE_DRAIN_MAX_MIN: '10' }, now: NOW, ...f }), 'stuck');
    const g = fakes({ lanes: ['busy'] });
    assert.strictEqual(drainStep({ pipelineDir: dir, env: { AGENT_MANAGER_CODE_DRAIN_MAX_MIN: '20' }, now: NOW, ...g }), 'waiting');
  });
});

test('readLaneStatuses ignores non-heartbeat JSON and the pending record', () => {
  withDir((dir) => {
    writeRecord(dir);
    const instances = path.join(dir, 'instances');
    fs.writeFileSync(path.join(instances, 'worker-1.json'), JSON.stringify({ status: 'idle' }));
    fs.writeFileSync(path.join(instances, 'other.json'), JSON.stringify({ foo: 1 }));
    assert.deepStrictEqual(readLaneStatuses(dir), ['idle']);
  });
});

function onEnv(extra = {}) {
  return { AGENT_MANAGER_CODE_PULL: 'on', AGENT_MANAGER_REPO_ROOT: '/repo', ...extra };
}

function finishFakes({ pause = null, failUnit = null } = {}) {
  const calls = { run: [], clearPause: 0, notify: [] };
  return {
    calls,
    run: (cmd, args) => {
      calls.run.push([cmd, ...args]);
      if (failUnit && args.includes(failUnit)) throw new Error('unit failed');
      return '';
    },
    notify: (message) => {
      calls.notify.push(message);
      return { sent: true };
    },
    pauses: {
      readPause: () => pause,
      setPause: () => null,
      clearPause: () => {
        calls.clearPause += 1;
        return true;
      },
    },
  };
}

test('finishDrain runs units before launch.sh and clears our own pause', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = finishFakes({ pause: { source: 'code-sync' } });
    const result = finishDrain({ pipelineDir: dir, env: onEnv(), now: NOW, run: f.run, notify: f.notify, pauses: f.pauses });
    assert.strictEqual(result, 'restarted');
    assert.deepStrictEqual(f.calls.run, [
      ['systemctl', '--user', 'restart', 'am-node-pull.service'],
      ['/repo/scripts/launch.sh'],
    ]);
    assert.strictEqual(f.calls.clearPause, 1);
    assert.strictEqual(f.calls.notify.length, 0);
    assert.strictEqual(fs.existsSync(path.join(dir, 'instances', PENDING_FILE)), false);
    const audit = fs.readFileSync(path.join(dir, 'instances', 'code-restart.log'), 'utf8').trim().split('\n');
    assert.strictEqual(audit.length, 2);
  });
});

test('finishDrain with units false skips systemctl', () => {
  withDir((dir) => {
    writeRecord(dir, { units: false });
    const f = finishFakes();
    finishDrain({ pipelineDir: dir, env: onEnv(), now: NOW, run: f.run, notify: f.notify, pauses: f.pauses });
    assert.deepStrictEqual(f.calls.run, [['/repo/scripts/launch.sh']]);
  });
});

test('finishDrain with pipeline false skips launch.sh', () => {
  withDir((dir) => {
    writeRecord(dir, { pipeline: false });
    const f = finishFakes();
    finishDrain({ pipelineDir: dir, env: onEnv(), now: NOW, run: f.run, notify: f.notify, pauses: f.pauses });
    assert.deepStrictEqual(f.calls.run, [['systemctl', '--user', 'restart', 'am-node-pull.service']]);
  });
});

test('finishDrain leaves a foreign pause in place', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = finishFakes({ pause: { source: 'operator' } });
    finishDrain({ pipelineDir: dir, env: onEnv(), now: NOW, run: f.run, notify: f.notify, pauses: f.pauses });
    assert.strictEqual(f.calls.clearPause, 0);
  });
});

test('one failing unit does not stop launch.sh and notifies once; the pause is still cleared', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = finishFakes({ pause: { source: 'code-sync' }, failUnit: 'bad.service' });
    const env = onEnv({ AGENT_MANAGER_CODE_RESTART_UNITS: 'bad.service, good.service' });
    assert.strictEqual(finishDrain({ pipelineDir: dir, env, now: NOW, run: f.run, notify: f.notify, pauses: f.pauses }), 'failed');
    assert.ok(f.calls.run.some((c) => c[0] === '/repo/scripts/launch.sh'));
    assert.strictEqual(f.calls.notify.length, 1);
    assert.ok(f.calls.notify[0].key.startsWith('code-restart-failed:'));
    assert.strictEqual(f.calls.notify[0].key, 'code-restart-failed:aaaaaaaa');
    assert.strictEqual(f.calls.clearPause, 1);
    assert.strictEqual(readRecordFile(dir).restartAttempted, true);
  });
});

test('finishDrain does not repeat a failed restart on the next call', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = finishFakes({ failUnit: 'am-node-pull.service' });
    finishDrain({ pipelineDir: dir, env: onEnv(), now: NOW, run: f.run, notify: f.notify, pauses: f.pauses });
    const before = f.calls.run.length;
    assert.strictEqual(finishDrain({ pipelineDir: dir, env: onEnv(), now: NOW, run: f.run, notify: f.notify, pauses: f.pauses }), 'none');
    assert.strictEqual(f.calls.run.length, before);
    assert.strictEqual(f.calls.notify.length, 1);
  });
});

test('finishDrain is off unless AGENT_MANAGER_CODE_PULL is on or dry-run', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = finishFakes({ pause: { source: 'code-sync' } });
    assert.strictEqual(finishDrain({ pipelineDir: dir, env: {}, now: NOW, run: f.run, notify: f.notify, pauses: f.pauses }), 'off');
    assert.strictEqual(f.calls.run.length, 0);
    assert.strictEqual(f.calls.clearPause, 0);
    assert.strictEqual(fs.existsSync(path.join(dir, 'instances', PENDING_FILE)), true);
  });
});

test('finishDrain dry-run audits only and changes nothing', () => {
  withDir((dir) => {
    writeRecord(dir);
    const f = finishFakes({ pause: { source: 'code-sync' } });
    assert.strictEqual(finishDrain({ pipelineDir: dir, env: onEnv({ AGENT_MANAGER_CODE_PULL: 'dry-run' }), now: NOW, run: f.run, notify: f.notify, pauses: f.pauses }), 'dry-run');
    assert.strictEqual(f.calls.run.length, 0);
    assert.strictEqual(f.calls.clearPause, 0);
    assert.strictEqual(f.calls.notify.length, 0);
    assert.strictEqual(readRecordFile(dir).restartAttempted, undefined);
    assert.ok(fs.existsSync(path.join(dir, 'instances', 'code-restart.log')));
  });
});

test('finishDrain with AGENT_MANAGER_REPO_ROOT unset audits launch.sh as a failure', () => {
  withDir((dir) => {
    writeRecord(dir, { units: false });
    const f = finishFakes();
    const env = { AGENT_MANAGER_CODE_PULL: 'on' };
    assert.strictEqual(finishDrain({ pipelineDir: dir, env, now: NOW, run: f.run, notify: f.notify, pauses: f.pauses }), 'failed');
    assert.strictEqual(f.calls.run.length, 0);
    assert.strictEqual(f.calls.notify.length, 1);
  });
});
