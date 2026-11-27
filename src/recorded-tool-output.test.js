'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordedToolOutputText } = require('./recorded-tool-output.js');

test('renders a shell command with exit code 0', () => {
  const entries = [
    {
      stage: 'test',
      toolCallLog: [
        {
          tool: 'shell',
          args: { command: 'echo hello' },
          result: { exitCode: 0, stdout: 'hello', stderr: '' },
        },
      ],
    },
  ];
  const rendered = recordedToolOutputText(entries);
  assert.match(rendered, /echo hello/);
  assert.match(rendered, /exit code: 0/);
  assert.match(rendered, /=== recorded tool output ===/);
});

test('renders a shell command with non-zero exit code', () => {
  const entries = [
    {
      stage: 'test',
      toolCallLog: [
        {
          tool: 'shell',
          args: { command: 'false' },
          result: { exitCode: 1, stdout: '', stderr: 'command not found' },
        },
      ],
    },
  ];
  const rendered = recordedToolOutputText(entries);
  assert.match(rendered, /false/);
  assert.match(rendered, /exit code: 1/);
  assert.match(rendered, /stderr:/);
  assert.match(rendered, /command not found/);
});

test('handles malformed entries with null/missing fields gracefully', () => {
  const entries = [
    {
      stage: 'test',
      toolCallLog: [
        { tool: 'shell', args: null, result: null },
        { tool: 'shell', result: { exitCode: 0 } },
      ],
    },
  ];
  // Should not throw
  const rendered = recordedToolOutputText(entries);
  assert.equal(typeof rendered, 'string');
  // The header should still appear since we have a valid entry array
  assert.match(rendered, /=== recorded tool output ===/);
});

test('renders multiple stages with different tools', () => {
  const entries = [
    {
      stage: 'stage1',
      toolCallLog: [
        {
          tool: 'shell',
          args: { command: 'ls' },
          result: { exitCode: 0, stdout: 'file.txt' },
        },
      ],
    },
    {
      stage: 'stage2',
      toolCallLog: [
        {
          tool: 'shell',
          args: { command: 'cat file.txt' },
          result: { exitCode: 0, stdout: 'content', stderr: '' },
        },
      ],
    },
  ];
  const rendered = recordedToolOutputText(entries);
  assert.match(rendered, /ls/);
  assert.match(rendered, /exit code: 0/);
  assert.match(rendered, /cat file.txt/);
  assert.match(rendered, /stage: stage1/);
  assert.match(rendered, /stage: stage2/);
});
