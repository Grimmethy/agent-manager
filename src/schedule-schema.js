'use strict';

// schedule-schema.js -- HUB0391 1/6: constants and a pure validator for one entry of schedule.json.
// No I/O, no timers, no side effects.
//
// Entry shape:
//   id           string (required, non-empty)
//   cadence      object (required). kind is 'at' | 'every' | 'rule'
//                  at    -> time (non-empty string), weekday (optional non-empty string)
//                  every -> intervalSeconds (positive finite number)
//                  rule  -> name (non-empty string)
//   job          object (required). kind is 'queue-task' | 'run-command'
//                  queue-task  -> pipeline and/or task (at least one, non-empty string)
//                  run-command -> command (non-empty string), args (optional array of strings)
//   node         optional non-empty string. The validator does not fill it in; consumers
//                apply SCHEDULE_DEFAULT_NODE when it is absent.
//   replaceWith  required non-empty string (may be 'none yet')
//   migratedFrom optional non-empty string
//
// Unknown keys are rejected at the entry, cadence, and job levels.
//
// Style mirrors src/health-ledger-schema.js (validateRow): early return on a non-object,
// required-field loop, optional-field checks guarded by !== undefined, and
// { ok: errors.length === 0, errors } as the return shape.

const SCHEDULE_CADENCE_KINDS = ['at', 'every', 'rule'];
const SCHEDULE_JOB_KINDS = ['queue-task', 'run-command'];
const SCHEDULE_DEFAULT_NODE = 'wok';

const ENTRY_KEYS = ['id', 'cadence', 'job', 'node', 'replaceWith', 'migratedFrom'];
const ENTRY_REQUIRED = ['id', 'cadence', 'job', 'replaceWith'];
const CADENCE_KEYS = {
  at: ['kind', 'time', 'weekday'],
  every: ['kind', 'intervalSeconds'],
  rule: ['kind', 'name'],
};
const JOB_KEYS = {
  'queue-task': ['kind', 'pipeline', 'task'],
  'run-command': ['kind', 'command', 'args'],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function checkUnknownKeys(obj, allowed, label, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push(`${label} has unknown key '${key}'`);
    }
  }
}

function validateCadence(cadence, errors) {
  if (!isPlainObject(cadence)) {
    errors.push('cadence must be an object');
    return;
  }
  if (!SCHEDULE_CADENCE_KINDS.includes(cadence.kind)) {
    errors.push(`cadence.kind must be one of: ${SCHEDULE_CADENCE_KINDS.join(', ')}`);
    return;
  }
  checkUnknownKeys(cadence, CADENCE_KEYS[cadence.kind], 'cadence', errors);

  if (cadence.kind === 'at') {
    if (!isNonEmptyString(cadence.time)) {
      errors.push('cadence.time must be a non-empty string for kind at');
    }
    if (cadence.weekday !== undefined && !isNonEmptyString(cadence.weekday)) {
      errors.push('cadence.weekday must be a non-empty string if provided');
    }
  } else if (cadence.kind === 'every') {
    if (typeof cadence.intervalSeconds !== 'number' || !Number.isFinite(cadence.intervalSeconds) || cadence.intervalSeconds <= 0) {
      errors.push('cadence.intervalSeconds must be a positive number for kind every');
    }
  } else if (cadence.kind === 'rule') {
    if (!isNonEmptyString(cadence.name)) {
      errors.push('cadence.name must be a non-empty string for kind rule');
    }
  }
}

function validateJob(job, errors) {
  if (!isPlainObject(job)) {
    errors.push('job must be an object');
    return;
  }
  if (!SCHEDULE_JOB_KINDS.includes(job.kind)) {
    errors.push(`job.kind must be one of: ${SCHEDULE_JOB_KINDS.join(', ')}`);
    return;
  }
  checkUnknownKeys(job, JOB_KEYS[job.kind], 'job', errors);

  if (job.kind === 'queue-task') {
    if (job.pipeline === undefined && job.task === undefined) {
      errors.push('job.pipeline or job.task is required for kind queue-task');
    }
    if (job.pipeline !== undefined && !isNonEmptyString(job.pipeline)) {
      errors.push('job.pipeline must be a non-empty string if provided');
    }
    if (job.task !== undefined && !isNonEmptyString(job.task)) {
      errors.push('job.task must be a non-empty string if provided');
    }
  } else if (job.kind === 'run-command') {
    if (!isNonEmptyString(job.command)) {
      errors.push('job.command must be a non-empty string for kind run-command');
    }
    if (job.args !== undefined) {
      if (!Array.isArray(job.args) || !job.args.every((a) => typeof a === 'string')) {
        errors.push('job.args must be an array of strings if provided');
      }
    }
  }
}

function validateEntry(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    errors.push('entry must be a non-null object');
    return { ok: false, errors };
  }
  checkUnknownKeys(obj, ENTRY_KEYS, 'entry', errors);

  for (const field of ENTRY_REQUIRED) {
    if (obj[field] === undefined) {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (obj.id !== undefined && !isNonEmptyString(obj.id)) {
    errors.push('id must be a non-empty string');
  }
  if (obj.cadence !== undefined) {
    validateCadence(obj.cadence, errors);
  }
  if (obj.job !== undefined) {
    validateJob(obj.job, errors);
  }
  if (obj.node !== undefined && !isNonEmptyString(obj.node)) {
    errors.push('node must be a non-empty string if provided');
  }
  if (obj.replaceWith !== undefined && !isNonEmptyString(obj.replaceWith)) {
    errors.push('replaceWith must be a non-empty string');
  }
  if (obj.migratedFrom !== undefined && !isNonEmptyString(obj.migratedFrom)) {
    errors.push('migratedFrom must be a non-empty string if provided');
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEDULE_CADENCE_KINDS,
  SCHEDULE_JOB_KINDS,
  SCHEDULE_DEFAULT_NODE,
  validateEntry,
};
