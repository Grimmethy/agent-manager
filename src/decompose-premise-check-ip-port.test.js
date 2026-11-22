'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LINE_REF_RE } = require('./decompose-premise-check.js');

const cites = (t) => [...t.matchAll(LINE_REF_RE)].map((m) => m[1]);

test('an IP address followed by a port is not a line citation', () => {
  assert.deepEqual(cites('http://127.0.0.1:11434'), []);
  assert.deepEqual(cites('http://127.0.0.1:7450'), []);
  assert.deepEqual(cites('192.168.40.11:7473'), []);
});

test('a file extension followed by a line number is still a citation', () => {
  assert.deepEqual(cites('src/deps.js:11'), ['11']);
  assert.deepEqual(cites('see src/foo.py:120'), ['120']);
  assert.deepEqual(cites('src/config.json:55'), ['55']);
  assert.deepEqual(cites('x/y.jsonl:12'), ['12']);
});

test('digits followed by letters are not a citation', () => {
  assert.deepEqual(cites('src/a.js:12abc'), []);
  assert.deepEqual(/\.\w{1,5}:(\d{2,6})\b/gi.exec('src/a.js:12abc'), null);
});
