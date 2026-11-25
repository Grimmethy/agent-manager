'use strict';

/**
 * Outcome error registry and factory.
 *
 * Payload shapes (documented only; no runtime validation):
 *   OutputTruncated    -> data: {}
 *   BackendUnreachable -> data: { backend: string, message: string }
 */

const OUTCOME_ERROR = Object.freeze({
  OutputTruncated: 'OutputTruncated',
  BackendUnreachable: 'BackendUnreachable',
});

/**
 * Create an outcome error.
 * @param {string} name - must be a value of OUTCOME_ERROR
 * @param {object} [data={}] - payload for the error, shape depends on name
 * @returns {Error} error with .name, .data and toJSON() returning { name, data }
 */
function outcomeError(name, data = {}) {
  if (!Object.values(OUTCOME_ERROR).includes(name)) {
    throw new Error(`Unknown outcome error name: ${String(name)}`);
  }
  const err = new Error(name);
  err.name = name;
  err.data = data;
  err.toJSON = function () {
    return { name: this.name, data: this.data };
  };
  return err;
}

module.exports = { OUTCOME_ERROR, outcomeError };
