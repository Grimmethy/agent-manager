"""Corrupt-tolerant JSON store for the other-project branch cache.

The cache maps a real repo root (str) to ``{"branches": [...], "held": [...]}``.
``load_cache`` is forgiving: a missing file, corrupt JSON, a non-dict top level,
or any ``OSError`` all yield ``{}`` and never raise. Individual entries that
fail validation are dropped with a ``[branches]`` log line to stderr.

``save_cache`` writes atomically via ``tempfile.mkstemp`` + ``os.replace`` in
the same directory as the target, persisting only ``branches`` and ``held``
keys and stripping any transient error / retry state.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from typing import Any

_REQUIRED_KEYS = ("branches", "held")


def _log_drop(reason: str) -> None:
    """Write a ``[branches]``-prefixed drop notice to stderr."""
    sys.stderr.write(f"[branches] dropping invalid cache entry: {reason}\n")
    sys.stderr.flush()


def load_cache(path: str | os.PathLike[str]) -> dict[str, dict[str, list[Any]]]:
    """Load the branch cache from *path*, tolerating corruption.

    Returns ``{}`` for a missing file, corrupt JSON, a non-dict top level,
    or any ``OSError``.  Individual entries that lack ``branches`` or ``held``
    (or have non-list values for either) are dropped with a ``[branches]``
    log line to stderr and excluded from the returned cache.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:  # noqa: SIM115 (intentional)
            raw = fh.read()
    except (OSError, ValueError):
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    cleaned: dict[str, dict[str, list[Any]]] = {}
    for repo_root, entry in data.items():
        if not isinstance(entry, dict):
            _log_drop(f"{repo_root!r}: value is not a dict")
            continue
        if not all(k in entry for k in _REQUIRED_KEYS):
            _log_drop(f"{repo_root!r}: missing one of {_REQUIRED_KEYS}")
            continue
        if not isinstance(entry["branches"], list):
            _log_drop(f"{repo_root!r}: 'branches' is not a list")
            continue
        if not isinstance(entry["held"], list):
            _log_drop(f"{repo_root!r}: 'held' is not a list")
            continue
        cleaned[repo_root] = {"branches": entry["branches"], "held": entry["held"]}
    return cleaned


def save_cache(
    path: str | os.PathLike[str],
    cache: dict[str, dict[str, list[Any]]],
) -> None:
    """Atomically persist *cache* to *path*, stripping transient state.

    Only the ``branches`` and ``held`` keys are written; any other keys in the
    input entries (e.g. error, retry, timestamp) are dropped.  The write uses
    ``tempfile.mkstemp`` in the same directory as *path* followed by
    ``os.replace`` for atomicity.  The temp file is cleaned up on failure.
    Never raises.
    """
    parent = os.fspath(os.path.dirname(os.fspath(path) if isinstance(path, os.PathLike) else path))
    path_str = os.fspath(path) if isinstance(path, os.PathLike) else str(path)
    filtered: dict[str, dict[str, list[Any]]] = {}
    for repo_root, entry in cache.items():
        if not isinstance(entry, dict):
            continue
        filtered[repo_root] = {
            "branches": list(entry.get("branches", [])),
            "held": list(entry.get("held", [])),
        }
    payload = json.dumps(filtered, indent=2, sort_keys=True)
    fd: int | None = None
    tmp: str | None = None
    try:
        fd, tmp = tempfile.mkstemp(dir=parent, prefix=".branch_cache.", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fd = None  # ownership transferred to fh
            fh.write(payload)
        os.replace(tmp, path_str)
        tmp = None  # replaced successfully
    except BaseException:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if tmp is not None:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise
