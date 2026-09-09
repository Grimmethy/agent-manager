'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const {
  buildBlueprintExtraction,
  buildBlueprintOnePassChanges,
  planIsFullyMechanicalBlueprint,
  spliceRegistrations,
  blueprintSlug,
} = require('./decompose-flask-blueprint.js');

function pyOk() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const PY = pyOk();

const APP2 = [
  "import json",
  "from flask import Flask, request, jsonify, abort",
  "",
  "app = Flask(__name__)",
  "",
  "SHARED_STATE = {}",
  "",
  "",
  "def _helper(x):",
  "    return x * 2",
  "",
  "",
  "@app.route('/api/widget')",
  "def api_widget_list():",
  '    """List widgets."""',
  "    return jsonify(sorted(SHARED_STATE))",
  "",
  "",
  "@app.route('/api/widget/<wid>', methods=['POST'])",
  "def api_widget_create(wid):",
  "    body = request.get_json(silent=True) or {}",
  "    if not body:",
  "        abort(400)",
  "    SHARED_STATE[wid] = _helper(len(body))",
  "    return jsonify({'id': wid})",
  "",
  "",
  "@app.route('/api/other')",
  "def api_other():",
  "    return jsonify({'ok': True})",
  "",
  "",
  'if __name__ == "__main__":',
  "    app.run()",
  "",
].join('\n');

test('blueprintSlug: _ -> -', () => {
  assert.equal(blueprintSlug('widget_bp'), 'widget-bp');
  assert.equal(blueprintSlug('brain_dump_bp'), 'brain-dump-bp');
});

test('buildBlueprintExtraction: 2 route views -> new module + reduced source, decorator rewritten, lazy imports injected', { skip: !PY }, () => {
  const r = buildBlueprintExtraction(APP2, 'python/dashboard/app.py', 'python/dashboard/routes/widget.py', 'widget_bp',
    ['api_widget_list', 'api_widget_create']);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  const [create, edit] = r.changes;
  assert.equal(create.file, 'python/dashboard/routes/widget.py');
  assert.match(create.content, /^from flask import Blueprint/);
  assert.match(create.content, /widget_bp = Blueprint\("widget-bp", __name__\)/);
  assert.match(create.content, /@widget_bp\.route\('\/api\/widget'\)/);
  assert.match(create.content, /@widget_bp\.route\('\/api\/widget\/<wid>', methods=\['POST'\]\)/);
  assert.doesNotMatch(create.content, /@app\.route/);
  // lazy imports: SHARED_STATE + _helper are app.py module scope, referenced by the views
  assert.match(create.content, /from app import .*SHARED_STATE/);
  assert.match(create.content, /from app import .*_helper/);
  assert.doesNotMatch(create.content, /from app import app\b/); // decorator target, not a body dep
  // docstring case: lazy import goes AFTER the docstring
  assert.match(create.content, /"""List widgets\."""\n\s+from app import/);

  assert.equal(edit.file, 'python/dashboard/app.py');
  assert.equal(edit.find, APP2);
  assert.doesNotMatch(edit.replace, /def api_widget_list/);
  assert.doesNotMatch(edit.replace, /def api_widget_create/);
  assert.match(edit.replace, /def api_other/); // untouched
  assert.match(edit.replace, /def _helper/);   // untouched
});

test('buildBlueprintOnePassChanges: wires register_blueprint + import, output py_compiles', { skip: !PY }, () => {
  const r = buildBlueprintOnePassChanges(APP2, 'python/dashboard/app.py', [
    { newFile: 'python/dashboard/routes/widget.py', blueprint: 'widget_bp', symbols: ['api_widget_list', 'api_widget_create'] },
  ]);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  const edit = r.changes[r.changes.length - 1];
  assert.match(edit.replace, /from routes\.widget import widget_bp/);
  assert.match(edit.replace, /app\.register_blueprint\(widget_bp\)/);
  // register block spliced before the __main__ guard
  assert.ok(edit.replace.indexOf('register_blueprint(widget_bp)') < edit.replace.indexOf('if __name__'));
});

test('buildBlueprintOnePassChanges: a helper rides along with its route (not required to be a route itself)', { skip: !PY }, () => {
  // api_widget_create + _helper move together; api_widget_list stays. Nothing outside the
  // moved set references either -> self-contained -> ok.
  const r = buildBlueprintOnePassChanges(APP2, 'python/dashboard/app.py', [
    { newFile: 'python/dashboard/routes/x.py', blueprint: 'x_bp', symbols: ['api_widget_create', '_helper'] },
  ]);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.match(r.changes[0].content, /def _helper\(x\):/);
  assert.match(r.changes[0].content, /@x_bp\.route\('\/api\/widget\/<wid>'/);
});

test('buildBlueprintOnePassChanges: BLOCKS a plan with NO actual @app.route view', { skip: !PY }, () => {
  const r = buildBlueprintOnePassChanges(APP2, 'python/dashboard/app.py', [
    { newFile: 'python/dashboard/routes/x.py', blueprint: 'x_bp', symbols: ['_helper'] }, // just a helper, zero routes
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no @app\.route view|not a blueprint move|still referenced/i);
});

test('buildBlueprintOnePassChanges: BLOCKS when a moved view is still called elsewhere', { skip: !PY }, () => {
  const app = APP2.replace('def api_other():', 'def api_other():\n    api_widget_list()  # stray call');
  const r = buildBlueprintOnePassChanges(app, 'python/dashboard/app.py', [
    { newFile: 'python/dashboard/routes/w.py', blueprint: 'w_bp', symbols: ['api_widget_list'] },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /still referenced|outside the moved routes/i);
});

test('buildBlueprintExtraction: rejects a non-.py source/target', () => {
  assert.equal(buildBlueprintExtraction('x', 'app.js', 'r.py', 'bp', ['a']).ok, false);
  assert.equal(buildBlueprintExtraction('x', 'app.py', 'r.js', 'bp', ['a']).ok, false);
  assert.equal(buildBlueprintExtraction('x', 'app.py', 'r.py', 'bp', []).ok, false);
});

test('planIsFullyMechanicalBlueprint: needs a .py source, every move flask-blueprint w/ blueprint var + blueprintApplyOk', () => {
  const req = { sourceFile: 'python/dashboard/app.py', moves: [{ kind: 'flask-blueprint', blueprint: 'a_bp' }, { kind: 'flask-blueprint', blueprint: 'b_bp' }] };
  const okVal = { moveMeta: [{ blueprintApplyOk: true }, { blueprintApplyOk: true }] };
  assert.equal(planIsFullyMechanicalBlueprint(req, okVal), true);
  assert.equal(planIsFullyMechanicalBlueprint({ ...req, sourceFile: 'a.js' }, okVal), false);
  assert.equal(planIsFullyMechanicalBlueprint({ ...req, moves: [{ kind: 'flask-blueprint', blueprint: 'a_bp' }, { kind: 'script-extract' }] }, okVal), false);
  assert.equal(planIsFullyMechanicalBlueprint(req, { moveMeta: [{ blueprintApplyOk: true }, {}] }), false);
  const prev = process.env.AGENT_MANAGER_DECOMPOSE_BLUEPRINT;
  process.env.AGENT_MANAGER_DECOMPOSE_BLUEPRINT = 'false';
  try { assert.equal(planIsFullyMechanicalBlueprint(req, okVal), false); }
  finally { if (prev === undefined) delete process.env.AGENT_MANAGER_DECOMPOSE_BLUEPRINT; else process.env.AGENT_MANAGER_DECOMPOSE_BLUEPRINT = prev; }
});

test('spliceRegistrations: appends after the last existing app.register_blueprint(...) cluster', () => {
  const reduced = [
    "app = Flask(__name__)",
    "",
    "from routes.reports import reports_bp  # noqa: E402",
    "",
    "app.register_blueprint(reports_bp)",
    "",
    'if __name__ == "__main__":',
    "    app.run()",
  ].join('\n');
  const out = spliceRegistrations(reduced, 'python/dashboard/app.py', [
    { newFile: 'python/dashboard/routes/widget.py', blueprint: 'widget_bp' },
  ]);
  assert.match(out, /from routes\.reports import reports_bp[\s\S]*from routes\.widget import widget_bp/);
  assert.match(out, /app\.register_blueprint\(reports_bp\)\napp\.register_blueprint\(widget_bp\)/);
  assert.ok(out.indexOf('register_blueprint(widget_bp)') < out.indexOf('if __name__'));
});
