'use strict';

// prompt-assembly.js -- extracted from src/prompts.js ([[hub-task-integration]] node-module decompose).

function assemblePrompt(stableLines, volatileLines) {
  return [...stableLines, '', ...volatileLines].join('\n');
}

module.exports = { assemblePrompt };
