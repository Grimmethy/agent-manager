#!/usr/bin/env node
// Queue ad-hoc tasks: lets a human or an orchestrating agent inject one-off work that
// preempts every deterministic source in task-sources.js (see nextAdhocTask() there).

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

function slugify(str) {
  return str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--title' || argv[i] === '--prompt-context-file' || argv[i] === '--domain') && argv[i + 1]) {
      args[argv[i]] = argv[++i];
    }
  }
  return args;
}

if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  const parsed = parseArgs(rawArgs);

  if (!parsed['--title'] || !parsed['--prompt-context-file']) {
    console.error('Usage: node queue-adhoc-task.js --title <text> --prompt-context-file <path> [--domain <name>]');
    process.exit(1);
  }

  let promptContext;
  try {
    const raw = fs.readFileSync(parsed['--prompt-context-file'], 'utf8');
    promptContext = JSON.parse(raw);
  } catch {
    console.error(`Invalid prompt context file: ${parsed['--prompt-context-file']}`);
    process.exit(1);
  }

  const { pipelineDir, domainsPath } = getConfig();
  // task-domains.json is the single source of truth for valid domains -- the consumer
  // supplies it (see README.md's "Domains" section).
  const validDomains = Object.keys(JSON.parse(fs.readFileSync(domainsPath, 'utf8')));
  const domain = parsed['--domain'] || validDomains[0];
  if (!validDomains.includes(domain)) {
    console.error(`Invalid --domain '${domain}'. Valid domains: ${validDomains.join(', ')}`);
    process.exit(1);
  }

  const id = `adhoc-${slugify(parsed['--title'])}-${Date.now()}`;
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  fs.mkdirSync(adhocDir, { recursive: true });

  const record = { id, domain, source: 'manual', title: parsed['--title'], promptContext };
  const filePath = path.join(adhocDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n');

  console.log(`queued adhoc task: ${filePath}`);
}
