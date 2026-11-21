'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadDenylist, scanText } = require('./denylist');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function fixture(content, name) {
  const p = path.join(tmp, `${name || 'list'}-${counter++}.txt`);
  fs.writeFileSync(p, content);
  return p;
}

function rulesOf(content) {
  return loadDenylist(fixture(content)).rules;
}

function scan(text, listContent, label) {
  return scanText(text, rulesOf(listContent), label || 'test-label');
}

const SAME_LINE_LIST = 'client|Zorblax|[CLIENT]\nclient|Vexmart|[VEX]\nallow|Vexmart\n';

test('same line still reports: deny hit next to an allowed term', () => {
  const r = scan('Vexmart Zorblax', SAME_LINE_LIST, 'same-line');
  assert.deepStrictEqual(r.matches.map((m) => m.term), ['Zorblax']);
  assert.deepStrictEqual(r.dismissed.map((d) => d.term), ['Vexmart']);
  assert.strictEqual(r.dismissed[0].file, 'same-line');
  assert.strictEqual(r.dismissed[0].line, 1);
  assert.strictEqual(r.stats.matched, 1);
  assert.strictEqual(r.stats.dismissedByAllow, r.dismissed.length);
});

test('same line still reports: reversed order', () => {
  const r = scan('Zorblax Vexmart', SAME_LINE_LIST);
  assert.deepStrictEqual(r.matches.map((m) => m.term), ['Zorblax']);
  assert.deepStrictEqual(r.dismissed.map((d) => d.term), ['Vexmart']);
});

test('allowed term alone yields no match and one dismissal', () => {
  const r = scan('Vexmart', SAME_LINE_LIST);
  assert.strictEqual(r.matches.length, 0);
  assert.strictEqual(r.dismissed.length, 1);
});

test('dismissal records the line number on later lines', () => {
  const r = scan('Zorblax\nnothing\nVexmart', SAME_LINE_LIST, 'lbl');
  assert.strictEqual(r.matches[0].line, 1);
  assert.strictEqual(r.dismissed[0].line, 3);
  assert.strictEqual(r.dismissed[0].file, 'lbl');
});

test('plurals: trailing s matches, other suffixes do not', () => {
  const list = 'client|Zorblax|[CLIENT]\n';
  assert.strictEqual(scan('Zorblax', list).matches.length, 1);
  assert.strictEqual(scan('Zorblaxs', list).matches.length, 1);
  assert.strictEqual(scan('Zorblaxish', list).matches.length, 0);
  assert.strictEqual(scan('aZorblax', list).matches.length, 0);
});

test('possessives: straight and curly apostrophe', () => {
  const list = 'client|Zorblax|[CLIENT]\n';
  assert.strictEqual(scan("Zorblax's plan", list).matches.length, 1);
  assert.strictEqual(scan('Zorblax\u2019s plan', list).matches.length, 1);
});

test('initials: J.W.C. and J. W. C. both match JWC-style rule', () => {
  const list = 'person|J. W. C.|[PERSON]\n';
  assert.strictEqual(scan('by J.W.C. today', list).matches.length, 1);
  assert.strictEqual(scan('by J. W. C. today', list).matches.length, 1);
  assert.strictEqual(scan('by J.W.D. today', list).matches.length, 0);
});

test('regex metacharacters in terms are escaped', () => {
  const list = 'secret|Quendal+(x)|[SECRET]\n';
  assert.doesNotThrow(() => scan('x', list));
  assert.strictEqual(scan('use Quendal+(x) here', list).matches.length, 1);
  assert.strictEqual(scan('use Quendalllx here', list).matches.length, 0);
});

test('missing file returns present false', () => {
  const r = loadDenylist(path.join(tmp, 'nope.txt'));
  assert.deepStrictEqual(r, { present: false, rules: [] });
});

test('malformed line throws with file label and line number', () => {
  const p = fixture('# header\n\nclient|Zorblax\n', 'bad');
  assert.throws(() => loadDenylist(p), (err) => {
    assert.ok(err.message.includes(p), err.message);
    assert.match(err.message, /:3:/);
    return true;
  });
});

test('unknown kind throws with file label and line number', () => {
  const p = fixture('client|Zorblax|[C]\nclient|Quendal|[Q]\nbogus|Vexmart|[V]\n', 'kind');
  assert.throws(() => loadDenylist(p), (err) => {
    assert.ok(err.message.includes(p), err.message);
    assert.match(err.message, /:3:/);
    assert.match(err.message, /unknown kind/);
    return true;
  });
});

test('CRLF input parses the same as LF', () => {
  const lf = 'client|Zorblax|[CLIENT]\nallow|Vexmart\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const a = loadDenylist(fixture(lf));
  const b = loadDenylist(fixture(crlf));
  assert.deepStrictEqual(b, a);
  assert.ok(b.rules.every((r) => !/\r/.test(r.term) && !/\r/.test(r.placeholder || '')));
});

test('BOM input is stripped so line 1 loads', () => {
  const r = loadDenylist(fixture('\uFEFFclient|Quendal|[Q]\n'));
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.rules.length, 1);
  assert.strictEqual(r.rules[0].kind, 'client');
  assert.strictEqual(r.rules[0].term, 'Quendal');
});
