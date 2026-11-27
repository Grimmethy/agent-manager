'use strict';

// Renders the full tool-call transcript (commands, exit codes, stdout, stderr) from a
// work-log's toolCallLog entries into a single text block suitable for grounding. The
// output is labeled "recorded tool output" so a fact-check pass can distinguish it from
// other grounding sources (prompt context, fetched files, live repo content, etc.).
//
// Data shape (matches the work-log tier structure):
//   { stage: string, toolCallLog: Array<{tool, args: {command?: string}, result: {exitCode?, stdout?, stderr?}}> }
//
// Pure function: no I/O, no timers. Malformed entries are skipped silently (best-effort
// same discipline as every other block in get-grounding-source.js).

function recordedToolOutputText(workLogEntries) {
  if (!Array.isArray(workLogEntries) || workLogEntries.length === 0) {
    return '';
  }

  const lines = [];
  lines.push('=== recorded tool output ===');

  for (const entry of workLogEntries) {
    if (!entry || typeof entry !== 'object') continue;

    const stage = entry.stage || 'unknown';
    const toolCallLog = entry.toolCallLog;

    if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) continue;

    lines.push(`--- stage: ${stage} ---`);

    for (const call of toolCallLog) {
      if (!call || typeof call !== 'object') continue;

      const tool = call.tool || 'unknown';
      const args = call.args || {};
      const result = call.result || {};

      // Render the command if present
      if (args.command) {
        lines.push(`> ${args.command}`);
      }

      // Render exit code if present
      if (result.exitCode !== undefined && result.exitCode !== null) {
        lines.push(`  exit code: ${result.exitCode}`);
      }

      // Render stdout if present
      if (result.stdout) {
        lines.push(`  stdout:`);
        lines.push(`    ${result.stdout}`);
      }

      // Render stderr if present
      if (result.stderr) {
        lines.push(`  stderr:`);
        lines.push(`    ${result.stderr}`);
      }

      // If nothing was rendered, note the tool was called
      if (!args.command && result.exitCode === undefined && !result.stdout && !result.stderr) {
        lines.push(`  [tool: ${tool}]`);
      }
    }
  }

  return lines.join('\n');
}

module.exports = { recordedToolOutputText };
