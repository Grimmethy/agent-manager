#!/usr/bin/env bash
# One-time and recurring sweep over every registered project:
#   1. For each project, add missing standard domains to its task-domains.json.
#   2. For each project, requeue tasks blocked/needs-clarification ONLY because of
#      'Unknown task domain' -- preserving premiumPriority and hub membership.
#   3. Report counts per project.
#
# Usage: scripts/sweep-task-domains.sh [--dry-run]
#   --dry-run: print what would change without writing anything.
#
# Idempotent: a second run changes nothing (no domains missing, no tasks to requeue).

set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# Read projects.json (the single source of truth for registered projects).
PROJECTS_JSON="$PACKAGE_ROOT/projects.json"
if [[ ! -f "$PROJECTS_JSON" ]]; then
  echo "[sweep] projects.json not found at $PROJECTS_JSON" >&2
  exit 1
fi

# Use node to do the heavy lifting: read projects.json, derive standard domains,
# repair each pipeline's task-domains.json, find and requeue blocked tasks.
node -e '
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const projectsJsonPath = process.argv[1];
const dryRun = process.argv[2] === "true";
const packageRoot = process.argv[3];

// Load projects.json
let projects;
try {
  projects = JSON.parse(fs.readFileSync(projectsJsonPath, "utf8"));
  if (!Array.isArray(projects)) throw new Error("projects.json is not an array");
} catch (e) {
  console.error(`[sweep] failed to read projects.json: ${e.message}`);
  process.exit(1);
}

// Resolve realpaths to deduplicate (same project registered twice with different paths).
const seenRealpaths = new Map(); // realpath -> project entry
const uniqueProjects = [];
for (const proj of projects) {
  const pipelineDir = proj.pipelineDir;
  if (!pipelineDir) continue;
  let realPath;
  try {
    realPath = fs.realpathSync(pipelineDir);
  } catch {
    // Pipeline dir does not exist yet; skip (will be created by provision/register).
    continue;
  }
  if (seenRealpaths.has(realPath)) continue;
  seenRealpaths.set(realPath, true);
  uniqueProjects.push(proj);
}

// Load the standard domains from task-domains-registry.js.
const registryPath = path.join(packageRoot, "src", "task-domains-registry.js");
const { getStandardDomains } = require(registryPath);
const standardDomains = getStandardDomains();

// Track summary.
const summary = {
  projectsProcessed: 0,
  projectsRepaired: 0,
  domainsAdded: 0,
  tasksRequeued: 0,
  perProject: [],
};

// For each project, repair task-domains.json.
for (const proj of uniqueProjects) {
  const pipelineDir = proj.pipelineDir;
  const domainsPath = path.join(pipelineDir, "task-domains.json");
  const projectName = proj.label || path.basename(pipelineDir);

  summary.perProject.push({
    name: projectName,
    pipelineDir,
    domainsAdded: 0,
    tasksRequeued: 0,
    status: "ok",
  });

  // Read current domains (or empty if file missing).
  let currentDomains = {};
  try {
    const raw = fs.readFileSync(domainsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      currentDomains = parsed;
    }
  } catch (e) {
    // File missing or invalid JSON; treat as empty.
    currentDomains = {};
  }

  // Find missing domains.
  const missing = [];
  for (const domainName of Object.keys(standardDomains)) {
    if (!(domainName in currentDomains)) {
      missing.push(domainName);
    }
  }

  if (missing.length === 0) {
    continue; // Already has all standard domains.
  }

  // Repair: add missing domains, preserve existing entries.
  const backupPath = dryRun ? null : `${domainsPath}.bak-${new Date().toISOString().slice(0, 10)}`;
  if (backupPath && fs.existsSync(domainsPath)) {
    fs.copyFileSync(domainsPath, backupPath);
  }

  for (const domainName of missing) {
    currentDomains[domainName] = standardDomains[domainName];
  }

  if (!dryRun) {
    fs.writeFileSync(domainsPath, JSON.stringify(currentDomains, null, 2) + "\n");
  }

  summary.projectsRepaired++;
  summary.domainsAdded += missing.length;
  summary.perProject[summary.perProject.length - 1].domainsAdded = missing.length;
  summary.perProject[summary.perProject.length - 1].status = "repaired";
}

// For each project, find and requeue blocked tasks.
for (const proj of uniqueProjects) {
  const pipelineDir = proj.pipelineDir;
  const projectName = proj.label || path.basename(pipelineDir);
  const projectSummary = summary.perProject.find(p => p.pipelineDir === pipelineDir);

  // Scan queue/blocked/, queue/needs-clarification/, queue/hold/ for tasks with
  // "Unknown task domain" in their blockedReason or status.
  const queueDir = path.join(pipelineDir, "queue");
  if (!fs.existsSync(queueDir)) continue;

  const subdirs = ["blocked", "needs-clarification", "hold"];
  for (const subdir of subdirs) {
    const dirPath = path.join(queueDir, subdir);
    if (!fs.existsSync(dirPath)) continue;

    let files;
    try {
      files = fs.readdirSync(dirPath).filter(f => f.endsWith(".json"));
    } catch {
      continue;
    }

    for (const file of files) {
      const taskPath = path.join(dirPath, file);
      let task;
      try {
        task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
      } catch {
        continue;
      }

      // Check if this task is blocked ONLY because of "Unknown task domain".
      const blockedReason = task.blockedReason || task.status || "";
      if (!blockedReason.includes("Unknown task domain")) continue;

      // Verify the domain is now valid (the sweep just added it).
      const domainsPath = path.join(pipelineDir, "task-domains.json");
      let currentDomains = {};
      try {
        currentDomains = JSON.parse(fs.readFileSync(domainsPath, "utf8"));
      } catch {
        continue;
      }
      if (!(task.domain in currentDomains)) continue;

      // Requeue: move from blocked/needs-clarification/hold to pending/.
      // Preserve premiumPriority, hub membership (stacked, dependsOn), etc.
      const pendingDir = path.join(queueDir, "pending");
      if (!fs.existsSync(pendingDir)) {
        try { fs.mkdirSync(pendingDir, { recursive: true }); } catch { continue; }
      }

      // Add history note explaining the requeue.
      task.history = task.history || [];
      task.history.push({
        stage: "sweep-task-domains",
        at: new Date().toISOString(),
        detail: `Requeued: domain "${task.domain}" was missing from task-domains.json, now added by sweep`,
      });

      // Remove blockedReason so the task is no longer held.
      delete task.blockedReason;
      if (task.status === "blocked" || task.status === "needs-clarification" || task.status === "hold") {
        task.status = "pending";
      }

      const pendingPath = path.join(pendingDir, file);
      if (!dryRun) {
        fs.writeFileSync(pendingPath, JSON.stringify(task, null, 2) + "\n");
        fs.unlinkSync(taskPath);
      }

      projectSummary.tasksRequeued++;
      summary.tasksRequeued++;
    }
  }
}

summary.projectsProcessed = uniqueProjects.length;

// Print summary.
console.log(JSON.stringify(summary, null, 2));
' "$PROJECTS_JSON" "$DRY_RUN" "$PACKAGE_ROOT"
