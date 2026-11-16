# Chat capabilities and limits

The Chat panel is one global conversation rooted at the agent-manager repo. Its primary root (`roots[0]`) is agent-manager. The remaining roots come from `_chat_roots()` in `python/dashboard/app.py`, which lists every usable registered plugin (`plugins.json`) and project (`projects.json`) entry.

## What Chat can do

- **Read, search and edit local files** under its roots. The granted tools are `Read,Grep,Glob,Edit,Write,Bash` (`CHAT_CLAUDE_ALLOWED_TOOLS` in `python/dashboard/chat_sessions.py`).
- **Read registered roots.** Chat can read every root listed in `session["roots"]`.
- **Register repos** through the register-repo route, `POST /api/internal/chat/register-repo` (`python/dashboard/routes/internal_chat.py`). The response is JSON `{rootsBefore, rootsAfter, registered, warnings}`. `rootsBefore` and `rootsAfter` are the root lists before and after the registration, and `warnings` is the registry warning list described below.

## Stated limits

These are limits of the Chat design. Nothing in the Chat code enforces them, and the granted tools would allow some of them in principle.

- **No web access.** No web tool is granted. `Bash` is granted, so this is a statement about the tool set, not a guarantee that the process has no network access.
- **No GitHub clone.** Chat is not meant to clone repositories from GitHub. Cloning from GitHub is the job of the deep-dive pipeline. `Bash` is granted, so Chat could run `git clone` if it chose to.
- **No Tailscale access.** This is a stated limit of the Chat design. Chat has no Tailscale-specific tool or root. Tailscale appears in `python/` only in serving and UI comments.

## Behavior

- **Roots refresh per turn.** `get_active_session` re-resolves `session["roots"]` on every call. When the caller passes its `projects.json` and `plugins.json` paths, their mtimes are compared against `session["rootsMtime"]`, and the roots are rebuilt only when one has changed. A newly registered repo is therefore visible on the next message.
- **Rejected `projects.json` entries surface as warnings.** `read_project_registry()` checks each entry with `validate_project_entry(entry)` in `python/dashboard/app.py`. Problem strings are collected and returned by `get_registry_warnings()` as a list of `{entry, reason}` objects. `/api/chat/active` includes them as `registryWarnings`. A rejected entry is still returned to callers, which decide what to do with it, so the warning is the only signal that an entry has a problem.
