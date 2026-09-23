from flask import Blueprint, abort, jsonify, request, send_file

import plugin_process_manager
from pathlib import Path
import subprocess

# The app.py helpers these views call (PLUGINS_MANIFEST_PATH, _installed_plugin_version, _pipeline_running, _plugin_name_from_path, _plugins_install_dir, _read_plugin_catalog, _read_plugins_manifest, _restart_pipeline, _run_plugin_subprocess, _version_tuple, _wait_for_plugin_health, _write_plugins_manifest) are
# imported lazily inside each view: app.py imports THIS module to register the
# blueprint, so a top-level `from app import ...` is a circular import that only
# fails when app.py is the entrypoint (how the dashboard runs). By the time a view
# runs, app.py is fully initialised and the import is just a dict lookup. (Same
# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)

plugins_bp = Blueprint("plugins-bp", __name__)

@plugins_bp.route("/api/plugins")
def api_plugins():
    from app import PLUGINS_MANIFEST_PATH, _read_plugins_manifest
    manifest = _read_plugins_manifest()
    for p in manifest:
        if p.get("slot"):
            p["running"] = plugin_process_manager.is_running(p["name"])
    return jsonify({
        "plugins": manifest,
        "manifestPath": str(PLUGINS_MANIFEST_PATH),
    })


@plugins_bp.route("/api/plugins/toggle", methods=["POST"])
def api_plugins_toggle():
    from app import _pipeline_running, _read_plugins_manifest, _restart_pipeline, _write_plugins_manifest
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    enabled = bool(body.get("enabled"))
    manifest = _read_plugins_manifest()
    match = next((p for p in manifest if p.get("name") == name), None)
    if match is None:
        abort(404, description=f"no plugin named '{name}'")
    match["enabled"] = enabled
    _write_plugins_manifest(manifest)
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True
    return jsonify({"name": name, "enabled": enabled, "restarted": restarted})


@plugins_bp.route("/api/plugins/add", methods=["POST"])
def api_plugins_add():
    from app import _pipeline_running, _plugin_name_from_path, _read_plugins_manifest, _restart_pipeline, _validate_plugin_tab, _write_plugins_manifest
    body = request.get_json(silent=True) or {}
    register_path = (body.get("registerPath") or "").strip()
    name = (body.get("name") or "").strip() or _plugin_name_from_path(register_path)
    description = (body.get("description") or "").strip()
    tab = body.get("tab")

    if not register_path:
        abort(400, description="registerPath is required")
    p = Path(register_path)
    if not p.is_absolute():
        abort(400, description="registerPath must be an absolute path")
    if not p.is_file() or p.suffix != ".js":
        abort(400, description=f"registerPath must point at an existing .js file (got {register_path})")
    if tab is not None:
        tab_error = _validate_plugin_tab(tab)
        if tab_error:
            abort(400, description=f"tab: {tab_error}")

    manifest = _read_plugins_manifest()
    if any(pl.get("name") == name for pl in manifest):
        abort(409, description=f"a plugin named '{name}' is already registered")
    if any(pl.get("registerPath") == register_path for pl in manifest):
        abort(409, description="that registerPath is already registered")

    entry = {"name": name, "registerPath": register_path, "enabled": True, "description": description}
    if tab is not None:
        entry["tab"] = tab
    manifest.append(entry)
    _write_plugins_manifest(manifest)
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True
    return jsonify({"plugin": entry, "restarted": restarted})


@plugins_bp.route("/api/plugins/install", methods=["POST"])
def api_plugins_install():
    """Installs a free plugin from the catalog: fetches the source (git clone or
    npm install) into the plugins dir, runs npm install inside the plugin dir, and
    registers the resulting register.js in the plugins manifest. Paid catalog entries
    are rejected with 402 before anything is written."""
    from app import _pipeline_running, _plugins_install_dir, _read_plugin_catalog, _read_plugins_manifest, _restart_pipeline, _write_plugins_manifest

    class _InstallError(Exception):
        def __init__(self, message, stderr=None):
            super().__init__(message)
            self.stderr = stderr

    body = request.get_json(silent=True) or {}
    plugin_id = (body.get("id") or "").strip()
    if not plugin_id:
        abort(400, description="id is required")

    doc, err = _read_plugin_catalog()
    if err is not None:
        abort(500, description=err)

    entry = next(
        (e for e in doc.get("plugins", []) if isinstance(e, dict) and e.get("id") == plugin_id),
        None,
    )
    if entry is None:
        abort(404, description=f"catalog entry '{plugin_id}' not found")

    pricing = entry.get("pricing")
    if not isinstance(pricing, dict):
        pricing = {}
    if pricing.get("model", "free") != "free":
        return jsonify({"error": "Paid plugins are not available yet."}), 402

    manifest = _read_plugins_manifest()
    if any(isinstance(p, dict) and p.get("name") == entry["id"] for p in manifest):
        abort(409, description=f"a plugin named '{entry['id']}' is already registered")

    plugin_dir = _plugins_install_dir() / entry["id"]
    plugin_dir.mkdir(parents=True, exist_ok=True)

    def _run(cmd, label, cwd=None):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=120)
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise _InstallError(f"{label} failed: {exc}", None) from exc
        if r.returncode != 0:
            raise _InstallError(f"{label} failed with exit code {r.returncode}", r.stderr or "")
        return r

    source = entry.get("source")
    if not isinstance(source, dict):
        source = {}
    try:
        if source.get("type") == "git":
            cmd = ["git", "clone"]
            if source.get("ref"):
                cmd += ["--branch", source["ref"]]
            cmd += [source["url"], str(plugin_dir)]
            _run(cmd, "git clone")
        elif source.get("type") == "npm":
            pkg = source.get("url", "")
            version = source.get("ref") or "latest"
            _run(["npm", "install", f"{pkg}@{version}"], "npm install (fetch)", cwd=str(plugin_dir))
        else:
            raise _InstallError(f"unknown source type: {source.get('type')!r}")
        # Creates node_modules symlinks the plugin contract expects.
        _run(["npm", "install"], "npm install", cwd=str(plugin_dir))
    except _InstallError as exc:
        return jsonify({"error": str(exc), "stderr": exc.stderr}), 500

    register_js = plugin_dir / "register.js"
    if not register_js.is_file():
        candidate = plugin_dir / "src" / "register.js"
        if candidate.is_file():
            register_js = candidate
        else:
            return jsonify({"error": "install failed: no register.js found in the plugin directory", "stderr": ""}), 500

    manifest.append({
        "name": entry["id"],
        "registerPath": str(register_js),
        "enabled": True,
        "description": entry.get("description", ""),
        "version": entry["version"],
        "source": entry["source"],
    })
    _write_plugins_manifest(manifest)
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True
    return jsonify({"installed": True, "name": entry["id"], "version": entry["version"], "restarted": restarted})


@plugins_bp.route("/api/plugins/marketplace")
def api_plugins_marketplace():
    """Marketplace listing: the validated catalog entries annotated with whether each
    plugin is installed and whether a newer version than the installed one is
    available. Always 200 -- an unreadable/invalid catalog means entries [] with
    catalogError set."""
    from app import _installed_plugin_version, _plugins_install_dir, _read_plugin_catalog, _read_plugins_manifest, _version_tuple
    doc, err = _read_plugin_catalog()
    manifest = _read_plugins_manifest()
    entries = []
    for raw in doc.get("plugins", []):
        if not isinstance(raw, dict):
            continue
        entry = dict(raw)
        # Match on the catalog entry's 'id' (the repo slug), which is what the installed-
        # plugins manifest stores as its 'name' -- NOT the catalog's human-readable 'name'.
        plugin_id = raw.get("id")
        installed = any(isinstance(p, dict) and p.get("name") == plugin_id for p in manifest)
        installed_version = _installed_plugin_version(manifest, plugin_id)
        update_available = bool(
            installed
            and installed_version
            and _version_tuple(raw.get("version")) > _version_tuple(installed_version)
        )
        entry["installed"] = installed
        entry["installedVersion"] = installed_version
        entry["updateAvailable"] = update_available
        entries.append(entry)
    return jsonify({
        "catalogError": err,
        "pluginsDir": str(_plugins_install_dir()),
        "entries": entries,
    })


@plugins_bp.route("/api/plugins/update", methods=["POST"])
def api_plugins_update():
    """Updates one installed plugin to the catalog's latest version: fetch/checkout the
    new source revision (or npm update), re-run npm install, record the new version +
    source in plugins.json, and restart the pipeline if it's running."""
    from app import _pipeline_running, _plugins_install_dir, _read_plugin_catalog, _read_plugins_manifest, _restart_pipeline, _run_plugin_subprocess, _version_tuple, _write_plugins_manifest
    body = request.get_json(silent=True) or {}
    plugin_id = (body.get("id") or "").strip()
    if not plugin_id:
        abort(400, description="id is required")

    doc, _err = _read_plugin_catalog()
    catalog_entry = next(
        (e for e in doc.get("plugins", []) if isinstance(e, dict) and e.get("id") == plugin_id),
        None,
    )
    if catalog_entry is None:
        abort(404, description=f"plugin '{plugin_id}' not in catalog")

    manifest = _read_plugins_manifest()
    entry = next(
        (p for p in manifest if isinstance(p, dict) and p.get("name") == plugin_id),
        None,
    )
    if entry is None:
        abort(404, description=f"plugin '{plugin_id}' not installed")

    installed_version = entry.get("version")
    new_version = catalog_entry.get("version")
    if not (new_version and _version_tuple(new_version) > _version_tuple(installed_version or "")):
        return jsonify({
            "id": plugin_id,
            "updated": False,
            "reason": "no update available",
            "installedVersion": installed_version,
            "latestVersion": new_version,
        })

    plugin_dir = _plugins_install_dir() / plugin_id
    if not plugin_dir.is_dir():
        return jsonify({
            "id": plugin_id,
            "updated": False,
            "error": f"plugin checkout not found at {plugin_dir}",
        }), 404

    source = catalog_entry.get("source") or {}
    if source.get("type") not in ("git", "npm"):
        return jsonify({
            "id": plugin_id,
            "updated": False,
            "error": f"unsupported source.type: {source.get('type')!r}",
        }), 400

    try:
        if source["type"] == "git":
            _run_plugin_subprocess(["git", "fetch", "--tags", "--prune"], plugin_dir)
            candidates = [c for c in (source.get("ref"), new_version) if c]
            checked_out = False
            for ref in candidates:
                try:
                    _run_plugin_subprocess(["git", "checkout", ref], plugin_dir)
                    checked_out = True
                    break
                except subprocess.CalledProcessError:
                    continue
            if not checked_out:
                # No usable ref/tag -- fall back to origin's default branch.
                out, _ = _run_plugin_subprocess(
                    ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], plugin_dir
                )
                default_ref = out.strip()
                if not default_ref:
                    raise subprocess.CalledProcessError(
                        1, "git checkout",
                        stderr="no source.ref, no version tag, and no origin/HEAD default",
                    )
                _run_plugin_subprocess(["git", "checkout", default_ref], plugin_dir)
        else:  # npm
            pkg = (source.get("url") or "").strip() or plugin_id
            _run_plugin_subprocess(["npm", "update", pkg], plugin_dir)
        _run_plugin_subprocess(["npm", "install"], plugin_dir)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
        detail = (getattr(e, "stderr", None) or getattr(e, "stdout", None) or str(e)).strip()
        return jsonify({
            "id": plugin_id,
            "updated": False,
            "error": "plugin update failed",
            "detail": detail,
        }), 500

    entry["version"] = new_version
    entry["source"] = source
    _write_plugins_manifest(manifest)
    restarted = False
    if _pipeline_running():
        _restart_pipeline()
        restarted = True
    return jsonify({
        "id": plugin_id,
        "updated": True,
        "installedVersion": installed_version,
        "latestVersion": new_version,
        "restarted": restarted,
    })


@plugins_bp.route("/api/plugins/<name>/ui/<path:filename>")
def api_plugin_ui_asset(name, filename):
    """Serves a .js/.css asset out of a plugin's own ui/ directory (piece 2 of the
    manifest-driven dashboard tab; Docs/hub-tasks-extraction-plan.md section 5). This is
    how a plugin's tab content reaches the browser without an iframe: the tab-bar merge
    (a later piece) points the dashboard at this route for `tab.script`, and a plugin may
    load further same-origin assets (additional scripts, a stylesheet) from here too.
    Containment and file-type checks live in `_resolve_plugin_ui_asset`."""
    from app import _resolve_plugin_ui_asset
    path, error, status = _resolve_plugin_ui_asset(name, filename)
    if error:
        abort(status, description=error)
    mimetype = "text/css" if path.suffix == ".css" else "application/javascript"
    return send_file(path, mimetype=mimetype, max_age=0)


@plugins_bp.route("/api/plugins/select-slot", methods=["POST"])
def api_plugins_select_slot():
    from app import _read_plugins_manifest, _wait_for_plugin_health, _write_plugins_manifest
    # One-click switch for a slotted plugin (e.g. "hardware-tab"): stops whichever
    # same-slot entry is currently active (if different), starts the newly selected
    # one, and persists exactly one active:true per slot -- name omitted/None is the
    # explicit "None (stop monitoring)" state, leaving the slot with nothing active.
    body = request.get_json(silent=True) or {}
    slot = (body.get("slot") or "").strip()
    name = body.get("name") or None
    manifest = _read_plugins_manifest()
    for p in manifest:
        if p.get("slot") == slot and p.get("active") and p.get("name") != name:
            plugin_process_manager.stop(p["name"])
            p["active"] = False
    started = healthy = False
    if name:
        target = next((p for p in manifest if p.get("name") == name and p.get("slot") == slot), None)
        if target is None:
            abort(404, description=f"no plugin named '{name}' in slot '{slot}'")
        started = plugin_process_manager.start(target)
        target["active"] = started
        if started:
            healthy = _wait_for_plugin_health(target)
    _write_plugins_manifest(manifest)
    return jsonify({"slot": slot, "name": name, "started": started, "healthy": healthy})
