'''Tests for hub_retire_cascade (HUB0478 1/5). unittest, matching the rest of python/dashboard.'''

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hub_retire_cascade as hrc  # noqa: E402


def _archive(qdir, path):
    dest = Path(qdir) / 'done' / '_archived_no_action' / Path(path).name
    os.replace(path, dest)


class CascadeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.q = Path(self.tmp) / 'queue'
        for d in ['adhoc', 'pending', 'review', 'coordinating', 'done/_archived_no_action',
                  'done/_superseded', 'drafting/lane1']:
            (self.q / d).mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def put(self, state, rid, subs=None):
        rec = {'id': rid, 'hubLabel': 'HUB-' + rid, 'history': []}
        if subs is not None:
            rec['subTasks'] = [{'id': s} for s in subs]
        d = self.q / state
        d.mkdir(parents=True, exist_ok=True)
        import json
        (d / (rid + '.json')).write_text(json.dumps(rec), encoding='utf-8')

    def read(self, state_dir, rid):
        import json
        return json.loads((self.q / state_dir / (rid + '.json')).read_text(encoding='utf-8'))

    # A: a retirable middle hub that an outside coordinating hub also points at is refused, and the refusal is recorded.
    def test_A_outside_coordinator_blocks_and_refusal_recorded(self):
        self.put('coordinating', 'R', ['M'])
        self.put('coordinating', 'M', ['L'])
        self.put('adhoc', 'L')
        self.put('coordinating', 'O', ['M'])
        blockers, order = hrc.plan_cascade('R', self.q)
        self.assertEqual(order, [])
        self.assertEqual(len(blockers), 1)
        self.assertIn('M', blockers[0])
        self.assertIn('coordinating hub O', blockers[0])
        before = hrc.COUNTERS['hub_retire_refusals']
        result = hrc.refuse_cascade('R', blockers, 'alice', 'test', self.q)
        self.assertFalse(result['ok'])
        self.assertEqual(hrc.COUNTERS['hub_retire_refusals'], before + 1)
        ev = self.read('coordinating', 'R')['history'][-1]
        self.assertEqual(ev['type'], 'refused')
        self.assertEqual(ev['blockers'], blockers)
        self.assertEqual(ev['cascadeRoot'], 'R')

    # B: a blocked grandchild under a retirable child is found through the middle node.
    def test_B_blocked_grandchild_found_at_depth(self):
        self.put('coordinating', 'R', ['M'])
        self.put('coordinating', 'M', ['G'])
        self.put('review', 'G')
        blockers, order = hrc.plan_cascade('R', self.q)
        self.assertEqual(order, [])
        self.assertEqual(len(blockers), 1)
        self.assertIn('G', blockers[0])
        self.assertIn('review', blockers[0])

    # C: a clean three-level tree gives a post-order list, and each archived node gets a retired event.
    def test_C_happy_path_post_order_and_retired_events(self):
        self.put('coordinating', 'R', ['M', 'L2'])
        self.put('coordinating', 'M', ['L'])
        self.put('adhoc', 'L')
        self.put('pending', 'L2')
        blockers, order = hrc.plan_cascade('R', self.q)
        self.assertEqual(blockers, [])
        self.assertEqual(order, ['L', 'M', 'L2', 'R'])
        done = hrc.apply_cascade(order, 'alice', 'test', self.q, archive=_archive)
        self.assertEqual([d['id'] for d in done], ['L', 'M', 'L2', 'R'])
        for d in done:
            self.assertIn('label', d)
        for rid in ['L', 'M', 'R']:
            arch = self.q / 'done' / '_archived_no_action' / (rid + '.json')
            import json
            rec = json.loads(arch.read_text(encoding='utf-8'))
            ev = rec['history'][-1]
            self.assertEqual(ev['type'], 'retired')
            self.assertEqual(ev['cascadeRoot'], 'R')
            self.assertEqual(ev['who'], 'alice')

    # D: a subTasks cycle terminates and each node appears once.
    def test_D_cycle_terminates(self):
        self.put('coordinating', 'R', ['M'])
        self.put('coordinating', 'M', ['R'])
        blockers, order = hrc.plan_cascade('R', self.q)
        self.assertEqual(blockers, [])
        self.assertEqual(order, ['M', 'R'])
        self.assertEqual(len(order), len(set(order)))

    # E: a subTasks entry with no record is a blocker, not skipped.
    def test_E_unlinked_child_is_blocker(self):
        self.put('coordinating', 'R', ['X'])
        blockers, order = hrc.plan_cascade('R', self.q)
        self.assertEqual(order, [])
        self.assertEqual(len(blockers), 1)
        self.assertIn('X has no record', blockers[0])

    # F: a node in an unlisted state is reported, not archived.
    def test_F_unknown_state_is_blocker(self):
        self.put('coordinating', 'R', ['X'])
        (self.q / 'weird').mkdir()
        self.put('weird', 'X')
        blockers, order = hrc.plan_cascade('R', self.q)
        self.assertEqual(order, [])
        self.assertEqual(len(blockers), 1)
        self.assertIn('unclassified state (weird)', blockers[0])

    # G: a leaf reached through two parents is checked both times; a blocked leaf is reported once, a retirable one archived once.
    def test_G_second_parent_blocked_reported_once(self):
        self.put('coordinating', 'R', ['A', 'B'])
        self.put('coordinating', 'A', ['L'])
        self.put('coordinating', 'B', ['L'])
        self.put('review', 'L')
        blockers, order = hrc.plan_cascade('R', self.q)
        self.assertEqual(order, [])
        self.assertEqual(sum('L is in flight' in b for b in blockers), 1)

    def test_G_second_parent_retirable_archived_once(self):
        self.put('coordinating', 'R', ['A', 'B'])
        self.put('coordinating', 'A', ['L'])
        self.put('coordinating', 'B', ['L'])
        self.put('adhoc', 'L')
        blockers, order = hrc.plan_cascade('R', self.q)
        self.assertEqual(blockers, [])
        self.assertEqual(order, ['L', 'A', 'B', 'R'])
        self.assertEqual(len(order), len(set(order)))

    # H: a node that changes between phase A and phase B stops the run, writes a refused event, and raises.
    def test_H_change_between_phases_refuses(self):
        self.put('coordinating', 'R', ['L'])
        self.put('adhoc', 'L')
        blockers, order = hrc.plan_cascade('R', self.q)
        self.assertEqual(order, ['L', 'R'])
        os.replace(self.q / 'adhoc' / 'L.json', self.q / 'review' / 'L.json')
        with self.assertRaises(hrc.CascadeRefused):
            hrc.apply_cascade(order, 'alice', 'test', self.q, archive=_archive)
        ev = self.read('coordinating', 'R')['history'][-1]
        self.assertEqual(ev['type'], 'refused')
        self.assertTrue(any('L changed' in b for b in ev['blockers']))


if __name__ == '__main__':
    unittest.main()
