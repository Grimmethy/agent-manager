"""Hub record schema, loader, and writer (HUB0931).

Self-contained module: no external dependencies (no Flask, no networkx, etc.).
Imported by python/dashboard/app.py for the dashboard's hub-record I/O.

Schema:
    _HubRecordSchema -- field-name constants for the hub record JSON.
    _HUB_RECORD_SCHEMA_FIELDS -- maps schema attributes to on-disk JSON keys.

Writer:
    write_hub_record(hub_id, record, qdir) -- persist a hub record dict to disk.
    Defaults pieceBranches to {} when the caller passes None.

Loader:
    load_hub_record(hub_id, qdir) -- read a hub record from disk.
    Defaults pieceBranches to {} when the on-disk file lacks the key.
"""
import json
import os
from pathlib import Path


class _HubRecordSchema:
    """Field-name constants for the hub record JSON schema. Kept as a class so the
    field names live in one place and the loader/writer can reference them without
    string-literal duplication. The serialization table (_HUB_RECORD_SCHEMA_FIELDS)
    maps each attribute to its JSON key in the on-disk record."""
    id = "id"
    created_at = "created_at"
    updated_at = "updated_at"
    labels = "labels"
    subTasks = "subTasks"
    pieceCount = "pieceCount"
    pieceOrder = "pieceOrder"
    pieceNames = "pieceNames"
    pieceStates = "pieceStates"
    pieceStats = "pieceStats"
    pieceHashes = "pieceHashes"
    pieceSizes = "pieceSizes"
    pieceStatuses = "pieceStatuses"
    pieceBranches = "pieceBranches"
    pieces = "pieces"
    config = "config"


# Maps _HubRecordSchema attributes to their on-disk JSON keys. The writer serializes
# only these fields; the loader reads them back. pieceBranches is optional (default {})
# for backward compatibility with hub records written before HUB0931.
_HUB_RECORD_SCHEMA_FIELDS = {
    _HubRecordSchema.id: "id",
    _HubRecordSchema.created_at: "created_at",
    _HubRecordSchema.updated_at: "updated_at",
    _HubRecordSchema.labels: "labels",
    _HubRecordSchema.subTasks: "subTasks",
    _HubRecordSchema.pieceCount: "pieceCount",
    _HubRecordSchema.pieceOrder: "pieceOrder",
    _HubRecordSchema.pieceNames: "pieceNames",
    _HubRecordSchema.pieceStates: "pieceStates",
    _HubRecordSchema.pieceStats: "pieceStats",
    _HubRecordSchema.pieceHashes: "pieceHashes",
    _HubRecordSchema.pieceSizes: "pieceSizes",
    _HubRecordSchema.pieceStatuses: "pieceStatuses",
    _HubRecordSchema.pieceBranches: "pieceBranches",
    _HubRecordSchema.pieces: "pieces",
    _HubRecordSchema.config: "config",
}


def write_hub_record(hub_id: str, record: dict, qdir: Path) -> Path:
    """Write a hub record to disk.

    `record` is the full hub dict to persist -- the writer selects only the fields
    declared in _HUB_RECORD_SCHEMA_FIELDS and defaults pieceBranches to {} when the
    caller did not supply one. Returns the path written, for caller convenience.

    Backward-compatible: old hub records without pieceBranches keep working; the
    loader treats a missing key as {}.
    """
    if not qdir:
        raise ValueError("write_hub_record requires a qdir")
    out_dir = qdir / "coordinating"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{hub_id}.json"

    serialized = {}
    for schema_attr, json_key in _HUB_RECORD_SCHEMA_FIELDS.items():
        value = record.get(schema_attr)
        if schema_attr == _HubRecordSchema.pieceBranches:
            # pieceBranches is optional; default to {} for backward compatibility
            serialized[json_key] = value if value is not None else {}
        elif value is not None:
            serialized[json_key] = value

    # Preserve any extra fields the caller put in the record that aren't in the schema
    # (e.g. hubLabel, branch, formerIds) so we don't silently drop them on re-write.
    for key, value in record.items():
        if key not in serialized:
            serialized[key] = value

    tmp = out_path.with_name(out_path.name + ".tmp")
    tmp.write_text(json.dumps(serialized, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(str(tmp), str(out_path))
    return out_path


def load_hub_record(hub_id: str, qdir: Path) -> dict | None:
    """Load a hub record by id from disk.

    Returns the parsed dict, or None if the file does not exist or is unreadable.
    The pieceBranches field defaults to {} when the on-disk record lacks it, so callers
    never see a missing-key error.
    """
    if not qdir:
        return None
    hub_path = qdir / "coordinating" / f"{hub_id}.json"
    if not hub_path.is_file():
        return None
    # read_json_safe is in app_settings_helpers; to keep this module dependency-free
    # we inline the same minimal logic here.
    try:
        raw = hub_path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    # Normalize: ensure pieceBranches is always a dict (default {})
    pb = data.get("pieceBranches")
    if not isinstance(pb, dict):
        data["pieceBranches"] = {}
    return data
