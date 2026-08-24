'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { currentDateLine } = require('./current-date-line.js');

test('currentDateLine states the real, actual current date', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.match(currentDateLine(), new RegExp(`Real current date: ${today}`));
});

test('currentDateLine tells the model not to assume an earlier date is "now"', () => {
  assert.match(currentDateLine(), /do not assume/i);
});
