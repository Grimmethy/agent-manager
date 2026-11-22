'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shouldRestore, restoreRecord, restoreEnabled } = require('./shared-branch-restore.js');
const { recordBranchRemoval } = require('./branch-removal-ledger.js');

const BR = 'agent/decompose-hub-1791297583352';
const LINES = [
  'export function StartPage({ onLogin }: { onLogin?: (token: string) => void }) {',
  'const data = await r2.json(); if (data?.token && mounted) { onLogin?.(data.token); }',
  'const handleRegisterSuccess = (token: string) => { onLogin?.(token); toast({ title: "ok" }); };',
  'const handleGoogleSuccess = async (cred: string) => { const r = await googleLogin(cred); onLogin?.(r.token); };',
  'const handleLoginSubmit = async () => { const res = await login(email, pass); onLogin?.(res.token); };',
];
const DIFF = `diff --git a/src/StartPage.tsx b/src/StartPage.tsx\n--- a/src/StartPage.tsx\n+++ b/src/StartPage.tsx\n@@ -1,1 +1,5 @@\n${LINES.map((l) => `+${l}`).join('\n')}\n`;
function pipeline() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbr-'));
  for (const s of ['done', 'approved', 'pending', 'adhoc', 'review', 'blocked']) fs.mkdirSync(path.join(d, 'queue', s), { recursive: true });
  return d;
}
const record = (over = {}) => ({
  id: 'HUB0018-01', stacked: { branch: BR, seq: 1, total: 2 }, rawDiff: DIFF, terminalDisposition: 'abandoned', status: 'done',
  history: [{ stage: 'applied', at: '2026-10-07T07:20:18Z', detail: BR }, { stage: 'abandoned', at: '2026-10-07T20:39:01Z', detail: 'branch gone' }], ...over,
});
// fake git: branch exists + ahead, log returns the branch commits' bodies, show returns file text per ref
// By default both main and the shared branch HAVE the file, with its pre-change content (the sibling's lines are simply not in it).
const git = ({ exists = true, ahead = '1', bodies = 'x\n\nTask: HUB0022-01 (adhoc/manual)\n', files = {} } = {}) => (_r, args) => {
  if (args[0] === 'rev-parse') return exists ? 'sha' : '';
  if (args[0] === 'rev-list') return ahead;
  if (args[0] === 'log') return bodies;
  if (args[0] === 'show') return { 'origin/master:src/StartPage.tsx': 'export function StartPage() {}\n', [`origin/${BR}:src/StartPage.tsx`]: 'export function StartPage() {}\n', ...files }[args[1]] || '';
  return '';
};
const removedBy = (d, taskId = 'HUB0022-01', at = '2026-10-07T19:57:37Z') => recordBranchRemoval(d, { branch: BR, taskId, cause: 'superseded-by-requeue', detail: 'requeued from done/', actor: 'dashboard-requeue', now: new Date(at) });
const decide = (d, rec, g = git()) => shouldRestore(rec, { pipelineDir: d, repoRoot: '/r', mainBranch: 'master', git: g });

test('the HUB0018-01 incident shape is restored: collateral of another task\'s requeue, branch back and ahead, its change on neither branch nor main', () => {
  const d = pipeline(); removedBy(d);
  assert.deepEqual(decide(d, record()), { restore: true, branch: BR, removedBy: 'HUB0022-01' });
});

test('not restored: the branch was removed by the task\'s OWN requeue, by a discard, before the apply, or there is no ledger entry', () => {
  let d = pipeline(); removedBy(d, 'HUB0018-01');
  assert.match(decide(d, record()).reason, /own requeue/);
  d = pipeline(); recordBranchRemoval(d, { branch: BR, taskId: 'HUB0022-01', cause: 'discarded', actor: 'dashboard' });
  assert.match(decide(d, record()).reason, /not removed by a requeue/);
  d = pipeline(); removedBy(d, 'HUB0022-01', '2026-10-07T05:00:00Z');
  assert.match(decide(d, record()).reason, /predates/);
  assert.match(decide(pipeline(), record()).reason, /not removed by a requeue/);
});

test('not restored: the branch is gone or not ahead, the change is carried (trailer), already on main, or the evidence is too thin', () => {
  const d = pipeline(); removedBy(d);
  assert.match(decide(d, record(), git({ exists: false })).reason, /does not exist on origin/);
  assert.match(decide(d, record(), git({ ahead: '0' })).reason, /not ahead/);
  assert.match(decide(d, record(), git({ bodies: 'x\n\nTask: HUB0018-01 (adhoc/manual)\n' })).reason, /carried/);
  assert.match(decide(d, record(), git({ files: { 'origin/master:src/StartPage.tsx': LINES.join('\n') } })).reason, /already on master/);
  assert.match(decide(d, record({ rawDiff: DIFF.split('\n').slice(0, 7).join('\n') })).reason, /not enough evidence/);
});

test('not restored: not stacked, no stored diff, or already restored once', () => {
  const d = pipeline(); removedBy(d);
  assert.match(decide(d, record({ stacked: undefined })).reason, /not stacked/);
  assert.match(decide(d, record({ rawDiff: '' })).reason, /no stored diff/);
  assert.match(decide(d, record({ sharedBranchRestored: { at: 'x' } })).reason, /already restored/);
  assert.equal(decide(d, null).restore, false);
});

test('restoreRecord writes the task to approved/ with the terminal state cleared, a history event and a once-only mark, and removes the done copy', () => {
  const d = pipeline(); removedBy(d);
  const rec = record();
  const doneFile = path.join(d, 'queue', 'done', `${rec.id}.json`);
  fs.writeFileSync(doneFile, JSON.stringify(rec));
  assert.equal(restoreRecord(rec, { branch: BR, removedBy: 'HUB0022-01' }, { pipelineDir: d, doneFile, now: new Date('2026-10-08T01:00:00Z') }), true);
  const out = JSON.parse(fs.readFileSync(path.join(d, 'queue', 'approved', `${rec.id}.json`), 'utf8'));
  assert.equal(out.status, 'approved');
  assert.equal(out.terminalDisposition, undefined);
  assert.equal(out.rawDiff, DIFF, 'the approved diff is kept exactly');
  assert.deepEqual(out.sharedBranchRestored, { at: '2026-10-08T01:00:00.000Z', branch: BR, removedBy: 'HUB0022-01' });
  assert.match(out.history.at(-1).detail, /destroyed when HUB0022-01 was requeued/);
  assert.equal(fs.existsSync(doneFile), false);
});

test('restoreRecord refuses when an active copy of the task already exists anywhere in the queue', () => {
  for (const state of ['approved', 'pending', 'adhoc', 'review', 'blocked']) {
    const d = pipeline(); const rec = record();
    const doneFile = path.join(d, 'queue', 'done', `${rec.id}.json`);
    fs.writeFileSync(doneFile, JSON.stringify(rec));
    fs.writeFileSync(path.join(d, 'queue', state, `${rec.id}.json`), '{}');
    assert.equal(restoreRecord(rec, { branch: BR, removedBy: 'x' }, { pipelineDir: d, doneFile }), false, state);
    assert.equal(fs.existsSync(doneFile), true, `${state}: the done copy stays`);
  }
});

test('the kill switch AGENT_MANAGER_SHARED_BRANCH_RESTORE=false disables it', () => {
  assert.equal(restoreEnabled({}), true);
  assert.equal(restoreEnabled({ AGENT_MANAGER_SHARED_BRANCH_RESTORE: 'false' }), false);
  assert.equal(restoreEnabled({ AGENT_MANAGER_SHARED_BRANCH_RESTORE: 'FALSE' }), false);
});
