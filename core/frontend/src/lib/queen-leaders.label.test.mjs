import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveLeaderLabel } from './queen-leaders-label.mjs';

function deriveIdLabel(id) {
  return id
    .replace(/^queen_/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

test('returns trimmed title when non-empty', () => {
  const label = deriveLeaderLabel('queen_brand_design', { title: '  Brand Design Lead  ' });
  assert.equal(label, 'Brand Design Lead');
});

test('returns id-derived label when profile is missing', () => {
  const label = deriveLeaderLabel('queen_brand_design', null);
  assert.equal(label, deriveIdLabel('queen_brand_design'));
});

test('returns id-derived label when title is empty or whitespace', () => {
  const labelEmpty = deriveLeaderLabel('queen_brand_design', { title: '' });
  assert.equal(labelEmpty, deriveIdLabel('queen_brand_design'));

  const labelWhitespace = deriveLeaderLabel('queen_brand_design', { title: '   ' });
  assert.equal(labelWhitespace, deriveIdLabel('queen_brand_design'));
});

test('changing the title for queen_brand_design makes the label follow it', () => {
  const profile = { title: 'Original Title' };
  const first = deriveLeaderLabel('queen_brand_design', profile);
  assert.equal(first, 'Original Title');

  profile.title = 'Updated Title';
  const second = deriveLeaderLabel('queen_brand_design', profile);
  assert.equal(second, 'Updated Title');
  assert.notEqual(first, second);
});
