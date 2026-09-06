#!/usr/bin/env node
// Queue ad-hoc tasks: lets a human or an orchestrating agent inject one-off work that
// preempts every deterministic source in task-sources.js (see nextAdhocTask() there).

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

function slugify(str) {
  return str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}

// Extracted (2026-09-06) so callers other than this CLI -- e.g. Chat's
// queue_reviewed_task tool in local-tool-client.js, handing off a risky git action
// instead of executing it directly -- can queue a real adhoc task without shelling out
// to this script. Throws on an invalid domain rather than the CLI's own
// print-and-exit(1), since a library call has no business calling process.exit.
function queueAdhocTask({ title, promptContext, domain, dependsOn }, { pipelineDir, domainsPath }) {
  if (!title) throw new Error('queueAdhocTask: title is required');
  if (!promptContext) throw new Error('queueAdhocTask: promptContext is required');

  const validDomains = Object.keys(JSON.parse(fs.readFileSync(domainsPath, 'utf8')));
  const resolvedDomain = domain || validDomains[0];
  if (!validDomains.includes(resolvedDomain)) {
    throw new Error(`Invalid domain '${resolvedDomain}'. Valid domains: ${validDomains.join(', ')}`);
  }

  const id = `adhoc-${slugify(title)}-${Date.now()}`;
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  fs.mkdirSync(adhocDir, { recursive: true });

  const cleanDependsOn = Array.isArray(dependsOn) ? dependsOn.filter(Boolean) : undefined;
  const record = {
    id, domain: resolvedDomain, source: 'manual', title, promptContext,
    ...(cleanDependsOn && cleanDependsOn.length ? { dependsOn: cleanDependsOn } : {}),
  };
  const filePath = path.join(adhocDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n');
  return { record, filePath };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--title' || argv[i] === '--prompt-context-file' || argv[i] === '--domain' || argv[i] === '--depends-on') && argv[i + 1]) {
      args[argv[i]] = argv[++i];
    }
  }
  return args;
}

if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  const parsed = parseArgs(rawArgs);

  if (!parsed['--title'] || !parsed['--prompt-context-file']) {
    console.error('Usage: node queue-adhoc-task.js --title <text> --prompt-context-file <path> [--domain <name>] [--depends-on id1,id2]');
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
  // dependsOn (2026-08-22): other adhoc task ids this one must not be drafted before --
  // see task-sources.js's nextAdhocTask()/isDependencySatisfied() for the enforcement
  // (satisfied only once a dependency is actually MERGED, not just done, since a fresh
  // draft's git worktree starts from origin/<mainBranch> and won't see an unmerged fix).
  const dependsOn = parsed['--depends-on']
    ? parsed['--depends-on'].split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  try {
    const { filePath } = queueAdhocTask(
      { title: parsed['--title'], promptContext, domain: parsed['--domain'], dependsOn },
      { pipelineDir, domainsPath },
    );
    console.log(`queued adhoc task: ${filePath}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { queueAdhocTask, slugify };
