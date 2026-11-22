'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { wireDecomposedBlueprints, buildBlock, spliceBlock, appBoundAboveSplice } = require('../src/wire-decomposed-blueprints.js');

const SOURCE = 'python/dashboard/app.py';
const MOVES = [{ newFile: 'python/dashboard/routes/hardware.py', blueprint: 'hardware_bp', kind: 'flask-blueprint' }];

test('binding above the __main__ guard is detected', () => {
  const text = 'from flask import Flask\napp = Flask(__name__)\n\nif __name__ == "__main__":\n    app.run()\n';
  assert.strictEqual(appBoundAboveSplice(text), true);
  const out = spliceBlock(text, buildBlock(MOVES, SOURCE));
  assert.ok(out.indexOf('app.register_blueprint(hardware_bp)') < out.indexOf('if __name__'));
});

test('binding only below the __main__ guard is rejected', () => {
  const text = 'from flask import Flask\n\nif __name__ == "__main__":\n    app.run()\n\napp = Flask(__name__)\n';
  assert.strictEqual(appBoundAboveSplice(text), false);
});

test('no guard and no app binding is rejected', () => {
  assert.strictEqual(appBoundAboveSplice('x = 1\n'), false);
});

test('no guard but binding present is accepted', () => {
  assert.strictEqual(appBoundAboveSplice('app = Flask(__name__)\n'), true);
});

test('wireDecomposedBlueprints returns ok:false naming the file, without throwing or writing', () => {
  const original = 'from flask import Flask\n\nif __name__ == "__main__":\n    app.run()\n\napp = Flask(__name__)\n';
  const exec = (file, args) => {
    if (args[0] === 'worktree' && args[1] === 'add') {
      const wt = args[2];
      fs.mkdirSync(path.join(wt, path.dirname(SOURCE)), { recursive: true });
      fs.writeFileSync(path.join(wt, SOURCE), original);
    }
    return '';
  };
  const res = wireDecomposedBlueprints({ repoRoot: os.tmpdir(), branch: 'agent/x', sourceFile: SOURCE, moves: MOVES, exec });
  assert.strictEqual(res.ok, false);
  assert.match(res.detail, /python\/dashboard\/app\.py/);
  assert.match(res.detail, /app = Flask/);
});
