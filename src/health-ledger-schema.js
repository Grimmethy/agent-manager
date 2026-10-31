'use strict';

// health-ledger-schema.js -- declarative schema, validator, and append-only writer for the daily
// health ledger used by tuning loops.
//
// Why (2026-10-27, auditability of loop outcomes): tuning loops produce per-day ledger rows
// recording trigger, verdict, items, metric delta, and cost. Without a schema, each loop writes
// its own ad-hoc shape and nothing downstream (the Python dashboard, the meta-kog plugin, or a
// future auditor) can reliably read or compare them. This module pins the row shape, validates
// incoming rows, and owns the append-only file contract.
//
// Location contract: rows live at `<pipelineDir>/health-ledger/YYYY-MM-DD.jsonl` where
// pipelineDir = AGENT_MANAGER_PIPELINE_DIR || repoRoot (src/config.js:114 convention). One JSON
// object per line, append-only, keyed by `loop_id` so multiple loops (and later the meta-kog
// plugin) share one file per day. Corrections are new rows, never rewrites.
//
// Reference: Docs/tuning-loops-design.md §2 (authoritative spec for the row shape and the
// file-location contract).

const fs = require('fs');
const path = require('path');

const DIR = 'health-ledger';

// ---------- Schema (declarative, no runtime behavior) ----------

const TRIGGER_KINDS = ['schedule', 'event'];

const HEALTH_LEDGER_ROW_SCHEMA = {
  name: 'health_ledger_row',
  required: [
    'ts',
    'loop_id',
    'trigger',
    'verdict',
    'items',
    'metric',
    'cost',
  ],
  fields: {
    ts: { type: 'string', iso8601: true, description: 'ISO 8601 UTC timestamp' },
    loop_id: { type: 'string', description: 'Loop identifier; key for append-only file' },
    trigger: {
      type: 'object',
      required: ['kind', 'detail'],
      fields: {
        kind: { type: 'string', enum: TRIGGER_KINDS },
        detail: { type: 'string' },
      },
    },
    verdict: {
      type: 'object',
      required: ['value', 'inputs'],
      fields: {
        value: { description: 'Binary verdict (yes/no/true/false/null) or scalar' },
        inputs: { type: 'object' },
      },
    },
    items: {
      type: 'object',
      required: ['released', 'held', 'filed'],
      fields: {
        released: {
          type: 'array',
          itemType: {
            type: 'object',
            required: ['item_id', 'cause'],
            fields: {
              item_id: { type: 'string' },
              cause: { type: 'string' },
            },
          },
        },
        held: {
          type: 'array',
          itemType: {
            type: 'object',
            required: ['item_id', 'cause'],
            fields: {
              item_id: { type: 'string' },
              cause: { type: 'string' },
            },
          },
        },
        filed: {
          type: 'array',
          itemType: {
            type: 'object',
            required: ['item_id', 'cause'],
            fields: {
              item_id: { type: 'string' },
              cause: { type: 'string' },
            },
          },
        },
      },
    },
    metric: {
      type: 'object',
      required: ['name', 'before', 'after'],
      fields: {
        name: { type: 'string' },
        before: { type: 'number', allowNull: true },
        after: { type: 'number', allowNull: true },
      },
    },
    cost: {
      type: 'object',
      required: ['gpu_minutes', 'peak_ram_mb', 'model_calls'],
      fields: {
        gpu_minutes: { type: 'number', allowNull: true },
        peak_ram_mb: { type: 'number', allowNull: true },
        model_calls: { type: 'number' },
      },
    },
    note: { type: 'string', optional: true, description: 'Optional free-form note' },
  },
};

// ---------- Validator (pure, no I/O) ----------

function validateRow(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push('row must be a non-null object');
    return { ok: false, errors };
  }

  for (const field of HEALTH_LEDGER_ROW_SCHEMA.required) {
    if (!(field in obj)) {
      errors.push(`missing required field: ${field}`);
    }
  }

  // ts: ISO 8601 UTC string
  if (obj.ts !== undefined) {
    if (typeof obj.ts !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(obj.ts)) {
      errors.push('ts must be an ISO 8601 UTC string');
    }
  }

  // loop_id: string
  if (obj.loop_id !== undefined) {
    if (typeof obj.loop_id !== 'string' || obj.loop_id.length === 0) {
      errors.push('loop_id must be a non-empty string');
    }
  }

  // trigger: {kind, detail}
  if (obj.trigger !== undefined) {
    if (typeof obj.trigger !== 'object' || obj.trigger === null || Array.isArray(obj.trigger)) {
      errors.push('trigger must be an object');
    } else {
      if (typeof obj.trigger.kind !== 'string' || !TRIGGER_KINDS.includes(obj.trigger.kind)) {
        errors.push(`trigger.kind must be one of: ${TRIGGER_KINDS.join(', ')}`);
      }
      if (typeof obj.trigger.detail !== 'string') {
        errors.push('trigger.detail must be a string');
      }
    }
  }

  // verdict: {value, inputs}
  if (obj.verdict !== undefined) {
    if (typeof obj.verdict !== 'object' || obj.verdict === null || Array.isArray(obj.verdict)) {
      errors.push('verdict must be an object');
    } else {
      if (!('value' in obj.verdict)) {
        errors.push('verdict must have a value field');
      }
      if (typeof obj.verdict.inputs !== 'object' || obj.verdict.inputs === null || Array.isArray(obj.verdict.inputs)) {
        errors.push('verdict.inputs must be an object');
      }
    }
  }

  // items: {released, held, filed} - each array of {item_id, cause}
  if (obj.items !== undefined) {
    if (typeof obj.items !== 'object' || obj.items === null || Array.isArray(obj.items)) {
      errors.push('items must be an object');
    } else {
      for (const bucket of ['released', 'held', 'filed']) {
        if (!Array.isArray(obj.items[bucket])) {
          errors.push(`items.${bucket} must be an array`);
        } else {
          for (let i = 0; i < obj.items[bucket].length; i++) {
            const entry = obj.items[bucket][i];
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
              errors.push(`items.${bucket}[${i}] must be an object`);
            } else {
              if (typeof entry.item_id !== 'string' || entry.item_id.length === 0) {
                errors.push(`items.${bucket}[${i}].item_id must be a non-empty string`);
              }
              if (typeof entry.cause !== 'string' || entry.cause.length === 0) {
                errors.push(`items.${bucket}[${i}].cause must be a non-empty string`);
              }
            }
          }
        }
      }
    }
  }

  // metric: {name, before, after}
  if (obj.metric !== undefined) {
    if (typeof obj.metric !== 'object' || obj.metric === null || Array.isArray(obj.metric)) {
      errors.push('metric must be an object');
    } else {
      if (typeof obj.metric.name !== 'string') {
        errors.push('metric.name must be a string');
      }
      if (obj.metric.before !== null && typeof obj.metric.before !== 'number') {
        errors.push('metric.before must be a number');
      }
      if (obj.metric.after !== null && typeof obj.metric.after !== 'number') {
        errors.push('metric.after must be a number');
      }
    }
  }

  // cost: {gpu_minutes, peak_ram_mb, model_calls}
  if (obj.cost !== undefined) {
    if (typeof obj.cost !== 'object' || obj.cost === null || Array.isArray(obj.cost)) {
      errors.push('cost must be an object');
    } else {
      if (obj.cost.gpu_minutes !== null && typeof obj.cost.gpu_minutes !== 'number') {
        errors.push('cost.gpu_minutes must be a number');
      }
      if (obj.cost.peak_ram_mb !== null && typeof obj.cost.peak_ram_mb !== 'number') {
        errors.push('cost.peak_ram_mb must be a number');
      }
      if (typeof obj.cost.model_calls !== 'number') {
        errors.push('cost.model_calls must be a number');
      }
    }
  }

  // note (optional): if present, must be string
  if (obj.note !== undefined && typeof obj.note !== 'string') {
    errors.push('note must be a string if provided');
  }

  return { ok: errors.length === 0, errors };
}

// ---------- Append (writes one line, no rewrite of existing lines) ----------

function rowPath(pipelineDir, date) {
  return path.join(pipelineDir, DIR, `${date}.jsonl`);
}

function appendRow(pipelineDir, date, row) {
  if (!pipelineDir || typeof pipelineDir !== 'string') {
    throw new Error('appendRow: pipelineDir is required');
  }
  if (!date || typeof date !== 'string') {
    throw new Error('appendRow: date (YYYY-MM-DD) is required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`appendRow: date must be YYYY-MM-DD, got "${date}"`);
  }

  const validation = validateRow(row);
  if (!validation.ok) {
    throw new Error(`appendRow: invalid row: ${validation.errors.join('; ')}`);
  }

  const dir = path.join(pipelineDir, DIR);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(row) + '\n';
  fs.appendFileSync(rowPath(pipelineDir, date), line, 'utf8');
  return rowPath(pipelineDir, date);
}

// ---------- Reader (append-only safe, reads dated files) ----------

function readRows(pipelineDir, { fromDate, toDate, loopId } = {}) {
  if (!pipelineDir || typeof pipelineDir !== 'string') {
    throw new Error('readRows: pipelineDir is required');
  }

  const ledgerDir = path.join(pipelineDir, DIR);
  let files;
  try {
    files = fs.readdirSync(ledgerDir);
  } catch {
    return [];
  }

  const rows = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const fileDate = file.slice(0, -6); // strip .jsonl (6 chars)
    if (fromDate && fileDate < fromDate) continue;
    if (toDate && fileDate > toDate) continue;

    let text;
    try {
      text = fs.readFileSync(path.join(ledgerDir, file), 'utf8');
    } catch {
      continue;
    }

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') {
          if (loopId && row.loop_id !== loopId) continue;
          rows.push(row);
        }
      } catch {
        // skip corrupt lines, append-only contract means we never rewrite
      }
    }
  }

  return rows;
}

module.exports = {
  HEALTH_LEDGER_ROW_SCHEMA,
  TRIGGER_KINDS,
  validateRow,
  appendRow,
  readRows,
  rowPath,
  DIR,
};
