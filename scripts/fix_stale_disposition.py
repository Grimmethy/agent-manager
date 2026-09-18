#!/usr/bin/env python3
"""One-time data sweep: strip stale merge stamps from non-merged task records.

Three known live bugs left `mergedAt`, `mergedAtSource`, and `autoMergeCommit`
stamped on tasks that were never actually merged (their `terminalDisposition`
says otherwise, e.g. 'noop', 'abandoned', 'dismissed'). A task whose
`terminalDisposition` IS 'merged' legitimately carries those stamps and must be
left byte-identical.

This script walks the three terminal task folders --

  queue/done/
  queue/done/_superseded/
  queue/done/_archived_no_action/

and, for every `*.json` task record where `terminalDisposition` exists and is
not 'merged', deletes the three stale keys and rewrites the file (atomic:
temp file in the same directory, then os.replace). Files whose top level is
not a JSON object, and any unreadable/unparseable file, are counted as errors
and skipped so one bad record cannot abort the sweep.

The sweep is idempotent: a second run finds nothing to modify (each key is
removed with `dict.pop(k, None)`, and already-clean files are never rewritten).

Serialization matches the JS writers (JSON.stringify(data, null, 2)):
2-space indent, key order preserved, trailing-newline presence preserved.

Usage (from the pipeline repo root):

    python3 scripts/fix_stale_disposition.py --dry-run   # report only, no writes
    python3 scripts/fix_stale_disposition.py             # perform the sweep

Exit code 0 on success (all files handled), 1 if any file errored.
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

SCAN_DIRS = [
    Path("queue") / "done",
    Path("queue") / "done" / "_superseded",
    Path("queue") / "done" / "_archived_no_action",
]

STALE_KEYS = ("mergedAt", "mergedAtSource", "autoMergeCommit")


def process_file(path: Path, dry_run: bool):
    """Return (modified, removed_keys) for one task record.

    modified is True only when the guard passed AND at least one stale key was
    present. Raises on read/parse/write failure -- the caller counts it as an
    error.
    """
    text = path.read_text(encoding="utf-8")
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON: {exc}") from exc

    if not isinstance(obj, dict):
        # Not a task record (top level is an array/scalar) -- nothing to fix.
        return False, []

    if "terminalDisposition" not in obj or obj.get("terminalDisposition") == "merged":
        return False, []

    removed = [key for key in STALE_KEYS if key in obj]
    if not removed:
        return False, []

    for key in removed:
        obj.pop(key, None)

    if dry_run:
        return True, removed

    # Preserve the file's trailing-newline convention.
    trailing_newline = text.endswith("\n")
    out = json.dumps(obj, indent=2, ensure_ascii=False)
    if trailing_newline:
        out += "\n"

    # Atomic rewrite: temp file in the same directory, then replace.
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(out)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return True, removed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true",
                        help="report which files would change; write nothing")
    args = parser.parse_args(argv)

    scanned = modified = skipped = errors = 0
    for directory in SCAN_DIRS:
        if not directory.is_dir():
            print(f"warn: {directory}/ not found -- skipping (nothing to sweep here)")
            continue
        for path in sorted(directory.glob("*.json")):
            if not path.is_file():
                continue
            scanned += 1
            try:
                is_modified, removed = process_file(path, args.dry_run)
            except (OSError, ValueError) as exc:
                errors += 1
                print(f"error: {path}: {exc}")
                continue
            if is_modified:
                modified += 1
                action = "would modify" if args.dry_run else "modified"
                print(f"{action}: {path} (removed {', '.join(removed)})")
            else:
                skipped += 1

    label = "would-modify" if args.dry_run else "modified"
    print(f"Sweep complete: {scanned} scanned, {modified} {label}, "
          f"{skipped} skipped, {errors} errors")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
