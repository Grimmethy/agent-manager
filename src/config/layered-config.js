'use strict';
// Layered config loader. Each source is { path, required, layer }. Sources are
// read in array order and later entries win. Files are assumed to be UTF-8 JSON
// objects. The merge is shallow because the task does not specify deep merge.
// validate(parsed, source) signals failure by throwing or by returning false.
const fs = require('fs');

const LAYERS = ['global', 'override', 'project', 'opencode'];

// A malformed descriptor is a programmer error, not a source failure, so it throws
// regardless of the source's required flag.
function checkDescriptor(source, index) {
  if (!source || typeof source !== 'object') {
    throw new Error(`layered config: source #${index} is not an object`);
  }
  const label = typeof source.path === 'string' ? source.path : `#${index}`;
  if (typeof source.path !== 'string') {
    throw new Error(`layered config: source ${label} has no string path`);
  }
  if (typeof source.required !== 'boolean') {
    throw new Error(`layered config: source ${label} has non-boolean required`);
  }
  if (!LAYERS.includes(source.layer)) {
    throw new Error(`layered config: source ${label} has unknown layer ${JSON.stringify(source.layer)}`);
  }
}

// Returns { ok: true, value } or { ok: false, reason }.
function readSource(source, validate) {
  let text;
  try {
    text = fs.readFileSync(source.path, 'utf8');
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'file not found' : `unreadable: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `malformed JSON: ${err.message}` };
  }
  if (typeof validate === 'function') {
    try {
      if (validate(parsed, source) === false) {
        return { ok: false, reason: 'failed schema validation' };
      }
    } catch (err) {
      return { ok: false, reason: `failed schema validation: ${err.message}` };
    }
  }
  return { ok: true, value: parsed };
}

function loadLayeredConfig(sources, { validate, logger = console } = {}) {
  if (!Array.isArray(sources)) {
    throw new Error('layered config: sources must be an array');
  }
  const merged = {};
  sources.forEach((source, index) => {
    checkDescriptor(source, index);
    const result = readSource(source, validate);
    if (result.ok) {
      Object.assign(merged, result.value);
      return;
    }
    if (source.required) {
      throw new Error(`layered config: required source ${source.path} (${source.layer}) failed: ${result.reason}`);
    }
    logger.warn(`layered config: optional source ${source.path} skipped: ${result.reason}`);
  });
  return merged;
}

module.exports = { loadLayeredConfig, LAYERS };
