# tools/staleness/feature_preamble.py
#
# Helpers for the staleness audit pipeline's duplicate-of overlap check.
#
# strip_feature_preamble(text) -> str:
#   Removes the shared-feature preamble that every piece of a stacked hub chain
#   repeats at the top (the "This piece is part of" marker and everything after
#   it, plus the repo-rules paragraph). Returns the text unchanged when no
#   marker is present. Used so two siblings of the same hub don't appear as
#   near-duplicates of each other just because they share boilerplate.
#
# siblings_share_feature_or_chain(a, b) -> bool:
#   Returns True when two records share a feature slug or a hub chain. Used as
#   a guard in the duplicate-of overlap check: 'retire' must never be emitted
#   for a same-feature pair because retiring one of the pair would drop the
#   only live record of work that is not done.
#
# Action values 'retire' and 'review' are existing and unchanged; 'retire' must
# never be emitted for a same-feature pair.

from __future__ import annotations

import re
from typing import Any


# 2026-11-01 (HUB0497): the shared-feature preamble that every piece of a
# stacked hub chain repeats at the top. normalizeTaskTokens in
# staleness-audit-dedup.js reads the first 600 chars, so this block is what
# causes ~90% overlap between siblings of the same hub.
_FEATURE_PREAMBLE_MARKER = "This piece is part of"

# Repo-rules paragraph: the block that every task prompt template stamps at the
# bottom. It begins with a "## Repository Rules" heading (or similar) and
# continues until the next top-level heading or end of document.
_REPO_RULES_RE = re.compile(
    r"\n##\s*Repository Rules.*?(?=\n##|\Z)",
    re.DOTALL | re.IGNORECASE,
)


def strip_feature_preamble(text: str) -> str:
    """Remove the shared-feature preamble from *text*.

    Strips everything from the first 'This piece is part of' marker onward and
    removes the repository-rules paragraph, returning the text unchanged when
    no marker is present.

    Args:
        text: The raw task prompt text to clean.

    Returns:
        The cleaned text with the preamble and repo-rules block removed.
    """
    if not text:
        return text

    # Find the first occurrence of the feature preamble marker
    marker_idx = text.find(_FEATURE_PREAMBLE_MARKER)
    if marker_idx == -1:
        # No marker present -- return unchanged
        return text

    # Strip everything from the marker onward
    cleaned = text[:marker_idx].rstrip()

    # Remove the repository-rules paragraph
    cleaned = _REPO_RULES_RE.sub("", cleaned)

    # Clean up any trailing whitespace left by the removal
    cleaned = cleaned.rstrip()

    return cleaned


def siblings_share_feature_or_chain(a: Any, b: Any) -> bool:
    """Check if two records share a feature slug or a hub chain.

    Returns True when two records share a feature slug (from promptContext) or
    a hub chain (related as hub/child or siblings in a stacked chain). Used as
    a guard in the duplicate-of overlap check to prevent emitting 'retire' for
    same-feature pairs.

    Args:
        a: First record (task dict or similar).
        b: Second record (task dict or similar).

    Returns:
        True if the records share a feature slug or hub chain, False otherwise.
    """
    if not a or not b:
        return False

    # Check shared feature slug
    feature_slug_a = None
    feature_slug_b = None

    if isinstance(a, dict):
        prompt_ctx_a = a.get("promptContext") or {}
        feature_slug_a = prompt_ctx_a.get("featureSlug") or prompt_ctx_a.get("feature_slug")
    if isinstance(b, dict):
        prompt_ctx_b = b.get("promptContext") or {}
        feature_slug_b = prompt_ctx_b.get("featureSlug") or prompt_ctx_b.get("feature_slug")

    if feature_slug_a and feature_slug_b and feature_slug_a == feature_slug_b:
        return True

    # Check shared hub chain (related as hub/child or siblings)
    if _related_as_hub_and_child(a, b):
        return True

    if _related_as_siblings(a, b):
        return True

    return False


def _related_as_hub_and_child(a: Any, b: Any) -> bool:
    """Check if two records are related as hub and child in either direction.

    Args:
        a: First record.
        b: Second record.

    Returns:
        True if related as hub/child, False otherwise.
    """
    if not a or not b:
        return False

    def _get_hub_id(record: Any) -> str | None:
        """Extract the hub ID from a record."""
        if not isinstance(record, dict):
            return None
        # Try parentHub first (stamped by apply-task.js)
        parent_hub = record.get("parentHub")
        if parent_hub:
            return str(parent_hub)
        # Fallback to promptContext.decomposedFrom
        prompt_ctx = record.get("promptContext") or {}
        decomposed_from = prompt_ctx.get("decomposedFrom")
        if decomposed_from:
            return str(decomposed_from)
        return None

    hub_a = _get_hub_id(a)
    hub_b = _get_hub_id(b)

    if not hub_a or not hub_b:
        return False

    # Check if one is the hub of the other
    if hub_a == str(b.get("id", "")):
        return True
    if hub_b == str(a.get("id", "")):
        return True

    # Check subTasks lists
    def _matches_subtask(entry: Any, other_id: str) -> bool:
        e = str(entry or "").strip()
        if not e:
            return False
        return e == other_id or other_id.startswith(e + "-") or e.startswith(other_id + "-")

    other_id_b = str(b.get("id", ""))
    other_id_a = str(a.get("id", ""))

    sub_tasks_a = a.get("subTasks") or []
    if isinstance(sub_tasks_a, list) and any(_matches_subtask(s, other_id_b) for s in sub_tasks_a):
        return True

    sub_tasks_b = b.get("subTasks") or []
    if isinstance(sub_tasks_b, list) and any(_matches_subtask(s, other_id_a) for s in sub_tasks_b):
        return True

    return False


def _related_as_siblings(a: Any, b: Any) -> bool:
    """Check if two records are siblings in a stacked hub chain.

    Args:
        a: First record.
        b: Second record.

    Returns:
        True if siblings, False otherwise.
    """
    if not a or not b:
        return False

    # Check shared stacked branch
    def _get_branch(record: Any) -> str | None:
        if not isinstance(record, dict):
            return None
        stacked = record.get("stacked")
        if isinstance(stacked, dict):
            return stacked.get("branch")
        return None

    branch_a = _get_branch(a)
    branch_b = _get_branch(b)

    if branch_a and branch_b and branch_a == branch_b:
        return True

    # Check shared decomposedFrom
    def _get_decomposed_from(record: Any) -> str | None:
        if not isinstance(record, dict):
            return None
        prompt_ctx = record.get("promptContext") or {}
        return prompt_ctx.get("decomposedFrom")

    from_a = _get_decomposed_from(a)
    from_b = _get_decomposed_from(b)

    if from_a and from_b and from_a == from_b:
        return True

    return False
