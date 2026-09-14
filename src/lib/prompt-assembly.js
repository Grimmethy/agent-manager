'use strict';

// prompt-assembly.js -- extracted from src/prompts.js ([[hub-task-integration]] node-module decompose).

require('../task-sources.js');

function assemblePrompt(stableLines, volatileLines) {
  return [...stableLines, '', ...volatileLines].join('\n');
}

module.exports = { assemblePrompt };
