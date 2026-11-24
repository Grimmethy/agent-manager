'use strict';

/**
 * Choose a fence delimiter pair that does not occur inside `content`.
 *
 * Precedence:
 *   1. Triple backticks: ['```', '```'] if content does not contain it.
 *   2. Tildes: ['~~~', '~~~'] if content does not contain it.
 *   3. A backtick run one longer than the longest backtick run in content.
 *
 * Pure: no I/O, no file reads, no processes.
 *
 * @param {string} content
 * @returns {[string, string]} [open, close]
 */
function chooseFence(content) {
  const text = typeof content === 'string' ? content : '';

  const DEFAULT = '```';
  if (!text.includes(DEFAULT)) return [DEFAULT, DEFAULT];

  const ALT = '~~~';
  if (!text.includes(ALT)) return [ALT, ALT];

  const runs = text.match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  return [fence, fence];
}

module.exports = { chooseFence };
