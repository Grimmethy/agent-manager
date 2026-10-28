'use strict';

// Decompose pass: splits a hub task into sub-tasks/pieces.
// Integrates inert check to detect unreferenced symbols in each piece's diff.

const { checkInertAdditions } = require('./decompose-inert-check');

// Simulate a hub task with pieces
function createMockHubTask() {
  return {
    id: 'test-hub-001',
    title: 'Test Hub Task',
    pieces: [
      {
        id: 'piece-1',
        title: 'First Piece',
        rawDiff: 'export function add(a, b) { return a + b; }\nexport function multiply(a, b) { return a * b; }\nconsole.log(add(1, 2));'
      },
      {
        id: 'piece-2',
        title: 'Second Piece',
        rawDiff: 'export function subtract(a, b) { return a - b; }\nexport function divide(a, b) { return a / b; }\nconsole.log(subtract(5, 3));'
      },
      {
        id: 'piece-3',
        title: 'Third Piece',
        rawDiff: 'export function power(a, b) { return Math.pow(a, b); }\n// power is never used in this piece'
      }
    ]
  };
}

// Run decompose pass on a hub task
async function runDecomposePass(hubTask) {
  if (!hubTask || !hubTask.pieces || hubTask.pieces.length === 0) {
    return { subTasks: [] };
  }

  const subTasks = [];

  for (let i = 0; i < hubTask.pieces.length; i++) {
    const piece = hubTask.pieces[i];
    const pieceResult = {
      id: piece.id,
      title: piece.title,
      rawDiff: piece.rawDiff,
      inertCheckAnnotation: false,
      inertCheck: null
    };

    // Check if this piece has a rawDiff and if there's a later sibling
    const hasLaterSibling = i < hubTask.pieces.length - 1;

    if (piece.rawDiff && hasLaterSibling) {
      // Run inert check on this piece
      const inertResult = checkInertAdditions(piece.rawDiff);

      // Annotate the piece if inert symbols are found
      if (inertResult.inertCheckAnnotation) {
        pieceResult.inertCheckAnnotation = true;
        pieceResult.inertCheck = {
          found: inertResult.found,
          willBeWiredBy: inertResult.willBeWiredBy,
          symbolCount: inertResult.symbolCount
        };
      }
    }

    subTasks.push(pieceResult);
  }

  return { subTasks };
}

module.exports = { runDecomposePass, createMockHubTask };
