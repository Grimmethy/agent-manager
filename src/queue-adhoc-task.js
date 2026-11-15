#!/usr/bin/env node
// Queue ad-hoc tasks: lets a human or an orchestrating agent inject one-off work that
// preempts every deterministic source in task-sources.js (see nextAdhocTask() there).

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

function slugify(str) {
  return str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}

// Port of app.py's default_task_domain() (2026-09-06): picking the first key in
// task-domains.json with no regard for whether it's a sane generic default is what once
// queued two real tasks with domain='adhoc' into a project whose task-domains.json
// didn't even list 'adhoc', permanently blocking them with "Unknown task domain: adhoc".
// Tries 'default' then 'adhoc' first, only falling back to the first key if a project
// defines neither.
function defaultTaskDomain(validDomains) {
  for (const candidate of ['default', 'adhoc']) {
    if (validDomains.includes(candidate)) return candidate;
  }
  return validDomains[0];
}

// Extracted (2026-09-06) so callers other than this CLI -- e.g. Chat's
// queue_reviewed_task tool in local-tool-client.js, handing off a risky git action
// instead of executing it directly -- can queue a real adhoc task without shelling out
// to this script. Throws on an invalid domain rather than the CLI's own
// print-and-exit(1), since a library call has no business calling process.exit.
// stacked (2026-11-04, Needs-Work repair loop piece 2): the target of a REPAIR task -- an existing agent/* branch the task's commit rides on.
// apply's prepareApplyBranch (apply-branch-prep-route.js) reads exactly these three keys: a stacked record with seq > 1 goes through
// prepareStackedBranch(branch) and adds a commit ON the branch; seq 1 would delete and recreate the branch off main, the opposite of a repair,
// so it is refused here. A repair never targets main or a non-agent branch.
function normalizeStacked(stacked) {
  if (!stacked || typeof stacked !== 'object' || Array.isArray(stacked)) {
    throw new Error('queueAdhocTask: stacked must be an object {branch, seq, total}');
  }
  const extra = Object.keys(stacked).filter((k) => !['branch', 'seq', 'total'].includes(k));
  if (extra.length) throw new Error(`queueAdhocTask: stacked has unknown key(s): ${extra.join(', ')}`);
  const { branch, seq, total } = stacked;
  if (typeof branch !== 'string' || !branch.startsWith('agent/') || branch === 'agent/' || /\s/.test(branch) || branch.includes('..')) {
    throw new Error(`queueAdhocTask: stacked.branch must be an existing agent/* branch name without whitespace or '..' (got ${JSON.stringify(branch)})`);
  }
  if (!Number.isInteger(seq) || seq < 2) {
    throw new Error(`queueAdhocTask: stacked.seq must be an integer >= 2 (seq 1 would recreate the branch off main) (got ${JSON.stringify(seq)})`);
  }
  if (!Number.isInteger(total) || total < seq) {
    throw new Error(`queueAdhocTask: stacked.total must be an integer >= stacked.seq (got ${JSON.stringify(total)})`);
  }
  return { branch, seq, total };
}

function queueAdhocTask({ title, promptContext, domain, dependsOn, premiumPriority, premiumSetBy, project, generatedForRepoRoot, stacked }, { pipelineDir, domainsPath }) {
  if (!title) throw new Error('queueAdhocTask: title is required');
  if (!promptContext) throw new Error('queueAdhocTask: promptContext is required');
  const cleanStacked = stacked === undefined || stacked === null ? undefined : normalizeStacked(stacked);

  const validDomains = Object.keys(JSON.parse(fs.readFileSync(domainsPath, 'utf8')));
  const resolvedDomain = domain || defaultTaskDomain(validDomains);
  if (!validDomains.includes(resolvedDomain)) {
    throw new Error(`Invalid domain '${resolvedDomain}'. Valid domains: ${validDomains.join(', ')}`);
  }

  const id = `adhoc-${slugify(title)}-${Date.now()}`;
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  fs.mkdirSync(adhocDir, { recursive: true });

  const cleanDependsOn = Array.isArray(dependsOn) ? dependsOn.filter(Boolean) : undefined;
  const record = {
    id, domain: resolvedDomain, source: 'manual', title, promptContext,
    // humanQueued (2026-09-07, Grimmethy: "tasks that come from bot findings get sorted
    // into a lower priority than human entered adhoc tasks") -- this CLI (and its
    // library form, queueAdhocTask() as called by e.g. Chat's queue_reviewed_task tool)
    // is one of exactly two genuinely human-directed adhoc entry points (the other is
    // app.py's api_brain_dump_prioritize, "Process this now"); see
    // next-claimable-task.js's effectivePriority() for why this can't be derived from
    // `source` alone (task-sources.js's own loader force-overrides source:'manual' on
    // every queue/adhoc/ file it reads, human- or bot-written).
    humanQueued: true,
    // premiumPriority (2026-09-16, Grimmethy: "any tasks that chat is working on
    // directly should be labelled premium priority") -- opt-in, not a blanket default
    // for every queueAdhocTask() caller (the plain CLI has no reason to assume this):
    // Chat's own queue_reviewed_task tool passes it explicitly. Same field
    // /api/task-anywhere/<id>/premium-priority sets by hand -- see that route's own
    // header for what it actually does (next-claimable-task.js's effectivePriority()
    // sorts it ahead of every other pending item, survives every retry/requeue cycle).
    // This was previously a manual step an operator had to remember to do after every
    // Chat-queued task; automating it here closes that gap.
    ...(premiumPriority ? { premiumPriority: true } : {}),
    // Provenance of the premium flag (premiumSetBy: operator-ui | operator-bulk | chat-queue | cli | source; premiumSetAt: ISO),
    // shown in the task modal next to the Premium Priority button. Chat's queue_reviewed_task passes 'chat-queue'; any other
    // caller that asks for premium without a label is recorded as 'cli'. Display only: claim order reads premiumPriority alone.
    ...(premiumPriority ? { premiumSetBy: premiumSetBy || 'cli', premiumSetAt: new Date().toISOString() } : {}),
    ...(cleanDependsOn && cleanDependsOn.length ? { dependsOn: cleanDependsOn } : {}),
    // The registered project this task was filed for (Chat's queue_reviewed_task passes it); informational.
    ...(project ? { project } : {}),
    // generatedForRepoRoot (2026-10-23, owner: "what could we upgrade permanently") --
    // stamped by the --scratch hand-carry path so the task's later blocked/needs-clarification
    // transitions know which repo to sync into without a post-hoc fix.
    ...(generatedForRepoRoot ? { generatedForRepoRoot } : {}),
    // The branch a repair task rides on (see normalizeStacked); absent for every ordinary task.
    ...(cleanStacked ? { stacked: cleanStacked } : {}),
  };
  const filePath = path.join(adhocDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n');
  return { record, filePath };
}

const STACKED_FLAGS = ['--stacked-branch', '--stacked-seq', '--stacked-total'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    // The --stacked-* flags are recorded even with an empty or missing value, so stackedFromArgs/normalizeStacked refuse them (exit 1). The generic
    // rule below skips a flag whose next argument is falsy, which would silently turn `--stacked-branch ""` into an ORDINARY task off main.
    if (STACKED_FLAGS.includes(argv[i])) {
      args[argv[i]] = i + 1 < argv.length ? argv[++i] : '';
      continue;
    }
    if ((argv[i] === '--title' || argv[i] === '--prompt-context-file' || argv[i] === '--domain' || argv[i] === '--depends-on' || argv[i] === '--scratch' || argv[i] === '--repo-root') && argv[i + 1]) {
      args[argv[i]] = argv[++i];
    }
  }
  return args;
}

// CLI form of a stacked target: --stacked-branch <b> [--stacked-seq n] [--stacked-total n]; with only the branch, seq is 2 and total is seq.
// seq or total without a branch is an error (returns via throw, the callers print it and exit 1 like every other bad argument).
function stackedFromArgs(parsed) {
  const branch = parsed['--stacked-branch'];
  if (branch === undefined) {
    if (parsed['--stacked-seq'] !== undefined || parsed['--stacked-total'] !== undefined) {
      throw new Error('--stacked-seq and --stacked-total need --stacked-branch');
    }
    return undefined;
  }
  const seq = parsed['--stacked-seq'] === undefined ? 2 : Number(parsed['--stacked-seq']);
  const total = parsed['--stacked-total'] === undefined ? seq : Number(parsed['--stacked-total']);
  return { branch, seq, total };
}

if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  const parsed = parseArgs(rawArgs);

  if (!parsed['--title'] || !parsed['--prompt-context-file']) {
    console.error('Usage: node queue-adhoc-task.js --title <text> --prompt-context-file <path> [--domain <name>] [--depends-on id1,id2] [--scratch <dir>] [--repo-root <path>] [--stacked-branch <agent/branch> [--stacked-seq <n>] [--stacked-total <n>]]');
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

  let stackedTarget;
  try {
    stackedTarget = stackedFromArgs(parsed);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (parsed['--scratch']) {
    // --scratch: hand-carry a task into a scratch directory instead of the live pipeline.
    // Required companion: --repo-root (so the stamped generatedForRepoRoot knows where the
    // project actually lives). Without it we'd write a task with no repo context, which is
    // exactly the bug this flag exists to prevent.
    if (!parsed['--repo-root']) {
      console.error('Usage: node queue-adhoc-task.js --scratch <dir> --repo-root <path> --title <text> --prompt-context-file <path>');
      process.exit(1);
    }

    const { domainsPath: liveDomainsPath } = getConfig();
    const scratchDir = path.resolve(parsed['--scratch']);
    // scratchPipelineDir is the base pipeline dir; queueAdhocTask() appends /queue/adhoc itself.
    const scratchPipelineDir = scratchDir;
    const scratchDomainsPath = path.join(scratchDir, 'task-domains.json');

    // Copy task-domains.json into the scratch dir only when absent -- a subsequent scratch
    // run with the file already present must not clobber a possibly-customized copy.
    if (!fs.existsSync(scratchDomainsPath)) {
      fs.copyFileSync(liveDomainsPath, scratchDomainsPath);
    }

    // Point the pipeline at the scratch dir for the duration of this call. This ensures
    // any nested code that resolves paths via getConfig() (e.g. task-sources.js loaders)
    // sees the scratch layout, not the live one. The live queue is never touched.
    const oldPipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR;
    const oldDomainsPath = process.env.AGENT_MANAGER_DOMAINS_PATH;
    process.env.AGENT_MANAGER_PIPELINE_DIR = scratchPipelineDir;
    process.env.AGENT_MANAGER_DOMAINS_PATH = scratchDomainsPath;

    try {
      const { pipelineDir, domainsPath } = getConfig();
      const { filePath } = queueAdhocTask(
        { title: parsed['--title'], promptContext, domain: 'adhoc', generatedForRepoRoot: parsed['--repo-root'], stacked: stackedTarget, dependsOn: parsed['--depends-on']
            ? parsed['--depends-on'].split(',').map((s) => s.trim()).filter(Boolean)
            : undefined },
        { pipelineDir, domainsPath },
      );
      console.log(`queued adhoc task: ${filePath}`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    } finally {
      if (oldPipelineDir === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DIR;
      else process.env.AGENT_MANAGER_PIPELINE_DIR = oldPipelineDir;
      if (oldDomainsPath === undefined) delete process.env.AGENT_MANAGER_DOMAINS_PATH;
      else process.env.AGENT_MANAGER_DOMAINS_PATH = oldDomainsPath;
    }
  } else {
    // dependsOn (2026-08-22): other adhoc task ids this one must not be drafted before --
    // see task-sources.js's nextAdhocTask()/isDependencySatisfied() for the enforcement
    // (satisfied only once a dependency is actually MERGED, not just done, since a fresh
    // draft's git worktree starts from origin/<mainBranch> and won't see an unmerged fix).
    const { pipelineDir, domainsPath } = getConfig();
    const dependsOn = parsed['--depends-on']
      ? parsed['--depends-on'].split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    try {
      const { filePath } = queueAdhocTask(
        { title: parsed['--title'], promptContext, domain: parsed['--domain'], dependsOn, stacked: stackedTarget },
        { pipelineDir, domainsPath },
      );
      console.log(`queued adhoc task: ${filePath}`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
}

module.exports = { queueAdhocTask, slugify, defaultTaskDomain, normalizeStacked, stackedFromArgs };
