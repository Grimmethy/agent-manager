"""Resolve a hub reference (a coordinating record id or a HUBnnnn label) to a record id.

Self-contained: this module does not import app.py. It reads <base_dir>/coordinating/*.json
read-only, once per call. No polling, no retries, no model calls, no writes.
"""
import json
import os
import re
from pathlib import Path

_HUB_LABEL_FULL_RE = re.compile(r"HUB\d{4}")


class HubRefNotFound(Exception):
    """No coordinating record matches the reference."""


class HubRefAmbiguous(Exception):
    """More than one distinct coordinating record matches the reference.

    `candidates` is a list of {"id": ..., "label": ...} dicts, one per distinct record.
    """

    def __init__(self, candidates):
        self.candidates = list(candidates)
        ids = ", ".join(str(c.get("id")) for c in self.candidates)
        super().__init__(
            f"ambiguous hub reference matches {len(self.candidates)} records: {ids}"
        )


def _read_json_safe(path):
    """Parsed JSON, or None on OSError / JSONDecodeError (mirrors app.read_json_safe)."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _default_base_dir():
    """Default queue directory.

    app.py resolves the pipeline dir through _active_project_setting() and
    get_active_repo_root(), which cannot be reproduced here without importing app.py.
    So the default is only available when AGENT_MANAGER_PIPELINE_DIR is set in the
    environment; otherwise the caller must pass base_dir explicitly.
    """
    pipeline = os.environ.get("AGENT_MANAGER_PIPELINE_DIR")
    if not pipeline:
        return None
    return Path(pipeline) / "queue"


def resolve_hub_ref(ref, base_dir=None):
    """Return the record id for `ref`.

    - A record matches when its id (or file stem, if it has no id) equals `ref`.
      No label requirement.
    - A record also matches when its hubLabel equals `ref`, but only if `ref` fully
      matches HUB\\d{4}.
    Matches are unioned by record identity. Zero distinct records raises HubRefNotFound;
    more than one raises HubRefAmbiguous; exactly one returns its record id.
    """
    if base_dir is None:
        base_dir = _default_base_dir()
    if base_dir is None:
        raise ValueError(
            "resolve_hub_ref: base_dir is required when AGENT_MANAGER_PIPELINE_DIR is unset"
        )
    coord = Path(base_dir) / "coordinating"

    label_mode = bool(_HUB_LABEL_FULL_RE.fullmatch(ref))
    matches = {}  # record id -> {"id", "label"}, deduplicated by identity
    if coord.is_dir():
        for f in sorted(coord.glob("*.json")):
            hub = _read_json_safe(f)
            if not isinstance(hub, dict):
                continue
            rid = hub.get("id") or f.stem
            label = hub.get("hubLabel")
            id_hit = rid == ref
            label_hit = label_mode and label == ref
            if id_hit or label_hit:
                matches.setdefault(rid, {"id": rid, "label": label})

    if not matches:
        raise HubRefNotFound(f"no hub record matches {ref!r}")
    if len(matches) > 1:
        raise HubRefAmbiguous(list(matches.values()))
    return next(iter(matches))
