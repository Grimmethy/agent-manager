'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweep, notePath, CONTEXT_LOG_SUBDIR } = require('./context-log-sweep.js');
const { writeContextLogInbox } = require('./context-log-marker.js');

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-log-sweep-'));
  return dir;
}

function tmpSecondBrain() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'context-log-sweep-sb-'));
}

test('a new entry with no taskRef creates the session note on first write, no wikilink suffix', async () => {
  const pipelineDir = tmpPipeline();
  const secondBrainDir = tmpSecondBrain();
  writeContextLogInbox({ summary: 'Discussed general repo structure.' }, { sessionId: 'chat-1-abc', pipelineDir });

  const s = await sweep({ pipelineDir, repoRoot: pipelineDir, secondBrainDir });
  assert.equal(s.scanned, 1);
  assert.equal(s.appended, 1);
  assert.equal(s.errors, 0);

  const dest = notePath(secondBrainDir, 'chat-1-abc');
  assert.ok(fs.existsSync(dest));
  const content = fs.readFileSync(dest, 'utf8');
  assert.match(content, /# chat-1-abc/);
  assert.match(content, /Discussed general repo structure\./);
  assert.doesNotMatch(content, /\[\[/);
});

test('a second entry for the same session APPENDS to the existing note rather than overwriting it', async () => {
  const pipelineDir = tmpPipeline();
  const secondBrainDir = tmpSecondBrain();
  writeContextLogInbox({ summary: 'First exchange summary.' }, { sessionId: 'chat-2-def', pipelineDir });
  await sweep({ pipelineDir, repoRoot: pipelineDir, secondBrainDir });

  writeContextLogInbox({ summary: 'Second exchange summary.' }, { sessionId: 'chat-2-def', pipelineDir });
  await sweep({ pipelineDir, repoRoot: pipelineDir, secondBrainDir });

  const content = fs.readFileSync(notePath(secondBrainDir, 'chat-2-def'), 'utf8');
  assert.match(content, /First exchange summary\./);
  assert.match(content, /Second exchange summary\./);
});

test('a taskRef that resolves to a real task gets a [[project]] wikilink + backtick-quoted task id', async () => {
  const pipelineDir = tmpPipeline();
  const secondBrainDir = tmpSecondBrain();
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'pending', 'adhoc-real-task-1.json'), JSON.stringify({ id: 'adhoc-real-task-1' }));
  writeContextLogInbox({ summary: 'Unstuck a task.', taskRef: 'adhoc-real-task-1' }, { sessionId: 'chat-3-ghi', pipelineDir });

  const repoRoot = path.join(path.dirname(pipelineDir), 'agent-manager');
  await sweep({ pipelineDir, repoRoot, secondBrainDir });

  const content = fs.readFileSync(notePath(secondBrainDir, 'chat-3-ghi'), 'utf8');
  assert.match(content, /\[\[agent-manager\]\]/);
  assert.match(content, /`adhoc-real-task-1`/);
});

test('a taskRef that does NOT resolve to a real task is omitted entirely, never guessed at', async () => {
  const pipelineDir = tmpPipeline();
  const secondBrainDir = tmpSecondBrain();
  writeContextLogInbox({ summary: 'Discussed something.', taskRef: 'adhoc-does-not-exist' }, { sessionId: 'chat-4-jkl', pipelineDir });

  await sweep({ pipelineDir, repoRoot: pipelineDir, secondBrainDir });

  const content = fs.readFileSync(notePath(secondBrainDir, 'chat-4-jkl'), 'utf8');
  assert.doesNotMatch(content, /\[\[/);
  assert.doesNotMatch(content, /adhoc-does-not-exist/);
});

test('sweep is a cheap no-op when the inbox is empty', async () => {
  const pipelineDir = tmpPipeline();
  const secondBrainDir = tmpSecondBrain();
  const s = await sweep({ pipelineDir, repoRoot: pipelineDir, secondBrainDir });
  assert.equal(s.scanned, 0);
  assert.equal(s.appended, 0);
});

test('sweep is a no-op (fails open) when secondBrainDir is not configured', async () => {
  const pipelineDir = tmpPipeline();
  writeContextLogInbox({ summary: 'x' }, { sessionId: 'chat-5', pipelineDir });
  const s = await sweep({ pipelineDir, repoRoot: pipelineDir, secondBrainDir: null });
  assert.equal(s.scanned, 0);
  assert.equal(s.appended, 0);
});

test('inbox files are cleaned up after a real (non-dry-run) sweep, preserved on a dry run', async () => {
  const pipelineDir = tmpPipeline();
  const secondBrainDir = tmpSecondBrain();
  writeContextLogInbox({ summary: 'x' }, { sessionId: 'chat-6', pipelineDir });
  const inbox = path.join(pipelineDir, 'queue', 'context-log-inbox');

  const dry = await sweep({ pipelineDir, repoRoot: pipelineDir, secondBrainDir, dryRun: true });
  assert.equal(dry.wouldAppend.length, 1);
  assert.equal(fs.readdirSync(inbox).length, 1, 'dry run must not touch the inbox');
  assert.equal(fs.existsSync(notePath(secondBrainDir, 'chat-6')), false, 'dry run must not write the note');

  await sweep({ pipelineDir, repoRoot: pipelineDir, secondBrainDir });
  assert.equal(fs.readdirSync(inbox).length, 0);
});

test('honors AGENT_MANAGER_CONTEXT_LOG_SWEEP=false kill switch', async () => {
  const pipelineDir = tmpPipeline();
  const secondBrainDir = tmpSecondBrain();
  writeContextLogInbox({ summary: 'x' }, { sessionId: 'chat-7', pipelineDir });
  const prior = process.env.AGENT_MANAGER_CONTEXT_LOG_SWEEP;
  process.env.AGENT_MANAGER_CONTEXT_LOG_SWEEP = 'false';
  try {
    const s = await sweep({ pipelineDir, repoRoot: pipelineDir, secondBrainDir });
    assert.equal(s.scanned, 0);
    assert.equal(fs.existsSync(notePath(secondBrainDir, 'chat-7')), false);
  } finally {
    if (prior === undefined) delete process.env.AGENT_MANAGER_CONTEXT_LOG_SWEEP;
    else process.env.AGENT_MANAGER_CONTEXT_LOG_SWEEP = prior;
  }
});

test('CONTEXT_LOG_SUBDIR is the machine-written report path convention', () => {
  assert.equal(CONTEXT_LOG_SUBDIR, path.join('Agent Manager Reports', 'Chat Context Logs'));
});
