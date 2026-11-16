'use strict';

// decision-ledger.js -- pure formatter for a plan-execution "Ruling": a decision an implementer
// made instead of stopping to ask. Format: `Ruling: <what> - <why> - <what it costs if wrong>`.
//
// No I/O here by design. Where a ruling is persisted (task history entry vs a dedicated field) is an
// open decision; wiring into any caller waits for it.

function clean(value, name) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new Error(`decision-ledger: ruling field "${name}" must be a non-empty string`);
  return s.replace(/\s*\n\s*/g, ' ');
}

// Returns the single-line Ruling string. Throws if any of what / why / cost is missing or blank.
function formatRuling({ what, why, cost } = {}) {
  return `Ruling: ${clean(what, 'what')} - ${clean(why, 'why')} - ${clean(cost, 'cost')}`;
}

module.exports = { formatRuling };
