'use strict';

const FORBIDDEN_OPTION_KEYS = ['num_ctx', 'numCtx', 'keep_alive', 'keepAlive'];
const STATUSES = ['prepared', 'running', 'done', 'failed'];

function validatePreparedRecord(record) {
  if (record === null || typeof record !== 'object') {
    throw new Error('validatePreparedRecord: record must be an object');
  }

  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error('validatePreparedRecord: id must be a non-empty string');
  }

  if (typeof record.prompt !== 'string' || record.prompt.length === 0) {
    throw new Error('validatePreparedRecord: prompt must be a non-empty string');
  }

  if (typeof record.model !== 'string' || record.model.length === 0) {
    throw new Error('validatePreparedRecord: model must be a non-empty string (no default)');
  }

  if (record.options === null || typeof record.options !== 'object' || Array.isArray(record.options)) {
    throw new Error('validatePreparedRecord: options must be a plain object');
  }

  for (const key of FORBIDDEN_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record.options, key)) {
      throw new Error(`validatePreparedRecord: options must not contain "${key}"`);
    }
  }

  if (!STATUSES.includes(record.status)) {
    throw new Error('validatePreparedRecord: status must be one of prepared, running, done, failed');
  }

  if (!Number.isInteger(record.attempts) || record.attempts < 0) {
    throw new Error('validatePreparedRecord: attempts must be a non-negative integer');
  }

  if (record.lastError !== null && typeof record.lastError !== 'string') {
    throw new Error('validatePreparedRecord: lastError must be null or a string');
  }

  if (typeof record.createdAt !== 'string') {
    throw new Error('validatePreparedRecord: createdAt must be a string');
  }

  const parsed = Date.parse(record.createdAt);
  if (Number.isNaN(parsed)) {
    throw new Error('validatePreparedRecord: createdAt must be a valid ISO 8601 timestamp');
  }

  return record;
}

function prepareRequest(input) {
  if (input === null || typeof input !== 'object') {
    throw new Error('prepareRequest: input must be an object');
  }

  if (typeof input.id !== 'string' || input.id.length === 0) {
    throw new Error('prepareRequest: input.id must be a non-empty string');
  }

  if (typeof input.prompt !== 'string' || input.prompt.length === 0) {
    throw new Error('prepareRequest: input.prompt must be a non-empty string');
  }

  if (typeof input.model !== 'string' || input.model.length === 0) {
    throw new Error('prepareRequest: input.model must be a non-empty string (no default)');
  }

  const options = input.options === undefined ? {} : input.options;

  const record = {
    id: input.id,
    prompt: input.prompt,
    model: input.model,
    options,
    status: 'prepared',
    attempts: 0,
    lastError: null,
    createdAt: input.createdAt !== undefined ? input.createdAt : new Date().toISOString()
  };

  return validatePreparedRecord(record);
}

function persistPrepared(record, writer) {
  if (typeof writer !== 'function') {
    throw new Error('persistPrepared: writer must be a function');
  }

  validatePreparedRecord(record);
  return writer(record);
}

function listByStatus(records, status) {
  if (!STATUSES.includes(status)) {
    throw new Error('listByStatus: status must be one of prepared, running, done, failed');
  }

  if (!Array.isArray(records)) {
    throw new Error('listByStatus: records must be an array');
  }

  return records.filter((r) => r.status === status);
}

module.exports = {
  FORBIDDEN_OPTION_KEYS,
  validatePreparedRecord,
  prepareRequest,
  persistPrepared,
  listByStatus
};
