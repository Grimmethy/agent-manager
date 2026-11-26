'use strict';

// Schema validation for schedule entries.
//
// Entry shape:
//   {
//     id: string (required, unique per schedule),
//     cadence: { at|every|rule } (exactly one required),
//     job: { queue-task|run-command } (exactly one required),
//     node?: string (defaults to "wok"),
//     replaceWith?: string,
//     migratedFrom?: string (non-empty if present)
//   }
//
// Cadence kinds:
//   - at: { time: "HH:MM", weekday?: string|number }
//   - every: { interval: ISO 8601 duration string }
//   - rule: { name: string }
//
// Job kinds:
//   - queue-task: { pipeline: string, priority?: "normal"|"premium" }
//   - run-command: { command: string, args?: string[], env?: { [k]: string } }

const TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const WEEKDAY_STRINGS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const VALID_PRIORITIES = ['normal', 'premium'];
// ISO 8601 duration: accepts P1D, T1H30M, H2, M30, S15, etc.
const ISO_DURATION_RE = /^P?(\d+[DMW]|H\d+|M\d+|S\d+|T\d+[HMS])+$/;
const RULE_NAME_RE = /^[a-z][a-z0-9_-]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateAtCadence(cadence, index) {
  const errors = [];
  const prefix = `entry[${index}].cadence.at`;

  if (typeof cadence.time !== 'string' || !TIME_RE.test(cadence.time)) {
    errors.push(
      `${prefix}.time: "${cadence.time}" is not a valid HH:MM time`
    );
  }

  if (cadence.weekday !== undefined) {
    if (typeof cadence.weekday === 'number') {
      if (cadence.weekday < 1 || cadence.weekday > 7) {
        errors.push(
          `${prefix}.weekday: number ${cadence.weekday} is not in range 1-7`
        );
      }
    } else if (typeof cadence.weekday === 'string') {
      if (!WEEKDAY_STRINGS.includes(cadence.weekday.toLowerCase())) {
        errors.push(
          `${prefix}.weekday: "${cadence.weekday}" is not a valid weekday`
        );
      }
    } else {
      errors.push(
        `${prefix}.weekday: must be a string or number 1-7`
      );
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateEveryCadence(cadence, index) {
  const errors = [];
  const prefix = `entry[${index}].cadence.every`;

  if (typeof cadence.interval !== 'string' || !ISO_DURATION_RE.test(cadence.interval)) {
    errors.push(
      `${prefix}.interval: "${cadence.interval}" is not a valid ISO 8601 duration`
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateRuleCadence(cadence, index) {
  const errors = [];
  const prefix = `entry[${index}].cadence.rule`;

  if (typeof cadence.name !== 'string' || !RULE_NAME_RE.test(cadence.name)) {
    errors.push(
      `${prefix}.name: "${cadence.name}" is not a valid rule name`
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateCadence(cadence, index) {
  const errors = [];
  const prefix = `entry[${index}].cadence`;

  if (!isPlainObject(cadence)) {
    return { ok: false, errors: [`${prefix}: must be an object`] };
  }

  const kinds = ['at', 'every', 'rule'].filter((k) => k in cadence);

  if (kinds.length === 0) {
    return { ok: false, errors: [`${prefix}: must have exactly one kind (at, every, or rule)`] };
  }
  if (kinds.length > 1) {
    return { ok: false, errors: [`${prefix}: must have exactly one kind (at, every, or rule), got ${kinds.join(', ')}`] };
  }

  const kind = kinds[0];
  const result =
    kind === 'at'
      ? validateAtCadence(cadence.at, index)
      : kind === 'every'
      ? validateEveryCadence(cadence.every, index)
      : validateRuleCadence(cadence.rule, index);

  if (!result.ok) {
    errors.push(...result.errors);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateQueueTaskJob(job, index) {
  const errors = [];
  const prefix = `entry[${index}].job.queue-task`;

  if (typeof job.pipeline !== 'string' || job.pipeline.length === 0) {
    errors.push(`${prefix}.pipeline: must be a non-empty string`);
  }

  if (job.priority !== undefined) {
    if (typeof job.priority !== 'string' || !VALID_PRIORITIES.includes(job.priority)) {
      errors.push(
        `${prefix}.priority: "${job.priority}" is not a valid priority (must be "normal" or "premium")`
      );
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateRunCommandJob(job, index) {
  const errors = [];
  const prefix = `entry[${index}].job.run-command`;

  if (typeof job.command !== 'string' || job.command.length === 0) {
    errors.push(`${prefix}.command: must be a non-empty string`);
  }

  if (job.args !== undefined) {
    if (!Array.isArray(job.args) || !job.args.every((a) => typeof a === 'string')) {
      errors.push(`${prefix}.args: must be an array of strings`);
    }
  }

  if (job.env !== undefined) {
    if (!isPlainObject(job.env) || !Object.values(job.env).every((v) => typeof v === 'string')) {
      errors.push(`${prefix}.env: must be an object with string values`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateJob(job, index) {
  const errors = [];
  const prefix = `entry[${index}].job`;

  if (!isPlainObject(job)) {
    return { ok: false, errors: [`${prefix}: must be an object`] };
  }

  const kinds = ['queue-task', 'run-command'].filter((k) => k in job);

  if (kinds.length === 0) {
    return { ok: false, errors: [`${prefix}: must have exactly one kind (queue-task or run-command)`] };
  }
  if (kinds.length > 1) {
    return { ok: false, errors: [`${prefix}: must have exactly one kind (queue-task or run-command), got ${kinds.join(', ')}`] };
  }

  const kind = kinds[0];
  const result =
    kind === 'queue-task'
      ? validateQueueTaskJob(job.queueTask || job['queue-task'], index)
      : validateRunCommandJob(job.runCommand || job['run-command'], index);

  if (!result.ok) {
    errors.push(...result.errors);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateEntry(entry, index) {
  if (!isPlainObject(entry)) {
    return { ok: false, errors: [`entry[${index}]: must be an object`] };
  }

  const errors = [];
  const ALLOWED_KEYS = ['id', 'cadence', 'job', 'node', 'replaceWith', 'migratedFrom'];

  // Required keys
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    errors.push(`entry[${index}]: "id" must be a non-empty string`);
  }
  if (!('cadence' in entry)) {
    errors.push(`entry[${index}]: missing required key "cadence"`);
  }
  if (!('job' in entry)) {
    errors.push(`entry[${index}]: missing required key "job"`);
  }

  // Unknown keys
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_KEYS.includes(key)) {
      errors.push(`entry[${index}]: unknown key "${key}"`);
    }
  }

  // Validate cadence
  if ('cadence' in entry) {
    const result = validateCadence(entry.cadence, index);
    if (!result.ok) {
      errors.push(...result.errors);
    }
  }

  // Validate job
  if ('job' in entry) {
    const result = validateJob(entry.job, index);
    if (!result.ok) {
      errors.push(...result.errors);
    }
  }

  // Validate node
  if (entry.node !== undefined) {
    if (typeof entry.node !== 'string') {
      errors.push(`entry[${index}].node: must be a string`);
    } else if (entry.node === '') {
      errors.push(`entry[${index}].node: must not be empty`);
    } else if (entry.node !== 'wok') {
      errors.push(`entry[${index}].node: "${entry.node}" is not an allowed node (only "wok" is allowed)`);
    }
  }

  // Validate replaceWith
  if (entry.replaceWith !== undefined) {
    if (typeof entry.replaceWith !== 'string') {
      errors.push(`entry[${index}].replaceWith: must be a string`);
    }
  }

  // Validate migratedFrom
  if (entry.migratedFrom !== undefined) {
    if (typeof entry.migratedFrom !== 'string') {
      errors.push(`entry[${index}].migratedFrom: must be a string`);
    } else if (entry.migratedFrom === '') {
      errors.push(`entry[${index}].migratedFrom: must not be empty`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

module.exports = { validateEntry, validateCadence, validateJob };
