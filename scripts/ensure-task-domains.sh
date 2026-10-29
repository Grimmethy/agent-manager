#!/usr/bin/env bash
# Makes sure a project pipeline's task-domains.json lists every standard task domain.
#
# Why (2026-10-26): provision-plugin-repo.sh and adopt-existing-project.sh wrote a file with only
# "default", and register-project.sh wrote none, so a project's adhoc tasks failed review with
# "Unknown task domain: adhoc (valid: default)" until someone noticed. The standard set lives in
# config/task-domains.template.json (one source of truth).
#
# Usage: scripts/ensure-task-domains.sh <pipeline_dir>
#
# - file missing: written from the template.
# - file present: every template domain it lacks is ADDED. An existing domain is never changed or
#   removed (the file belongs to the project; a custom workDirKind stays). The original is first
#   copied to task-domains.json.bak-<date> (only when something is added).
# - file present but not valid JSON: nothing is touched, exit 1.
# - idempotent: a second run changes nothing and makes no backup.
set -euo pipefail

PIPELINE_DIR="${1:?usage: $0 <pipeline_dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$(cd "$SCRIPT_DIR/.." && pwd)/config/task-domains.template.json"
TARGET="$PIPELINE_DIR/task-domains.json"

[[ -f "$TEMPLATE" ]] || { echo "[ensure-task-domains] template not found: $TEMPLATE" >&2; exit 1; }
mkdir -p "$PIPELINE_DIR"

python3 - "$TEMPLATE" "$TARGET" <<'PYEOF'
import datetime
import json
import os
import shutil
import sys

template_path, target = sys.argv[1:3]
with open(template_path) as f:
    template = json.load(f)

if not os.path.exists(target):
    with open(target, "w") as f:
        json.dump(template, f, indent=2)
        f.write("\n")
    print(f"[ensure-task-domains] wrote {target} from the template ({len(template)} domains)")
    sys.exit(0)

try:
    with open(target) as f:
        current = json.load(f)
    if not isinstance(current, dict):
        raise ValueError("top level is not an object")
except (json.JSONDecodeError, ValueError) as e:
    print(f"[ensure-task-domains] {target} is not a valid domains file ({e}); left untouched", file=sys.stderr)
    sys.exit(1)

missing = [k for k in template if k not in current]
if not missing:
    print(f"[ensure-task-domains] {target} already lists all {len(template)} standard domains")
    sys.exit(0)

backup = f"{target}.bak-{datetime.date.today().isoformat()}"
shutil.copy2(target, backup)
for k in missing:
    current[k] = template[k]
with open(target, "w") as f:
    json.dump(current, f, indent=2)
    f.write("\n")
print(f"[ensure-task-domains] added {', '.join(missing)} to {target} (original kept at {backup})")
PYEOF
