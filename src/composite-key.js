'use strict';

// Composite-key helpers. A composite key joins string parts with the NUL
// character, which cannot appear inside a part (compose() rejects it).

const SEPARATOR = '\u0000';

// --- compose(...parts) ---
//
// @param {...string} parts - one or more string parts, none containing \u0000
// @returns {string} the parts joined with \u0000
// @throws {TypeError} if no parts are given, a part is not a string, or a part contains \u0000
function compose(...parts) {
  if (parts.length === 0) {
    throw new TypeError('compose() requires at least one part');
  }
  for (const part of parts) {
    if (typeof part !== 'string') {
      throw new TypeError('compose() parts must be strings');
    }
    if (part.includes(SEPARATOR)) {
      throw new TypeError('compose() parts must not contain \\u0000');
    }
  }
  return parts.join(SEPARATOR);
}

// --- fragment(key) ---
//
// @param {string} key - a key produced by compose()
// @returns {string[]} the parts of the key
function fragment(key) {
  return key.split(SEPARATOR);
}

module.exports = { compose, fragment };
