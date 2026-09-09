#!/usr/bin/env python3
"""Deterministic Flask-Blueprint extraction for one file-decompose move.

The mechanical half of a `kind: flask-blueprint` move -- what the local 27B keeps
failing to do (it burns its whole turn budget orienting on a large app.py and runs
out before the edits: see the app.py blueprint hub, 2026-09-09). This is 100%
mechanical:

  * pull each named `@app.route`-decorated view function OUT of the source, VERBATIM
  * rewrite only its `@app.route(...)` / `@app.<verb>(...)` decorator to
    `@<bp>.route(...)` (path + methods untouched -- decompose-integration-gate.js's
    url_map invariant then holds by construction)
  * give each moved view a lazy `from app import <the app.py names it reads>` as its
    first body statement (after the docstring) -- a top-level back-import is the
    circular-import hazard, since app.py imports this module to register the blueprint
  * assemble the new module: flask import + the stdlib/3rd-party import lines the
    moved code needs + `<bp> = Blueprint("<slug>", __name__)` + the functions
  * the reduced source is the original minus those exact spans

    decompose-blueprint-extract.py <source.py> <bp_var> <bp_slug> <sym1> [<sym2> ...]

Output: one JSON object on stdout.
  { "ok": true, "newFileContent": "...", "reducedSource": "...", "sharedDeps": {...} }
  { "ok": false, "problems": ["..."] }
Exit 0 whenever the file parsed; exit 2 only if it could not be read/parsed.
"""

import ast
import builtins
import json
import sys

BUILTIN_NAMES = set(dir(builtins))
FLASK_NAMES = {
    "abort", "jsonify", "request", "Response", "redirect", "url_for", "send_file",
    "send_from_directory", "make_response", "current_app", "session", "g",
    "stream_with_context", "render_template", "render_template_string",
}
ROUTE_DECORATOR_PREFIXES = ("@app.route", "@app.get", "@app.post", "@app.put",
                            "@app.delete", "@app.patch")


def decorator_is_app_route(dec):
    target = dec.func if isinstance(dec, ast.Call) else dec
    return (isinstance(target, ast.Attribute)
            and isinstance(target.value, ast.Name)
            and target.value.id == "app"
            and target.attr in ("route", "get", "post", "put", "delete", "patch"))


def is_route_decorator_line(stripped):
    return any(stripped.startswith(p + "(") or stripped == p for p in ROUTE_DECORATOR_PREFIXES) \
        or stripped.startswith("@app.route ")


def span(node):
    lo = node.decorator_list[0].lineno if node.decorator_list else node.lineno
    return lo, node.end_lineno


def fail(problems):
    print(json.dumps({"ok": False, "problems": problems}))


def main(argv):
    if len(argv) < 5:
        fail(["usage: decompose-blueprint-extract.py <source.py> <bp_var> <bp_slug> <sym>..."])
        return 2
    path, bp_var, bp_slug, symbols = argv[1], argv[2], argv[3], argv[4:]
    try:
        src = open(path, "r", encoding="utf-8").read()
        tree = ast.parse(src, filename=path)
    except (OSError, SyntaxError, ValueError) as exc:
        fail([f"{type(exc).__name__}: {exc}"])
        return 2
    lines = src.split("\n")

    module_funcs, module_names = {}, set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            module_funcs.setdefault(node.name, node)
            module_names.add(node.name)
        elif isinstance(node, ast.ClassDef):
            module_names.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    module_names.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            module_names.add(node.target.id)

    problems, moved = [], []
    for s in symbols:
        n = module_funcs.get(s)
        if n is None:
            problems.append(f"{s}: not a module-level function")
        else:
            moved.append(n)
    if problems:
        fail(problems)
        return 0
    # A blueprint move must carry at least one actual route (helpers may ride along, but a
    # blueprint with zero @app.route views is a nonsense split).
    if not any(any(decorator_is_app_route(d) for d in n.decorator_list) for n in moved):
        fail([f"none of {', '.join(symbols)} is an @app.route view -- not a blueprint move"])
        return 0

    moved_names = {n.name for n in moved}
    moved_lines = set()
    for n in moved:
        lo, hi = span(n)
        moved_lines.update(range(lo, hi + 1))

    strays = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in moved_names and node.lineno not in moved_lines:
            strays.setdefault(node.id, []).append(node.lineno)
    if strays:
        fail([f"{s} is still referenced at line(s) {sorted(set(v))} outside the moved routes"
              for s, v in strays.items()])
        return 0

    import_line_for = {}
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            line = "\n".join(lines[node.lineno - 1:node.end_lineno])
            for a in node.names:
                bound = a.asname or a.name
                if isinstance(node, ast.Import):
                    bound = bound.split(".")[0]
                import_line_for[bound] = line

    shared_deps = {}
    needed_import_lines, seen = [], set()
    flask_used = set()
    for n in moved:
        local_bound, read = set(), set()
        # Walk the BODY only, not decorator_list -- `@app.route` is rewritten to
        # `@<bp>.route`, so `app` from the decorator must not count as a body dependency.
        for stmt in n.body:
            for sub in ast.walk(stmt):
                if isinstance(sub, ast.Name):
                    (local_bound if isinstance(sub.ctx, ast.Store) else read).add(sub.id)
                elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    local_bound.add(sub.name)
                elif isinstance(sub, ast.arg):
                    local_bound.add(sub.arg)
        for a in n.args.args + n.args.posonlyargs + n.args.kwonlyargs:
            local_bound.add(a.arg)
        if n.args.vararg:
            local_bound.add(n.args.vararg.arg)
        if n.args.kwarg:
            local_bound.add(n.args.kwarg.arg)
        shared_deps[n.name] = sorted(
            x for x in read
            if x in module_names and x not in moved_names
            and x not in local_bound and x not in BUILTIN_NAMES and x != "app")
        for x in sorted(read):
            if x in FLASK_NAMES:
                flask_used.add(x)
            elif x in import_line_for and x not in local_bound and x not in BUILTIN_NAMES:
                il = import_line_for[x]
                if il not in seen:
                    seen.add(il)
                    needed_import_lines.append(il)

    all_deps = sorted({d for ds in shared_deps.values() for d in ds})
    flask_import = "from flask import Blueprint"
    if flask_used:
        flask_import += ", " + ", ".join(sorted(flask_used))

    header = [flask_import]
    if needed_import_lines:
        header.append("")
        header.extend(needed_import_lines)
    header += [
        "",
        f"# The app.py helpers these views call ({', '.join(all_deps) or 'none'}) are",
        "# imported lazily inside each view: app.py imports THIS module to register the",
        "# blueprint, so a top-level `from app import ...` is a circular import that only",
        "# fails when app.py is the entrypoint (how the dashboard runs). By the time a view",
        "# runs, app.py is fully initialised and the import is just a dict lookup. (Same",
        "# pattern as routes/concepts.py, routes/second_brain.py, routes/reports.py.)",
        "",
        f'{bp_var} = Blueprint("{bp_slug}", __name__)',
        "",
        "",
    ]

    fn_texts = []
    for n in moved:
        lo, hi = span(n)
        body = lines[lo - 1:hi]
        out = []
        for bl in body:
            stripped = bl.lstrip()
            if is_route_decorator_line(stripped):
                indent = bl[:len(bl) - len(stripped)]
                bl = indent + "@" + bp_var + stripped[len("@app"):]
            out.append(bl)
        def_idx = next(i for i, x in enumerate(out)
                       if x.lstrip().startswith(("def ", "async def ")))
        insert_at = def_idx + 1
        fb = n.body[0] if n.body else None
        if (isinstance(fb, ast.Expr) and isinstance(getattr(fb, "value", None), ast.Constant)
                and isinstance(fb.value.value, str)):
            insert_at = (fb.end_lineno - lo) + 1
        deps = shared_deps[n.name]
        if deps:
            out = out[:insert_at] + [f"    from app import {', '.join(deps)}"] + out[insert_at:]
        fn_texts.append("\n".join(out))

    new_content = "\n".join(header) + "\n\n\n".join(fn_texts) + "\n"

    spans = sorted((span(n) for n in moved), reverse=True)
    red = lines[:]
    for lo, hi in spans:
        end = hi
        while end < len(red) and red[end].strip() == "":
            end += 1
        del red[lo - 1:end]
    reduced = "\n".join(red)
    while "\n\n\n\n" in reduced:
        reduced = reduced.replace("\n\n\n\n", "\n\n\n")

    print(json.dumps({
        "ok": True,
        "newFileContent": new_content,
        "reducedSource": reduced,
        "sharedDeps": shared_deps,
        "movedCount": len(moved),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
