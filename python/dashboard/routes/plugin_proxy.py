"""Generic reverse proxy for a slotted plugin's own HTTP API -- Phase 3 of extracting
Chat into a standalone plugin repo (see
/home/wok/.claude/plans/immutable-noodling-axolotl.md).

routes/hardware.py's own proxy (a plain urllib.request.urlopen call) works fine for a
JSON request/response, but cannot proxy an SSE stream -- it buffers to completion. Chat's
`/api/chat/<id>/message` is exactly that case, and unlike hardware.py (one plugin, two
hand-written routes), Chat's route set can grow over time without ever needing an
agent-manager-side code change again: any plugin declaring a `proxy: {prefix, sse?,
readTimeoutS?}` block in its plugins.json entry gets every path under that prefix
forwarded here automatically.

- Non-SSE requests: urllib.request, same timeout/error-shape convention hardware.py's
  own proxy already uses.
- SSE requests (proxy.sse: true AND the client's Accept header asks for
  text/event-stream): `requests` with stream=True, piped through Flask's
  stream_with_context -- the request's own read timeout is `proxy.readTimeoutS` (falls
  back to 30s), since a chat turn can legitimately run many minutes and a fixed short
  timeout would kill every one of them (see local_tool_client.py's own
  SUBPROCESS_TIMEOUT_S for why 6000s is the real ceiling a caller may need to allow for).
"""
import json
import urllib.error
import urllib.request

import requests
from flask import Blueprint, Response, abort, request, stream_with_context

plugin_proxy_bp = Blueprint("plugin-proxy-bp", __name__)

_DEFAULT_READ_TIMEOUT_S = 30
_DEFAULT_CONNECT_TIMEOUT_S = 5


def _proxy_entry(name: str) -> dict:
    from app import _read_plugins_manifest
    manifest = _read_plugins_manifest()
    entry = next((p for p in manifest if p.get("name") == name and p.get("active")), None)
    if entry is None:
        abort(404, description=f"no active plugin named '{name}'")
    if not entry.get("proxy"):
        abort(404, description=f"plugin '{name}' does not declare a proxy block in plugins.json")
    if not entry.get("url"):
        abort(500, description=f"plugin '{name}' has a proxy block but no url")
    return entry


def _wants_sse(entry: dict) -> bool:
    proxy = entry.get("proxy") or {}
    if not proxy.get("sse"):
        return False
    accept = (request.headers.get("Accept") or "").lower()
    return "text/event-stream" in accept


@plugin_proxy_bp.route(
    "/api/plugins/<name>/proxy/<path:subpath>",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
)
def api_plugin_proxy(name, subpath):
    entry = _proxy_entry(name)
    target = f"{entry['url'].rstrip('/')}/{subpath}"
    if request.query_string:
        target = f"{target}?{request.query_string.decode('utf-8')}"

    if _wants_sse(entry):
        proxy = entry.get("proxy") or {}
        read_timeout = proxy.get("readTimeoutS") or _DEFAULT_READ_TIMEOUT_S
        body = request.get_data()

        def generate():
            try:
                with requests.request(
                    request.method, target,
                    data=body if body else None,
                    headers={"Content-Type": request.headers.get("Content-Type", "application/json")},
                    stream=True, timeout=(_DEFAULT_CONNECT_TIMEOUT_S, read_timeout),
                ) as upstream:
                    for chunk in upstream.iter_content(chunk_size=None):
                        if chunk:
                            yield chunk
            except requests.RequestException as e:
                yield f"data: {json.dumps({'type': 'error', 'error': f'proxy to plugin {name!r} failed: {e}'})}\n\n".encode()

        return Response(stream_with_context(generate()), mimetype="text/event-stream")

    # Non-SSE: same urllib pattern routes/hardware.py's own proxy already uses.
    body = request.get_data() or None
    req = urllib.request.Request(
        target, data=body, method=request.method,
        headers={"Content-Type": request.headers.get("Content-Type", "application/json")},
    )
    try:
        with urllib.request.urlopen(req, timeout=_DEFAULT_READ_TIMEOUT_S) as r:
            payload = r.read()
            content_type = r.headers.get("Content-Type", "application/json")
        return Response(payload, status=200, content_type=content_type)
    except urllib.error.HTTPError as e:
        return Response(e.read(), status=e.code, content_type=e.headers.get("Content-Type", "application/json"))
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        abort(502, description=f"proxy to plugin {name!r} failed: {e}")
