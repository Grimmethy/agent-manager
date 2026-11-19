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
        RuntimeError: If no candidate succeeds and ``origin/HEAD`` has no
            default ref.
        subprocess.CalledProcessError: If the fallback ref itself cannot be
            checked out.
    """
    from app import _run_plugin_subprocess

    _run_plugin_subprocess(["git", "fetch", "--tags", "--prune"], cwd=plugin_dir)

    for ref in candidates:
        try:
            _run_plugin_subprocess(["git", "checkout", ref], cwd=plugin_dir)
            return ref
        except subprocess.CalledProcessError:
            continue

    stdout, _ = _run_plugin_subprocess(
        ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        cwd=plugin_dir,
    )
    default_ref = stdout.strip()
    if not default_ref:
        raise RuntimeError(
            f"No candidate ref succeeded for plugin_dir={plugin_dir}; "
            f"refs tried: {candidates}; default ref is empty"
        )

    _run_plugin_subprocess(["git", "checkout", default_ref], cwd=plugin_dir)
    return default_ref
