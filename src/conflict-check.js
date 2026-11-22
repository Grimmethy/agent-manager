'use strict';

// conflict-check.js -- deterministic pre-draft conflict check
//
// Why (2026-11-04, this task): 13 branches all failed with "it conflicts with # other open
// branch(#)" because the conflict check only ran during review (python/dashboard/branch_verdicts.py
// _check_conflicts), after work was already done on multiple branches. The fix is to run the same
// check BEFORE branch creation, so overlapping work is caught at draft time.
//
// Logic mirrors _check_conflicts in branch_verdicts.py:
//   1. Get proposed files from task.promptContext (proposeFiles or files array)
//   2. Get all open branches from queue/pending (excluding triage-queue)
//   3. For each open branch, get touched files via git diff --name-only origin/main...agent/<branch>
//   4. Check for overlap between proposed files and each open branch's files
//   5. Return conflict details if overlap found
//
// Returns:
//   { hasConflict: false }  -- no conflict
//   { hasConflict: true, conflicts: [{ branch, files }] }  -- conflict details
//
// CLI: node conflict-check.js <pipelineDir> <taskId>
// Reads the task from <pipelineDir>/queue/pending/<taskId>.json
// Exits 0 with JSON to stdout, exits 1 if task not found

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 30_000;

function runGit(args, cwd) {
  try {
    return { code: 0, out: execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS }) };
  } catch (e) {
    return { code: e.status || 2, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

function getProposedFiles(task) {
  // Try promptContext.proposeFiles first (singular, from some sources)
  if (Array.isArray(task.promptContext?.proposeFiles)) {
    return task.promptContext.proposeFiles;
  }
  // Try promptContext.files (plural, from other sources)
  if (Array.isArray(task.promptContext?.files)) {
    return task.promptContext.files;
  }
  // Fallback: extract from task description (look for "Files:" lines)
  const description = task.description || task.planResponse || '';
  if (!description) return [];
  const files = [];
  const lines = description.split('\n');
  let inFilesBlock = false;
  for (const line of lines) {
    if (/^files:\s*$/i.test(line)) {
      inFilesBlock = true;
      continue;
    }
    if (inFilesBlock) {
      if (line.startsWith('- ') || line.startsWith('* ')) {
        files.push(line.slice(2).trim());
      } else if (line.trim() === '') {
        inFilesBlock = false;
      }
    }
  }
  return files;
}

function getOpenBranches(pipelineDir) {
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  if (!fs.existsSync(pendingDir)) return [];
  
  const branches = [];
  const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  
  for (const file of files) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(pendingDir, file), 'utf8'));
      // Skip triage-queue branch
      if (task.id?.startsWith('adhoc/triage-queue')) continue;
      // Extract branch name from task.id (format: agent/<id>)
      const match = task.id?.match(/^agent\/(.+)$/);
      if (match) {
        branches.push({ id: task.id, branch: match[1], name: `agent/${match[1]}` });
      }
    } catch (e) {
      // Skip unreadable files
    }
  }
  
  return branches;
}

function getBranchFiles(git, repoRoot, branch) {
  // git diff --name-only origin/main...agent/<branch>
  const r = git(repoRoot, ['diff', '--name-only', 'origin/main', `origin/${branch}`]);
  if (r.code !== 0) return [];
  return r.out.split('\n').map(l => l.trim()).filter(Boolean);
}

function checkConflict(proposedFiles, openBranches, git, repoRoot) {
  if (!proposedFiles.length) return { hasConflict: false };
  
  const conflicts = [];
  
  for (const open of openBranches) {
    const openFiles = getBranchFiles(git, repoRoot, open.branch);
    if (!openFiles.length) continue;
    
    // Find overlap
    const overlap = proposedFiles.filter(pf => openFiles.includes(pf));
    if (overlap.length) {
      conflicts.push({
        branch: open.branch,
        files: overlap,
      });
    }
  }
  
  if (conflicts.length) {
    return { hasConflict: true, conflicts };
  }
  
  return { hasConflict: false };
}

// Main entry point
function main() {
  const [pipelineDir, taskId] = process.argv.slice(2);
  
  if (!pipelineDir || !taskId) {
    console.error('Usage: conflict-check.js <pipelineDir> <taskId>');
    process.exit(1);
  }
  
  // Read task
  const taskPath = path.join(pipelineDir, 'queue', 'pending', `${taskId}.json`);
  let task;
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  } catch (e) {
    console.error(`Task not found: ${taskPath}`);
    process.exit(1);
  }
  
  const repoRoot = path.dirname(pipelineDir); // agent-manager repo is parent of pipeline dir
  const git = runGit;
  
  const proposedFiles = getProposedFiles(task);
  const openBranches = getOpenBranches(pipelineDir);
  
  const result = checkConflict(proposedFiles, openBranches, git, repoRoot);
  
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { getProposedFiles, getOpenBranches, getBranchFiles, checkConflict };
