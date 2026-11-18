'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDisposition, isNoopApplyDetail } = require('./task-disposition.js');

const DETAIL = 'debriefed 25 task(s); archived 25, already-moved 0; routed 0 Now-What item(s) to queue/adhoc/, filed 2 to the brain-dump inbox';
const DETAIL_WITH_NOOP_WORD = 'debriefed 25 task(s); archived 24, already-moved 0, 1 error(s): move skipped; routed 0 Now-What item(s) to queue/adhoc/, filed 2 to the brain-dump inbox';

test('pipeline_debrief apply detail is never a no-op apply', () => {
  assert.equal(isNoopApplyDetail(DETAIL), false);
  assert.equal(isNoopApplyDetail(DETAIL_WITH_NOOP_WORD), false);
});

test('pipeline_debrief record resolves to exactly one `filed` disposition, not noop', () => {
  for (const detail of [DETAIL, DETAIL_WITH_NOOP_WORD]) {
    const record = {
      id: 'pipeline-debrief-single',
      source: 'pipeline_debrief',
      history: [{ stage: 'created' }, { stage: 'applied', detail }],
    };
    const out = resolveDisposition(record, {});
    assert.ok(out, 'a disposition is produced');
    assert.equal(out.stage, 'filed');
    assert.equal(record.history.filter((e) => e.stage === 'noop').length, 0);
    assert.equal(record.history.length, 2, 'resolveDisposition appended nothing extra');
  }
});
