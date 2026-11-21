"""Duplicate key for a Docs/*_CANDIDATES.md heading whose title names a whole FILE ('Remove unused file <path>').

A whole-file candidate is keyed on its full Files path, never on a path segment: without this, 'TaxHarvest/...' reads as
an identifier and every other whole-file candidate under that folder matches it. Standalone: no import of app.
"""
import re

_WHOLE_FILE_RE = re.compile(r"^Remove unused file\s+(\S+)")


def whole_file_path(title):
    """The Files path a 'Remove unused file <path>' title names, or None."""
    m = _WHOLE_FILE_RE.match(title or "")
    return m.group(1) if m else None


def candidate_key(title, ident):
    """('path', path) for a whole-file title, else ('ident', ident) when there is one, else None (= new)."""
    path = whole_file_path(title)
    if path:
        return ("path", path)
    return ("ident", ident) if ident else None
