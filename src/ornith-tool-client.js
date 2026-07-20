'use strict';

// Multi-turn tool-calling loop for a plan pass, giving it a real, narrow, read-only
// codebase-search capability via grep-codebase-tool.js. Unlike ornith-client.js (which only
// ever calls Ollama's /api/generate -- a single prompt-in, text-out call with no structured
// tool support), this hits /api/chat, the endpoint that actually supports Ollama's tools
// array and tool_calls response field.

const path = require('path');
const fs = require('fs');
const { grepCodebase } = require('./grep-codebase-tool.js');
const { getConfig } = require('./config.js');
const { postJson } = require('./ollama-http.js');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.ORNITH_MODEL || 'ornith';

// Matches ornith-client.js's REQUEST_TIMEOUT_MS exactly -- was 1_800_000 (30 min) under the
// reasoning that a tool-calling turn can legitimately run longer than a plain generation
// call. That reasoning turned out to be actively harmful, not just generous: this exact
// path is why Invoke-OrnithToolClient is disabled in ornith-worker.ps1 (see that file's
// comment) -- a real call through here stalled a worker for 13+ minutes with no progress,
// and a 30-min ceiling meant nothing would have caught it for a very long time if the
// disable hadn't happened first. 5 minutes is the formalized ceiling for every Ornith-call-
// or liveness-related timeout in this pipeline as of 2026-07-19 (see
// docs/pipeline-incident-2026-07-19.md and queue-watchdog.ps1's $WorkerZombieThresholdSeconds)
// -- repeated-failure downtime compounds fast, and no legitimate call needs longer than
// this. Do not raise this again "to be safe" without revisiting that reasoning first.
const REQUEST_TIMEOUT_MS = Number(process.env.ORNITH_TIMEOUT_MS) || 240_000;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'grep_codebase',
      description: 'Search the codebase for a text/word match. Returns up to 20 matches with file path and line number.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Plain substring/word to search for.' },
          dir: { type: 'string', description: 'Which source root to search (one of the configured allowed dirs).' },
        },
        required: ['query', 'dir'],
      },
    },
  },
];

async function runPlanWithTools({ prompt, maxTurns = 5 }) {
  const { pipelineDir } = getConfig();
  const killSwitchPath = path.join(pipelineDir, 'queue', '.arch-discovery-tools-disabled');
  if (fs.existsSync(killSwitchPath)) {
    const { call } = require('./ornith-client.js');
    const result = await call({ prompt, think: true });
    return { response: result.response, toolCallLog: [], turnsUsed: 0, toolsDisabled: true };
  }

  const messages = [{ role: 'user', content: prompt }];
  const toolCallLog = [];
  let turnsUsed = 0;
  let lastMessage = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    turnsUsed = turn + 1;
    const res = await postJson(`${OLLAMA_URL}/api/chat`, {
      model: MODEL,
      messages,
      tools: TOOLS,
      stream: false,
    }, REQUEST_TIMEOUT_MS);

    const message = res.message || {};
    lastMessage = message;
    const toolCalls = message.tool_calls || [];

    if (toolCalls.length === 0) {
      return { response: message.content || '', toolCallLog, turnsUsed, toolsDisabled: false };
    }

    messages.push(message);
    for (const toolCall of toolCalls) {
      const args = (toolCall.function && toolCall.function.arguments) || {};
      const result = grepCodebase({ query: args.query, dir: args.dir });
      toolCallLog.push({ tool: 'grep_codebase', args: { query: args.query, dir: args.dir }, result });
      messages.push({ role: 'tool', content: JSON.stringify(result) });
    }
  }

  // maxTurns reached without a final (no-tool-calls) response -- deliberate forced stop,
  // not a crash, matching how this pipeline already treats an empty/degenerate plan pass.
  return { response: (lastMessage && lastMessage.content) || '', toolCallLog, turnsUsed, toolsDisabled: false };
}

module.exports = { runPlanWithTools };

// CLI: node ornith-tool-client.js <request.json>
// request.json: { prompt, maxTurns }
// Writes the JSON result to stdout.
if (require.main === module) {
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error('usage: node ornith-tool-client.js <request.json>');
    process.exit(1);
  }
  const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));

  (async () => {
    try {
      const result = await runPlanWithTools(req);
      process.stdout.write(JSON.stringify(result));
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
