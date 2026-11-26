// file-decompose-to-hub.js
// Coordinator hub for file decomposition tasks

/**
 * Validate a decompose plan before filing.
 * @param {Array} moves - Array of move objects with {name, targets}
 * @returns {Array} Array of error messages, empty if valid
 */
function validatePlan(moves) {
  const errors = [];

  for (const move of moves) {
    const { name, targets } = move;

    // Check if all targets are test files
    const allTestFiles = targets.every(target => {
      return (
        target.endsWith('.test.js') ||
        target.endsWith('.spec.js') ||
        target.startsWith('__tests__/')
      );
    });

    if (allTestFiles && targets.length > 0) {
      errors.push(
        `Piece ${name} contains only test files; tests must be folded into an implementation piece`
      );
    }
  }

  return errors;
}

module.exports = { validatePlan };
