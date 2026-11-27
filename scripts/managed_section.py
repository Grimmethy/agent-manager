"""Idempotent refresh of a machine-managed region delimited by marker lines.

Marker lines are matched by stripped-line equality, not substring.
"""
import os


def _marker_indexes(lines, marker):
    return [i for i, line in enumerate(lines) if line.strip() == marker]


def refresh_managed_section(text, body, start_marker, end_marker):
    """Replace the lines between one start marker and one end marker with body.

    - No marker lines at all: return text unchanged (byte for byte).
    - Any other marker count, or end before start: raise ValueError.
    - Exactly one ordered pair: keep both markers, replace only the lines between.
    """
    lines = text.splitlines(keepends=True)
    starts = _marker_indexes(lines, start_marker)
    ends = _marker_indexes(lines, end_marker)
    if not starts and not ends:
        return text
    if len(starts) != 1 or len(ends) != 1:
        raise ValueError(
            "expected exactly one start marker and one end marker, found %d start and %d end"
            % (len(starts), len(ends))
        )
    s, e = starts[0], ends[0]
    if e < s:
        raise ValueError("end marker appears before start marker")
    if body and not body.endswith("\n"):
        body += "\n"
    return "".join(lines[: s + 1] + [body] + lines[e:])


def write_if_changed(path, new_text):
    """Write new_text to path only if the existing bytes differ. Return True if written."""
    new_bytes = new_text.encode("utf-8")
    if os.path.exists(path):
        with open(path, "rb") as f:
            if f.read() == new_bytes:
                return False
    with open(path, "wb") as f:
        f.write(new_bytes)
    return True
