#!/usr/bin/env node
'use strict';

// Child process of `node src/capability-ledger.js --with-variants` (roadmap step 1, piece P5): reads scorecard rows as JSON on stdin, loads the task source
// registry (task-sources.js, heavy: needs AGENT_MANAGER_REPO_ROOT) and prints the rows with `variantOf` added. It lives apart from capability-ledger.js
// because task-sources.js requires capability-ledger.js (through lanes.js), so the ledger must not import it. Exit 1 with the reason on stderr when the
// registry cannot load; the ledger then leaves the rows unannotated.

const fs = require('fs');

function main() {
  const rows = JSON.parse(fs.readFileSync(0, 'utf8'));
  require('./task-sources.js');
  const { variantParentOf, getRegisteredSources } = require('./task-source-registry.js');
  if (getRegisteredSources().length === 0) throw new Error('the source registry is empty after loading task-sources.js');
  const { annotateVariants } = require('./capability-ledger.js');
  process.stdout.write(JSON.stringify(annotateVariants(rows, variantParentOf)));
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
