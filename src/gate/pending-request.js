// Adapted from anomalyco-opencode-176.
'use strict';

// Pending-request record factory and validator.
// A pending request is created in status 'pending' and later resolved to 'approved' or 'rejected'.
// Pure synchronous module: no timers, no polling, no calls into other modules.

const STATUSES = ['pending', 'approved', 'rejected'];
const RESOLVED_STATUSES = ['approved', 'rejected'];
const REQUIRED_STRING_FIELDS = ['id', 'action', 'proposer', 'riskTier'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidTimestamp(value) {
  return typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

// Returns { valid: true, errors: [] } or { valid: false, errors: [...] }.
function validatePendingRequest(record) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['record must be an object'] };
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(record[field])) errors.push(`${field} must be a non-empty string`);
  }

  if (!STATUSES.includes(record.status)) {
    errors.push(`status must be one of ${STATUSES.join(', ')}`);
  }

  if (!isValidTimestamp(record.createdAt)) {
    errors.push('createdAt must be a valid timestamp');
  }

  const resolved = RESOLVED_STATUSES.includes(record.status);

  if (record.status === 'pending') {
    if (record.resolvedAt !== null && record.resolvedAt !== undefined) {
      errors.push('resolvedAt must be null while status is pending');
    }
    if (record.verdict !== null && record.verdict !== undefined) {
      errors.push('verdict must be null while status is pending');
    }
  } else if (resolved) {
    if (!isValidTimestamp(record.resolvedAt)) {
      errors.push('resolvedAt must be a valid timestamp once resolved');
    }
    if (!isNonEmptyString(record.verdict)) {
      errors.push('verdict must be a non-empty string once resolved');
    }
    if (!isNonEmptyString(record.reason)) {
      errors.push('reason is required when replying (approved or rejected)');
    }
  }

  if (record.message !== undefined && record.message !== null && typeof record.message !== 'string') {
    errors.push('message must be a string when provided');
  }

  return { valid: errors.length === 0, errors };
}

// Builds a pending-request record. Throws if the resulting record is invalid.
function createPendingRequest(input = {}) {
  const record = {
    id: input.id,
    action: input.action,
    proposer: input.proposer,
    riskTier: input.riskTier,
    status: input.status === undefined ? 'pending' : input.status,
    createdAt: input.createdAt === undefined ? new Date().toISOString() : input.createdAt,
    resolvedAt: input.resolvedAt === undefined ? null : input.resolvedAt,
    verdict: input.verdict === undefined ? null : input.verdict,
    reason: input.reason === undefined ? null : input.reason,
  };
  if (input.message !== undefined) record.message = input.message;

  const result = validatePendingRequest(record);
  if (!result.valid) {
    throw new Error(`invalid pending request: ${result.errors.join('; ')}`);
  }
  return record;
}

module.exports = { createPendingRequest, validatePendingRequest, STATUSES };
