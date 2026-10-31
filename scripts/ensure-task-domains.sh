#!/usr/bin/env bash
# Makes sure a project pipeline's task-domains.json lists every standard task domain.
#
# Why (2026-10-26): provision-plugin-repo.sh and adopt-existing-project.sh wrote a file with only
# "default", and register-project.sh wrote none, so a project's adhoc tasks failed review with
# "Unknown task domain: adhoc (valid: default)" until someone noticed. The standard set is now
# derived from src/task-domains-registry.js (one source of truth: every registered source name
# plus 'default' and 'adhoc').
#
# Usage: scripts/ensure-task-domains.sh <pipeline_dir>
#
# - file missing: written from the registry.
# - file present: every standard domain it lacks is ADDED. An existing domain is never changed or
#   removed (the file belongs to the project; a custom workDirKind stays). The original is first
#   copied to task-domains.json.bak-<date> (only when something is added).
# - file present but not valid JSON: nothing is touched, exit 1.
# - idempotent: a second run changes nothing and makes no backup.
set -euo pipefail

PIPELINE_DIR="${1:?usage: $0 <pipeline_dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$PIPELINE_DIR/task-domains.json"

mkdir -p "$PIPELINE_DIR"

node -e '
const fs = require("fs");
const path = require("path");

const target = process.argv[1];
const packageRoot = process.argv[2];

const { getStandardDomains } = require(path.join(packageRoot, "src", "task-domains-registry.js"));
const standardDomains = getStandardDomains();

if (!fs.existsSync(target)) {
  fs.writeFileSync(target, JSON.stringify(standardDomains, null, 2) + "\n");
  console.log(`[ensure-task-domains] wrote ${target} from task-domains-registry.js (${Object.keys(standardDomains).length} domains)`);
  process.exit(0);
}

let current;
try {
  const raw = fs.readFileSync(target, "utf8");
  current = JSON.parse(raw);
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("top level is not an object");
  }
} catch (e) {
  console.error(`[ensure-task-domains] ${target} is not a valid domains file (${e.message}); left untouched`, file: process.stderr);
  process.exit(1);
}

const missing = Object.keys(standardDomains).filter(k => !(k in current));
if (missing.length === 0) {
  console.log(`[ensure-task-domains] ${target} already lists all ${Object.keys(standardDomains).length} standard domains`);
  process.exit(0);
}

const backup = `${target}.bak-${new Date().toISOString().slice(0, 10)}`;
fs.copyFileSync(target, backup);
for (const k of missing) {
  current[k] = standardDomains[k];
}
fs.writeFileSync(target, JSON.stringify(current, null, 2) + "\n");
console.log(`[ensure-task-domains] added ${missing.join(", ")} to ${target} (original kept at ${backup})`);
' "$TARGET" "$PACKAGE_ROOT"
