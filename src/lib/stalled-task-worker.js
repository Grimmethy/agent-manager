'use strict';

const FileResolver = require('./file-resolver.js');

// DismissalHistory: tracks plan rejections with structured events for audit and retry logic.
class DismissalHistory {
  constructor() {
    this.events = [];
  }

  record({ taskId, bucket, reason, timestamp, resolution }) {
    const event = { taskId, bucket, reason, timestamp, resolution };
    this.events.push(event);
    return event;
  }

  getEventsByTask(taskId) {
    return this.events.filter(e => e.taskId === taskId);
  }

  getRecent(bucket, count = 10) {
    return this.events
      .filter(e => e.bucket === bucket)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, count);
  }
}

// StalledTaskWorker: processes plans and handles retry logic for stalled tasks.
// Resolves bare filenames (e.g. "downloader.py") against the repo to find exact paths.
class StalledTaskWorker {
  constructor({ repoRoot, dismissalHistory } = {}) {
    this.repoRoot = repoRoot;
    this.dismissalHistory = dismissalHistory || new DismissalHistory();
  }

  // Extract file references from plan text. Handles:
  // - "Update src/config.js" or "edit src/config.js"
  // - "modify the file downloader.py"
  // - "in src/downloader.py"
  // - "file: src/config.js"
  // - "target: downloader.py"
  _extractUnresolvedRefs(plan) {
    const refs = [];
    const patterns = [
      /(?:update|edit|modify|change|fix)\s+(?:the\s+)?(?:file\s+)?([a-zA-Z0-9_.\-\/]+\.[a-zA-Z0-9]+)/gi,
      /(?:in|at|to)\s+(?:the\s+)?(?:file\s+)?([a-zA-Z0-9_.\-\/]+\.[a-zA-Z0-9]+)/gi,
      /(?:file|target|path)\s*:\s*([a-zA-Z0-9_.\-\/]+\.[a-zA-Z0-9]+)/gi,
      /(?:src\/lib\/)?([a-zA-Z0-9_.\-\/]+\.[a-zA-Z0-9]+)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(plan)) !== null) {
        const ref = match[1];
        // Skip if already has full path prefix (src/, lib/, etc.)
        if (!ref.startsWith('src/') && !ref.startsWith('lib/') && !ref.startsWith('./')) {
          refs.push(ref);
        }
      }
    }

    return [...new Set(refs)]; // dedupe
  }

  // Resolve bare filenames in plan text using FileResolver.
  // If exactly one match exists, replace with full path.
  // If multiple or none, leave as-is for retry handling.
  processPlan(plan, context = {}) {
    if (!plan || typeof plan !== 'string') return plan;

    const repoRoot = context.repoRoot || this.repoRoot;
    if (!repoRoot) return plan;

    const unresolvedRefs = this._extractUnresolvedRefs(plan);
    const resolvedRefs = new Map();

    for (const ref of unresolvedRefs) {
      const resolution = FileResolver.resolve(ref, repoRoot);

      if (resolution.exact) {
        // Exactly one match: use it
        resolvedRefs.set(ref, resolution.exact);
      } else if (resolution.candidates && resolution.candidates.length > 0) {
        // Multiple matches: leave as-is, will be handled in retry
        resolvedRefs.set(ref, null);
      } else {
        // No match: leave as-is, will be handled in retry
        resolvedRefs.set(ref, null);
      }
    }

    // Replace references in plan text
    let resolvedPlan = plan;
    for (const [ref, fullPath] of resolvedRefs) {
      if (fullPath) {
        // CRITICAL: Use the ref as the pattern (not the fullPath) to avoid mangling
        // BUG FIX: Previously used fullPath as pattern AND replacement, producing
        // "src//tmp/.../src/config.js" when ref was "src/config.js"
        const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedRef, 'g');
        resolvedPlan = resolvedPlan.replace(regex, fullPath);
      }
    }

    return resolvedPlan;
  }

  // Detect plan truncation and generate retry prompt with modified conditions.
  retryPlan(plan, history) {
    if (!plan || typeof plan !== 'string') return null;

    // Check for truncation indicators
    const isTruncated = (
      plan.endsWith('...') ||
      plan.endsWith('\n') ||
      /list item \d+\.?\s*$/.test(plan) ||
      /update\s+\d+\s+files?\s*$/.test(plan)
    );

    if (!isTruncated) return null;

    const unresolvedRefs = this._extractUnresolvedRefs(plan);
    const unresolved = unresolvedRefs.filter(ref => {
      const resolution = FileResolver.resolve(ref, this.repoRoot);
      return !resolution.exact;
    });

    if (unresolved.length === 0) return null;

    // Calculate modified retry conditions based on retry history
    const retryCount = history.retryCount || 0;
    const maxRetries = history.maxRetries || 3;
    
    // If we've exceeded max retries, mark as truly stuck
    if (retryCount >= maxRetries) {
      const dismissal = this.dismissalHistory.record({
        taskId: history.taskId,
        bucket: 'retry',
        reason: 'Plan truncated: exceeded maximum retry attempts',
        timestamp: new Date().toISOString(),
        resolution: {
          action: 'mark-stuck',
          retryCount,
          unresolvedRefs
        }
      });
      return { stuck: true, dismissal };
    }

    // Modify conditions for this retry
    const modifiedConditions = this._calculateModifiedConditions(retryCount, unresolvedRefs);

    // Record dismissal
    const dismissal = this.dismissalHistory.record({
      taskId: history.taskId,
      bucket: 'retry',
      reason: 'Plan truncated with unresolved file references',
      timestamp: new Date().toISOString(),
      resolution: {
        action: 'retry-with-modified-conditions',
        retryCount: retryCount + 1,
        modifiedConditions,
        unresolvedRefs
      }
    });

    // Generate retry prompt with modified conditions
    const prompt = this._generateRetryPrompt(plan, unresolved, modifiedConditions);

    return { prompt, dismissal, modifiedConditions };
  }

  // Calculate modified conditions for retry based on attempt number and unresolved refs.
  _calculateModifiedConditions(retryCount, unresolvedRefs) {
    const conditions = {
      // Reduce context by trimming older messages (keep last N messages)
      contextTrimming: retryCount > 0 ? 'trim-older-messages' : 'none',
      
      // Increase output budget (multiply by 1.5x for each retry)
      outputBudgetMultiplier: 1 + (retryCount * 0.5),
      
      // Use lower temperature for more focused output
      temperature: Math.max(0.1, 0.7 - (retryCount * 0.1)),
      
      // Include unresolved file references in prompt
      includeUnresolvedRefs: true,
      
      // Add explicit instruction to complete the plan
      explicitCompletionInstruction: true
    };

    // For later retries, add more aggressive modifications
    if (retryCount >= 2) {
      conditions.contextTrimming = 'aggressive-trim';
      conditions.outputBudgetMultiplier *= 1.5;
      conditions.temperature = Math.max(0.1, conditions.temperature - 0.1);
    }

    return conditions;
  }

  // Generate retry prompt incorporating modified conditions.
  _generateRetryPrompt(plan, unresolvedRefs, conditions) {
    const lines = [
      'The previous plan was truncated. Please complete it with the following modifications:',
      '',
      'Modified conditions:',
      `  - Context: ${conditions.contextTrimming}`,
      `  - Output budget multiplier: ${conditions.outputBudgetMultiplier}x`,
      `  - Temperature: ${conditions.temperature}`,
    ];

    if (conditions.includeUnresolvedRefs && unresolvedRefs.length > 0) {
      lines.push('', 'Unresolved file references:');
      unresolvedRefs.forEach(ref => {
        lines.push(`  - ${ref}`);
      });
    }

    if (conditions.explicitCompletionInstruction) {
      lines.push('', 'IMPORTANT: Complete the plan from where it was truncated. Do not restart from the beginning.');
    }

    lines.push('', 'Original plan:', plan);

    return lines.join('\n');
  }
}

// Self-test
if (require.main === module) {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('fs');
  const path = require('path');

  test('StalledTaskWorker resolves bare filename to exact path', () => {
    const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'downloader.py'), '# downloader');

    const worker = new StalledTaskWorker({ repoRoot: tmpDir });
    const plan = 'Update the file downloader.py to add retry logic';
    const resolved = worker.processPlan(plan);

    assert.ok(resolved.includes(path.join(srcDir, 'downloader.py')),
      `Expected resolved path, got: ${resolved}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('StalledTaskWorker leaves ambiguous refs as-is', () => {
    const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
    const srcDir = path.join(tmpDir, 'src');
    const libDir = path.join(tmpDir, 'lib');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(libDir);
    fs.writeFileSync(path.join(srcDir, 'utils.ts'), '// src');
    fs.writeFileSync(path.join(libDir, 'utils.ts'), '// lib');

    const worker = new StalledTaskWorker({ repoRoot: tmpDir });
    const plan = 'Update the file utils.ts';
    const resolved = worker.processPlan(plan);

    // Should not resolve since ambiguous
    assert.equal(resolved, plan, 'Expected no resolution for ambiguous ref');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('StalledTaskWorker does not mangle existing paths', () => {
    const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'config.js'), '// config');

    const worker = new StalledTaskWorker({ repoRoot: tmpDir });
    const plan = 'Update src/config.js to add logging';
    const resolved = worker.processPlan(plan);

    // Should not mangle "src/config.js" into "src//tmp/.../src/config.js"
    assert.ok(!resolved.includes('src//'), `Expected no double slash, got: ${resolved}`);
    assert.ok(resolved.includes('src/config.js'), 'Expected original ref preserved');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('StalledTaskWorker detects truncation and generates retry prompt', () => {
    const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'nonexistent.py'), '# not here');

    const worker = new StalledTaskWorker({ repoRoot: tmpDir });
    const history = { taskId: 'test-task-123' };
    const plan = '1. Update downloader.py\n2. Fix config\n...';

    const result = worker.retryPlan(plan, history);

    assert.ok(result, 'Expected retry result');
    assert.ok(result.prompt.includes('Unresolved file references'), 'Expected unresolved refs in prompt');
    assert.ok(result.prompt.includes('downloader.py'), 'Expected bare filename in prompt');
    assert.ok(result.dismissal, 'Expected dismissal record');
    assert.equal(result.dismissal.taskId, 'test-task-123', 'Expected task ID in dismissal');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  console.log('All StalledTaskWorker self-tests passed!');
}

module.exports = StalledTaskWorker;
module.exports.StalledTaskWorker = StalledTaskWorker;
module.exports.DismissalHistory = DismissalHistory;
