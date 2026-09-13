const fs = require('fs');
const path = require('path');
const { inboxDir } = require('./side-finding.js');
const { normalizeTokens } = require('./text-similarity.js');

function searchPreflight(pipelineDir) {
  // Step 1 – resolve inbox dir and list it
  const dir = inboxDir(pipelineDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_err) {
    return { ok: false, reason: 'inbox-unreachable' };
  }

  // Step 2 – filter .json, cap, parse, and test each record
  const batchCap = Number(process.env.AGENT_MANAGER_SIDE_FINDING_SWEEP_BATCH) || 50;
  const jsonNames = names.filter((n) => n.endsWith('.json')).slice(0, batchCap);

  for (const name of jsonNames) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (_err) {
      continue; // skip unparseable file
    }
    if (record && record.title && record.body) {
      const tokenSet = normalizeTokens(record.title + ' ' + record.body);
      if (tokenSet.size > 0) {
        return { ok: true, sample: { title: record.title, tokenCount: tokenSet.size } };
      }
    }
  }

  // Step 3 – nothing passed
  return { ok: false, reason: 'no-parseable-results' };
}

module.exports = { searchPreflight };
