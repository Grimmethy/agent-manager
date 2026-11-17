"""Deterministic retrieval of Chat context-log entries from the Second Brain vault.

Reads the notes written by src/context-log-sweep.js under
'<second_brain_dir>/Agent Manager Reports/Chat Context Logs/'. Runs on demand only
(no polling, no model calls) and imports no LLM client modules.
"""

import os
import re

CONTEXT_LOG_CHAR_CAP: int = 4000

CONTEXT_LOG_MAX_FILES: int = 20

# Mirrors CONTEXT_LOG_SUBDIR in src/context-log-sweep.js.
CONTEXT_LOG_SUBDIR = os.path.join('Agent Manager Reports', 'Chat Context Logs')

AUDIT_PREFIX = '[context-log audit] injected: '

_ENTRY_RE = re.compile(r'^- \*\*([^*]+)\*\* ')


def retrieve_context_logs(second_brain_dir: str, project: str, task_ref: str, char_cap: int = CONTEXT_LOG_CHAR_CAP, max_files: int = CONTEXT_LOG_MAX_FILES) -> tuple[str, list[tuple[str, str]]]:
    """Return (block_text, injected) for log lines tagged with project/task_ref.

    injected is a list of (sessionId, ISO timestamp) in output order (newest first).
    Returns ('', []) on empty task_ref, missing directory, or any OSError.
    """
    if not task_ref or not str(task_ref).strip() or not second_brain_dir:
        return '', []
    if max_files <= 0:
        return '', []
    log_dir = os.path.join(second_brain_dir, CONTEXT_LOG_SUBDIR)
    suffix = f' -- [[{project}]] (task `{task_ref}`)'
    try:
        if not os.path.isdir(log_dir):
            return '', []
        files = []
        for name in os.listdir(log_dir):
            if not name.endswith('.md'):
                continue
            path = os.path.join(log_dir, name)
            if not os.path.isfile(path):
                continue
            files.append((os.stat(path).st_mtime, name))
        files.sort(key=lambda t: (-t[0], t[1]))
        entries = []
        for _mtime, name in files[:max_files]:
            session_id = os.path.splitext(name)[0]
            with open(os.path.join(log_dir, name), 'r', encoding='utf-8', errors='replace') as fh:
                text = fh.read()
            for line in text.splitlines():
                if not line.endswith(suffix):
                    continue
                m = _ENTRY_RE.match(line)
                if not m:
                    continue
                entries.append((m.group(1), session_id, line))
    except OSError:
        return '', []

    entries.sort(key=lambda e: (e[0], e[1]), reverse=True)

    kept = []
    for iso, session_id, line in entries:
        candidate = kept + [(iso, session_id, line)]
        if len(_render(candidate)) > char_cap:
            break
        kept = candidate
    if not kept:
        return '', []
    injected = [(sid, iso) for iso, sid, _ in kept]
    return _render(kept), injected


def _render(kept) -> str:
    body = '\n'.join(line for _iso, _sid, line in kept)
    audit = AUDIT_PREFIX + ', '.join(f'{sid}@{iso}' for iso, sid, _ in kept)
    return body + '\n' + audit
