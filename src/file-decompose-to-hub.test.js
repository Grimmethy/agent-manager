// src/file-decompose-to-hub.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validatePlan } = require('./file-decompose-to-hub.js');

describe('validatePlan', () => {
  it('rejects a piece with only test files (*.test.js)', () => {
    const moves = [
      {
        name: 'test-piece',
        targets: ['src/foo.test.js', 'src/bar.test.js']
      }
    ];
    const errors = validatePlan(moves);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Piece test-piece contains only test files/);
  });

  it('rejects a piece with only test files (*.spec.js)', () => {
    const moves = [
      {
        name: 'spec-piece',
        targets: ['src/foo.spec.js', 'src/bar.spec.js']
      }
    ];
    const errors = validatePlan(moves);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Piece spec-piece contains only test files/);
  });

  it('rejects a piece with only test files (__tests__/)', () => {
    const moves = [
      {
        name: 'tests-piece',
        targets: ['__tests__/foo.js', '__tests__/bar.js']
      }
    ];
    const errors = validatePlan(moves);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Piece tests-piece contains only test files/);
  });

  it('accepts a piece with mixed test and implementation files', () => {
    const moves = [
      {
        name: 'mixed-piece',
        targets: ['src/foo.js', 'src/foo.test.js']
      }
    ];
    const errors = validatePlan(moves);
    assert.equal(errors.length, 0);
  });

  it('accepts a piece with only implementation files', () => {
    const moves = [
      {
        name: 'impl-piece',
        targets: ['src/foo.js', 'src/bar.js']
      }
    ];
    const errors = validatePlan(moves);
    assert.equal(errors.length, 0);
  });

  it('accepts an empty targets array', () => {
    const moves = [
      {
        name: 'empty-piece',
        targets: []
      }
    ];
    const errors = validatePlan(moves);
    assert.equal(errors.length, 0);
  });

  it('rejects multiple pieces with only test files', () => {
    const moves = [
      {
        name: 'test-piece-1',
        targets: ['src/foo.test.js']
      },
      {
        name: 'test-piece-2',
        targets: ['src/bar.spec.js']
      }
    ];
    const errors = validatePlan(moves);
    assert.equal(errors.length, 2);
  });
});
