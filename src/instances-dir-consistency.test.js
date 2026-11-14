'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveInstancesDir, findInstancesDirMismatches, parseEnviron } = require('./instances-dir-consistency.js');

const LANES = '/p/chat-plugin-pipeline';
const CORE = '/p/agent-manager';
const lane = (label, extra = {}) => ({ label, pid: 1, env: { AGENT_MANAGER_PIPELINE_DIR: LANES, ...extra } });

test('identical dirs, and a pin that resolves to the same dir, are not a mismatch', () => {
  assert.deepEqual(findInstancesDirMismatches([lane('worker-3090'), lane('reviewer')]), []);
  assert.deepEqual(
    findInstancesDirMismatches([lane('worker-3090'), { label: 'chat', pid: 2, env: { AGENT_MANAGER_PIPELINE_DIR: CORE, AGENT_MANAGER_INSTANCES_DIR: `${LANES}/instances` } }]),
    [],
  );
});

test('a lane on the chat-plugin pipeline vs a process on core is exactly one mismatch naming both', () => {
  const out = findInstancesDirMismatches([lane('worker-3090'), { label: 'dashboard', pid: 3, env: { AGENT_MANAGER_PIPELINE_DIR: CORE } }]);
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].labels].sort(), ['dashboard', 'worker-3090']);
  assert.deepEqual([...out[0].dirs].sort(), [`${CORE}/instances`, `${LANES}/instances`]);
  assert.deepEqual(out[0].byDir[`${LANES}/instances`], ['worker-3090']);
});

test('entries with no resolvable dir are skipped, and empty or missing input is clean', () => {
  assert.deepEqual(findInstancesDirMismatches([lane('worker-3090'), { label: 'x', pid: 4, env: {} }, { label: 'y', pid: 5 }]), []);
  assert.deepEqual(findInstancesDirMismatches([]), []);
  assert.deepEqual(findInstancesDirMismatches(undefined), []);
});

test('the injected realpath collapses two spellings of one dir', () => {
  const entries = [
    { label: 'a', pid: 1, env: { AGENT_MANAGER_PIPELINE_DIR: '/media/wok/model-cache/agent-manager' } },
    { label: 'b', pid: 2, env: { AGENT_MANAGER_PIPELINE_DIR: '/media/model-cache/github/agent-manager' } },
  ];
  assert.equal(findInstancesDirMismatches(entries).length, 1, 'differs as written');
  const real = (p) => p.replace('/media/wok/model-cache/agent-manager', '/media/model-cache/github/agent-manager');
  assert.deepEqual(findInstancesDirMismatches(entries, { realpath: real }), []);
});

test('resolveInstancesDir: the pin wins over the pipeline dir; neither gives null', () => {
  assert.equal(resolveInstancesDir({ AGENT_MANAGER_INSTANCES_DIR: '/pin', AGENT_MANAGER_PIPELINE_DIR: CORE }), '/pin');
  assert.equal(resolveInstancesDir({ AGENT_MANAGER_PIPELINE_DIR: CORE }), `${CORE}/instances`);
  assert.equal(resolveInstancesDir({}), null);
});

test('parseEnviron reads NUL-separated pairs and keeps values containing =', () => {
  assert.deepEqual(parseEnviron('A=1\0B=x=y\0\0C='), { A: '1', B: 'x=y', C: '' });
  assert.deepEqual(parseEnviron(''), {});
});
