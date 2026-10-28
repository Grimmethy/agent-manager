'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runDecomposePass, createMockHubTask } = require('./decompose-pass');

describe('decompose-pass inert check integration', () => {
  it('annotates pieces with inert check results when inert symbols are detected', async () => {
    const hubTask = createMockHubTask();
    const result = await runDecomposePass(hubTask);

    // Piece 1 has add and multiply defined, but only add is referenced
    // Piece 3 has power defined but never referenced
    assert.equal(result.subTasks.length, 3);

    // Piece 1: add is referenced, multiply is not - should have inert annotation
    assert.equal(result.subTasks[0].inertCheckAnnotation, true);
    assert.ok(result.subTasks[0].inertCheck);
    assert.ok(result.subTasks[0].inertCheck.found.length > 0);
    assert.equal(result.subTasks[0].inertCheck.willBeWiredBy, 'sibling-piece');

    // Piece 2: subtract is referenced, divide is not - should have inert annotation
    assert.equal(result.subTasks[1].inertCheckAnnotation, true);
    assert.ok(result.subTasks[1].inertCheck);

    // Piece 3 is the last piece (no later sibling) - inert check is skipped
    assert.equal(result.subTasks[2].inertCheckAnnotation, false);
    assert.equal(result.subTasks[2].inertCheck, null);
  });

  it('skips inert check when no rawDiff exists', async () => {
    const hubTask = {
      id: 'test-hub-002',
      title: 'Test Hub Task 2',
      pieces: [
        { id: 'piece-1', title: 'First Piece', rawDiff: null },
        { id: 'piece-2', title: 'Second Piece', rawDiff: 'export function foo() {}' }
      ]
    };

    const result = await runDecomposePass(hubTask);

    assert.equal(result.subTasks.length, 2);
    // Piece 1 has no rawDiff - should not have inert annotation
    assert.equal(result.subTasks[0].inertCheckAnnotation, false);
    assert.equal(result.subTasks[0].inertCheck, null);

    // Piece 2 has rawDiff but is last piece (no later sibling) - should not run inert check
    assert.equal(result.subTasks[1].inertCheckAnnotation, false);
    assert.equal(result.subTasks[1].inertCheck, null);
  });

  it('does not annotate when no inert symbols are found', async () => {
    const hubTask = {
      id: 'test-hub-003',
      title: 'Test Hub Task 3',
      pieces: [
        {
          id: 'piece-1',
          title: 'First Piece',
          rawDiff: 'export function add(a, b) { return a + b; }\nconsole.log(add(1, 2));'
        },
        {
          id: 'piece-2',
          title: 'Second Piece',
          rawDiff: 'export function subtract(a, b) { return a - b; }\nconsole.log(subtract(5, 3));'
        }
      ]
    };

    const result = await runDecomposePass(hubTask);

    assert.equal(result.subTasks.length, 2);

    // Both pieces reference their exports - no inert symbols
    assert.equal(result.subTasks[0].inertCheckAnnotation, false);
    assert.equal(result.subTasks[0].inertCheck, null);

    assert.equal(result.subTasks[1].inertCheckAnnotation, false);
    assert.equal(result.subTasks[1].inertCheck, null);
  });

  it('handles empty hub task gracefully', async () => {
    const result = await runDecomposePass(null);
    assert.deepEqual(result, { subTasks: [] });

    const result2 = await runDecomposePass({ id: 'test', title: 'Test', pieces: [] });
    assert.deepEqual(result2, { subTasks: [] });
  });
});
