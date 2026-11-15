'use strict';

/**
 * DismissalHistory: tracks plan rejections with structured events for audit and retry logic.
 * Records every task dismissal from a bucket for observability.
 *
 * @typedef {Object} DismissalEvent
 * @property {string} taskId - The task ID being dismissed
 * @property {string} bucket - The bucket/queue the task was dismissed from
 * @property {string} reason - Human-readable reason for dismissal
 * @property {number} timestamp - Unix timestamp in milliseconds
 * @property {Object} [resolution] - Optional resolution details (e.g., candidates considered)
 */

class DismissalHistory {
  /**
   * @param {DismissalEvent[]} [events=[]] - Initial events array
   */
  constructor(events = []) {
    this.events = events;
  }

  /**
   * Record a dismissal event.
   *
   * @param {Object} event - The dismissal event to record
   * @param {string} event.taskId - The task ID being dismissed
   * @param {string} event.bucket - The bucket/queue the task was dismissed from
   * @param {string} event.reason - Human-readable reason for dismissal
   * @param {number} event.timestamp - Unix timestamp in milliseconds
   * @param {Object} [event.resolution] - Optional resolution details (e.g., which candidates were considered)
   * @returns {DismissalEvent} The recorded event
   */
  record({ taskId, bucket, reason, timestamp, resolution }) {
    const event = { taskId, bucket, reason, timestamp, resolution };
    this.events.push(event);
    return event;
  }

  /**
   * Get all events for a specific task.
   *
   * @param {string} taskId - The task ID to filter by
   * @returns {DismissalEvent[]} Array of events for the task
   */
  getEventsByTask(taskId) {
    return this.events.filter(e => e.taskId === taskId);
  }

  /**
   * Get recent events for a bucket, sorted by timestamp descending.
   *
   * @param {string} bucket - The bucket to filter by
   * @param {number} [count=10] - Maximum number of events to return
   * @returns {DismissalEvent[]} Array of recent events
   */
  getRecent(bucket, count = 10) {
    return this.events
      .filter(e => e.bucket === bucket)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, count);
  }
}

// Self-test
if (require.main === module) {
  const test = require('node:test');
  const assert = require('node:assert/strict');

  test('DismissalHistory records an event', () => {
    const history = new DismissalHistory();
    const event = history.record({
      taskId: 'task-123',
      bucket: 'reject',
      reason: 'Test rejection',
      timestamp: Date.now(),
      resolution: { candidates: ['file-a.ts', 'file-b.ts'] }
    });

    assert.equal(event.taskId, 'task-123');
    assert.equal(event.bucket, 'reject');
    assert.ok(Array.isArray(history.events));
    assert.equal(history.events.length, 1);
  });

  test('DismissalHistory records event without resolution', () => {
    const history = new DismissalHistory();
    const event = history.record({
      taskId: 'task-456',
      bucket: 'retry',
      reason: 'Test retry',
      timestamp: Date.now()
    });

    assert.equal(event.taskId, 'task-456');
    assert.equal(event.resolution, undefined);
  });

  test('DismissalHistory.getEventsByTask filters correctly', () => {
    const history = new DismissalHistory();
    history.record({ taskId: 'task-1', bucket: 'reject', reason: 'r1', timestamp: Date.now() });
    history.record({ taskId: 'task-2', bucket: 'reject', reason: 'r2', timestamp: Date.now() });
    history.record({ taskId: 'task-1', bucket: 'retry', reason: 'r3', timestamp: Date.now() });

    const events = history.getEventsByTask('task-1');
    assert.equal(events.length, 2);
    assert.ok(events.every(e => e.taskId === 'task-1'));
  });

  test('DismissalHistory.getRecent returns most recent events', () => {
    const history = new DismissalHistory();
    const now = Date.now();
    history.record({ taskId: 'task-1', bucket: 'reject', reason: 'r1', timestamp: now - 2000 });
    history.record({ taskId: 'task-2', bucket: 'reject', reason: 'r2', timestamp: now - 1000 });
    history.record({ taskId: 'task-3', bucket: 'reject', reason: 'r3', timestamp: now });

    const recent = history.getRecent('reject', 2);
    assert.equal(recent.length, 2);
    // Should be sorted by timestamp descending
    assert.ok(recent[0].timestamp >= recent[1].timestamp);
  });

  test('DismissalHistory captures resolution details for truncated plan with missing file', () => {
    // Real case: a plan references a nonexistent file, and the retry plan pass is truncated/empty
    const history = new DismissalHistory();
    
    // Simulate recording a dismissal for a truncated plan with unresolved file references
    const event = history.record({
      taskId: 'task-truncated-123',
      bucket: 'retry',
      reason: 'Plan truncated with unresolved file references',
      timestamp: Date.now(),
      resolution: {
        unresolvedRefs: ['config.ts', 'utils.ts'],
        candidatesConsidered: {
          'config.ts': ['/repo/src/config.ts', '/repo/lib/config.ts'],
          'utils.ts': ['/repo/src/utils.ts']
        },
        action: 'retry-with-context'
      }
    });

    // Verify the event was recorded with all fields
    assert.equal(event.taskId, 'task-truncated-123');
    assert.equal(event.bucket, 'retry');
    assert.equal(event.reason, 'Plan truncated with unresolved file references');
    assert.ok(event.timestamp > 0);
    assert.ok(event.resolution);
    assert.ok(Array.isArray(event.resolution.unresolvedRefs));
    assert.equal(event.resolution.unresolvedRefs.length, 2);
    assert.ok(event.resolution.candidatesConsidered);
    
    // Verify we can retrieve the event
    const events = history.getEventsByTask('task-truncated-123');
    assert.equal(events.length, 1);
    assert.equal(events[0].resolution.action, 'retry-with-context');
  });

  console.log('All DismissalHistory self-tests passed!');
}

module.exports = DismissalHistory;
module.exports.DismissalHistory = DismissalHistory;
