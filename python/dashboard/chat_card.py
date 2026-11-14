"""Which GPU card does the next Chat turn run on (2026-10-23, Grimmethy: chat should use a different GPU while the Forge is using the
3090, and the card should be selectable). The decision is made in node by src/chat-card.js (it reuses src/lanes.js and the Forge lease
check, so Python and JS cannot drift); this module shells out to it, the same way app.worker_lane_defs reads the lanes."""

import json
import os
import subprocess
from pathlib import Path

CHAT_CARD_JS = Path(__file__).resolve().parent.parent.parent / "src" / "chat-card.js"
_TIMEOUT_S = 5


def resolve_chat_card(preferred: str = None) -> dict:
    """-> {lane, env, moved, from, note, blocked}. `preferred` is a lane id (worker-3090, worker-rx580, ...) or empty for the host lane.
    If node or the lane definitions cannot be read the answer is {lane: None, env: {}, blocked: False, note: ''}: chat then runs exactly as it did
    before cards existed (inherited env), never blocked by a broken picker."""
    cmd = ["node", str(CHAT_CARD_JS)] + (["--card", preferred] if preferred else [])
    try:
        cp = subprocess.run(cmd, capture_output=True, text=True, timeout=_TIMEOUT_S, env=dict(os.environ))
        out = json.loads(cp.stdout)
        if isinstance(out, dict) and "blocked" in out:
            return out
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return {"lane": None, "env": {}, "moved": False, "from": None, "blocked": False, "note": ""}
