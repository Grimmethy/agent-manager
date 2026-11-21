'''Discarding a HIDDEN stale agent/* branch (stale_branch_lookup.py via routes/pipeline_1_more.py), 2026-11-21.

Real temp git repos with a local bare origin, plus the Flask test client. The active project, apply lock, listed branches and
queue dir are faked. No network.
Run: python3 -m unittest discover -s python/dashboard -p test_branch_discard_hidden.py
'''
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import stale_branch_lookup  # noqa: E402

GIT_ENV = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.invalid',
           'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.invalid'}


def git(cwd, *args):
    return subprocess.run(['git', '-c', 'commit.gpgsign=false', *args], cwd=cwd, check=True,
                          capture_output=True, text=True, env=GIT_ENV).stdout.strip()


class DiscardHiddenStale(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='discard-hidden-'))
        self.bare = self.tmp / 'origin.git'
        self.work = self.tmp / 'work'
        git(self.tmp, 'init', '-q', '--bare', '-b', 'main', str(self.bare))
        git(self.tmp, 'init', '-q', '-b', 'main', str(self.work))
        git(self.work, 'remote', 'add', 'origin', str(self.bare))
        self.commit('base.txt', 'one', 'base')
        git(self.work, 'push', '-q', '-u', 'origin', 'main')
        self.listed = []
        self.patches = [
            mock.patch('app.get_active_repo_root', return_value=str(self.work)),
            mock.patch('app.queue_dir', return_value=None),
            mock.patch('app._acquire_apply_lock', return_value=0),
            mock.patch('app._release_apply_lock', return_value=None),
            mock.patch('app.list_unmerged_branches', return_value=self.listed),
        ]
        for p in self.patches:
            p.start()
        self.client = app.app.test_client()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def commit(self, fname, text, msg):
        (self.work / fname).write_text(text, encoding='utf-8')
        git(self.work, 'add', fname)
        git(self.work, 'commit', '-q', '-m', msg)
        return git(self.work, 'rev-parse', 'HEAD')

    def branch_with(self, branch, fname, text):
        git(self.work, 'checkout', '-q', '-b', branch, 'main')
        sha = self.commit(fname, text, f'work on {branch}')
        git(self.work, 'push', '-q', 'origin', branch)
        git(self.work, 'checkout', '-q', 'main')
        return sha

    def remote_ref(self, branch):
        return git(self.work, 'ls-remote', '--heads', 'origin', branch)

    def discard(self, branch):
        return self.client.post(f'/api/git/branches/{branch}/discard')

    def test_a_stale_branch_identical_on_main_is_discarded(self):
        self.branch_with('agent/stale-1', 'change.txt', 'fix')
        self.commit('change.txt', 'fix', 'the same fix lands on main')
        git(self.work, 'push', '-q', 'origin', 'main')
        self.assertNotEqual(self.remote_ref('agent/stale-1'), '')
        r = self.discard('agent/stale-1')
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        payload = r.get_json()
        self.assertTrue(payload['succeeded'])
        self.assertTrue(payload['snapshotRef'])
        git(self.work, 'rev-parse', '--verify', '--quiet', payload['snapshotRef'])
        self.assertEqual(self.remote_ref('agent/stale-1'), '')
        self.assertGreaterEqual(stale_branch_lookup.COUNTS.get('hidden-match', 0), 1)

    def test_b_listed_branch_with_real_content_is_discarded_as_before(self):
        sha = self.branch_with('agent/live-2', 'live.txt', 'work')
        self.listed.append({'branch': 'agent/live-2', 'headSha': sha, 'mainBranch': 'main', 'verdict': 'discard', 'stale': False})
        r = self.discard('agent/live-2')
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertTrue(r.get_json()['succeeded'])
        self.assertEqual(self.remote_ref('agent/live-2'), '')

    def test_c_name_outside_agent_is_404(self):
        self.branch_with('feature/x', 'x.txt', 'x')
        self.assertEqual(self.discard('feature/x').status_code, 404)
        self.assertGreaterEqual(stale_branch_lookup.COUNTS.get('rejected-name', 0), 1)
        self.assertNotEqual(self.remote_ref('feature/x'), '')

    def test_d_missing_agent_branch_is_404(self):
        self.assertEqual(self.discard('agent/nope-9').status_code, 404)

    def test_e_real_unmerged_content_not_listed_is_404_and_kept(self):
        self.branch_with('agent/live-3', 'live3.txt', 'real')
        self.assertEqual(self.discard('agent/live-3').status_code, 404)
        self.assertGreaterEqual(stale_branch_lookup.COUNTS.get('rejected-not-hidden', 0), 1)
        self.assertNotEqual(self.remote_ref('agent/live-3'), '')


if __name__ == '__main__':
    unittest.main()
