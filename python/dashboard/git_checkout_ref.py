"""Helper for git fetch/checkout of a plugin directory.

Extracted from the inline block in ``python/dashboard/routes/plugins.py`` so the
logic can be reused and tested without spinning up the Flask app.
"""

import subprocess


def _checkout_git_ref(plugin_dir: str, candidates: list[str]) -> str:
    """Fetch tags and try each candidate ref, returning the first successful one.

    If no candidate succeeds, falls back to the default branch ref from
    ``refs/remotes/origin/HEAD``. Raises ``RuntimeError`` if the default ref is
    empty.

    Args:
        plugin_dir: Absolute path to the plugin directory (used as ``cwd``).
        candidates: Ordered list of refs/tags to try in sequence.

    Returns:
        The ref that was successfully checked out.

    Raises:
        RuntimeError: If no candidate succeeds and the default-ref fallback
            also fails (``origin/HEAD`` lookup fails, is empty, or its ref
            cannot be checked out).
        subprocess.CalledProcessError: Only from the initial ``git fetch``.
        subprocess.TimeoutExpired, OSError: Propagated from the subprocess
            seam unchanged.
    """
    from app import _run_plugin_subprocess

    _run_plugin_subprocess(["git", "fetch", "--tags", "--prune"], cwd=plugin_dir)

    for ref in candidates:
        try:
            _run_plugin_subprocess(["git", "checkout", ref], cwd=plugin_dir)
            return ref
        except subprocess.CalledProcessError:
            continue

    try:
        stdout, _ = _run_plugin_subprocess(
            ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            cwd=plugin_dir,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"No candidate ref succeeded for plugin_dir={plugin_dir}; "
            f"refs tried: {candidates}; origin/HEAD lookup failed"
        ) from exc
    default_ref = stdout.strip()
    if not default_ref:
        raise RuntimeError(
            f"No candidate ref succeeded for plugin_dir={plugin_dir}; "
            f"refs tried: {candidates}; default ref is empty"
        )

    try:
        _run_plugin_subprocess(["git", "checkout", default_ref], cwd=plugin_dir)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"No candidate ref succeeded for plugin_dir={plugin_dir}; "
            f"refs tried: {candidates}; default ref {default_ref!r} failed to check out"
        ) from exc
    return default_ref
