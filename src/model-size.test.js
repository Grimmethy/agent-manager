'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { modelSize, smallestModelSize, sizeFromTag } = require('./model-size.js');

test('sizes come from the tag after the family and version', () => {
  const cases = [['ornith:35b', 35], ['ornith-p40:35b', 35], ['qwen3-vl:8b-instruct', 8], ['qwen3.8:27b-q4_K_M', 27], ['qwen3.8:27b-q8_0', 27],
    ['qwen2.5:1.5b', 1.5], ['gemma4:e4b-it-qat', 4], ['qwen3-vl:4b-instruct', 4], ['gemma4:31b-it-qat', 31], ['qwen3.8-27b-uncensored:q4_k_m', 27]];
  for (const [tag, b] of cases) assert.equal(sizeFromTag(tag), b, tag);
  assert.equal(modelSize('ornith:35b', 'local').label, '35B');
  assert.equal(modelSize('qwen2.5:1.5b', 'local').label, '1.5B');
});

test('version digits are never read as a size', () => {
  assert.equal(sizeFromTag('gemma4'), null);
  assert.equal(sizeFromTag('qwen3.8'), null);
  assert.equal(sizeFromTag('qwen3.8:latest'), null);
  assert.equal(sizeFromTag('llama3b'), null);
  assert.equal(sizeFromTag('3b-model'), null, 'a tag that starts with digits has no separator before them');
  assert.equal(modelSize('gemma4', 'local').b, null);
});

test('cloud models use the nominal table, case-insensitively, and an unknown cloud name is 100', () => {
  assert.deepEqual(modelSize('claude-haiku-5-5', 'cloud'), { b: 30, tier: 'medium', label: 'cloud haiku', scale: 1.25, source: 'cloud-table' });
  assert.equal(modelSize('Claude-SONNET-5-5', 'cloud').b, 100);
  assert.equal(modelSize('CLAUDE-HAIKU-5-5', 'cloud').b, 30, 'matched case-insensitively');
  assert.equal(modelSize('claude-opus-5-5', 'cloud').b, 200);
  assert.equal(modelSize('claude-fable-5-1', 'cloud').b, 400);
  assert.equal(modelSize('claude-fable-5-1', 'cloud').tier, 'large');
  assert.deepEqual(modelSize('mystery-model', 'cloud'), { b: 100, tier: 'large', label: 'cloud', scale: 1.5, source: 'cloud-table' });
});

test('a script is size 0 with the smallest scale', () => {
  assert.deepEqual(modelSize('apply-loop', 'script'), { b: 0, tier: 'script', label: 'script', scale: 0.8, source: 'none' });
  assert.deepEqual(modelSize(null, 'script', 35), { b: 0, tier: 'script', label: 'script', scale: 0.8, source: 'none' });
});

test('no size in the tag falls back to tierB, then to unknown', () => {
  assert.deepEqual(modelSize('custom-model', 'local', 8), { b: 8, tier: 'small', label: '8B', scale: 1.0, source: 'tierB' });
  assert.deepEqual(modelSize('custom-model', 'local', null), { b: null, tier: 'medium', label: '?B', scale: 1.0, source: 'none' });
  assert.equal(modelSize('custom-model', 'local', 0).source, 'none');
  assert.equal(modelSize('custom-model', 'local', NaN).source, 'none');
  assert.equal(modelSize('ornith:35b', 'local', 8).b, 35, 'the tag wins over tierB');
});

test('tier boundaries: 10 is small, 40 is medium, above 40 is large', () => {
  assert.equal(modelSize('m:10b', 'local').tier, 'small');
  assert.equal(modelSize('m:10.5b', 'local').tier, 'medium');
  assert.equal(modelSize('m:40b', 'local').tier, 'medium');
  assert.equal(modelSize('m:41b', 'local').tier, 'large');
  assert.equal(modelSize('m:70b', 'local').scale, 1.5);
  assert.equal(modelSize('ornith:35b', 'local').scale, 1.25);
  assert.equal(modelSize('qwen3-vl:8b-instruct', 'local').scale, 1.0);
});

test('smallestModelSize: the smallest wins, script is smallest, unknown loses, a tie keeps the first', () => {
  const models = [{ name: 'ornith:35b', provider: 'local' }, { name: 'qwen3-vl:8b-instruct', provider: 'local' }, { name: 'claude-haiku-5-5', provider: 'cloud' }];
  assert.equal(smallestModelSize(models).label, '8B');
  assert.equal(smallestModelSize([...models, { name: 'apply-loop', provider: 'script' }]).label, 'script');
  assert.equal(smallestModelSize([{ name: 'mystery', provider: 'local' }, { name: 'ornith:35b', provider: 'local' }]).label, '35B');
  assert.equal(smallestModelSize([{ name: 'x', provider: 'local', tierB: 8 }, { name: 'b:8b', provider: 'local' }]).source, 'tierB', 'a tie keeps the first');
  assert.equal(smallestModelSize([{ name: 'x:35b', provider: 'local' }, { name: 'y:35b', provider: 'local' }, { name: 'z:36b', provider: 'local' }]).b, 35);
});

test('smallestModelSize: empty or bad input gives null and the input is not mutated', () => {
  assert.equal(smallestModelSize([]), null);
  assert.equal(smallestModelSize(null), null);
  assert.equal(smallestModelSize('x'), null);
  assert.equal(smallestModelSize([null, 5]), null);
  const models = [{ name: 'ornith:35b', provider: 'local', tierB: 35 }];
  const before = JSON.stringify(models);
  smallestModelSize(models);
  assert.equal(JSON.stringify(models), before);
});

test('modelSize never throws on odd input', () => {
  for (const args of [[], [undefined, undefined], [{}, 'cloud'], [123, 'local'], [null, 'weird', 'x']]) assert.doesNotThrow(() => modelSize(...args));
  assert.equal(modelSize(undefined, undefined).source, 'none');
});
