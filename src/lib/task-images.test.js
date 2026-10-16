'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadTaskImages, MAX_IMAGES } = require('./task-images.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-images-'));
const png = path.join(dir, 'a.png');
fs.writeFileSync(png, Buffer.from([137, 80, 78, 71]));

test('no imagePaths -> no images', () => {
  assert.deepEqual(loadTaskImages(undefined), []);
  assert.deepEqual(loadTaskImages({}), []);
  assert.deepEqual(loadTaskImages({ imagePaths: [] }), []);
});

test('an image file becomes base64', () => {
  assert.deepEqual(loadTaskImages({ imagePaths: [png] }), [Buffer.from([137, 80, 78, 71]).toString('base64')]);
});

test('bad inputs throw rather than silently dropping the picture', () => {
  assert.throws(() => loadTaskImages({ imagePaths: 'x.png' }), /array/);
  assert.throws(() => loadTaskImages({ imagePaths: ['rel.png'] }), /absolute/);
  assert.throws(() => loadTaskImages({ imagePaths: [path.join(dir, 'a.txt')] }), /png\/jpg\/webp/);
  assert.throws(() => loadTaskImages({ imagePaths: [path.join(dir, 'missing.png')] }), /unreadable/);
  assert.throws(() => loadTaskImages({ imagePaths: Array(MAX_IMAGES + 1).fill(png) }), /limit/);
  assert.throws(() => loadTaskImages({ imagePaths: [dir + '/x.png'.replace('x', 'sub')] }), /unreadable/);
});
