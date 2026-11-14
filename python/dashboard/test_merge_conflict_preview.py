'''Regression test: the merge-conflict preview and the real merge must agree.

Defect guarded: preview reads untracked .gitattributes merge driver that real merge doesn't see.

Uses unittest, matching the other test modules in python/dashboard.
Run: python3 -m unittest discover -s python/dashboard -p test_merge_conflict_preview.py -v
'''
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import app_branch_helpers  # noqa: E402

SETUP_SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'setup-merge-drivers.sh'
DOC = 'Docs/PLAN.doc'  # matches the '*.doc merge=candidate-doc' line setup-merge-drivers.sh writes
OTHER = 'other.txt'
MAIN = 'main'
FEATURE = 'feature'


def _git(cwd, *args, check=True):
    return subprocess.run(['git', *args], cwd=str(cwd), capture_output=True, text=True, check=check)


def _identify(repo):
    _git(repo, 'config', 'user.name', 'merge-preview-test')
    _git(repo, 'config', 'user.email', 'merge-preview-test@example.invalid')


def _write_and_commit(repo, files, message):
    for rel, content in files.items():
        path = Path(repo) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        _git(repo, 'add', rel)
    _git(repo, 'commit', '-q', '-m', message)


def _run_setup(repo):
    subprocess.run(['bash', str(SETUP_SCRIPT), str(repo)], check=True, capture_output=True, text=True)


def _make_fixture(tmp):
    '''Bare origin plus a working clone, with the base content committed on main and pushed.'''
    origin = tmp / 'origin.git'
    seed = tmp / 'seed'
    work = tmp / 'work'
    _git(tmp, 'init', '-q', '--bare', '-b', MAIN, str(origin))
    _git(tmp, 'init', '-q', '-b', MAIN, str(seed))
    _identify(seed)
    _write_and_commit(seed, {DOC: 'base line\n', OTHER: 'base other\n'}, 'base')
    _git(seed, 'remote', 'add', 'origin', str(origin))
    _git(seed, 'push', '-q', 'origin', MAIN)
    _git(tmp, 'clone', '-q', str(origin), str(work))
    _identify(work)
    return origin, work


def _diverge(work, main_files, feature_files):
    '''Feature and main each get a commit on top of the common base, so neither is an ancestor of the other.'''
    _git(work, 'checkout', '-q', '-b', FEATURE, 'origin/' + MAIN)
    _write_and_commit(work, feature_files, 'feature side')
    _git(work, 'push', '-q', 'origin', FEATURE)
    _git(work, 'checkout', '-q', MAIN)
    _write_and_commit(work, main_files, 'main side')
    _git(work, 'push', '-q', 'origin', MAIN)


def _real_merge_conflicts(tmp, origin, with_driver):
    '''Ground truth: a fresh clone merges origin/main into origin/feature with a real git merge
    and reports whether that merge left unmerged paths. The merge is always aborted afterwards.'''
    real = tmp / 'real'
    _git(tmp, 'clone', '-q', str(origin), str(real))
    _identify(real)
    if with_driver:
        _run_setup(real)
    _git(real, 'checkout', '-q', '-B', FEATURE, 'origin/' + FEATURE)
    merge = _git(real, 'merge', '--no-commit', '--no-ff', 'origin/' + MAIN, check=False)
    unmerged = _git(real, 'diff', '--name-only', '--diff-filter=U', check=False).stdout.strip()
    _git(real, 'merge', '--abort', check=False)
    if merge.returncode not in (0, 1):
        raise RuntimeError('real merge failed unexpectedly: ' + merge.stderr)
    return bool(unmerged)


class MergeConflictPreviewTest(unittest.TestCase):
    def _assert_preview_matches(self, preview, real_conflicts):
        self.assertIn('willConflict', preview, f'preview result has no willConflict key: {preview!r}')
        self.assertIsNotNone(preview['willConflict'], f'preview could not decide (willConflict is None): {preview!r}')
        self.assertIsInstance(preview['willConflict'], bool)
        self.assertEqual(
            preview['willConflict'], real_conflicts,
            f'preview willConflict={preview["willConflict"]} but real merge conflicts={real_conflicts}',
        )

    def test_driver_active_conflict_preview_matches_real_merge(self):
        '''Driver-active: candidate-doc driver is registered and both sides edit the same line of a *.doc file.

        Defect guarded: preview reads untracked .gitattributes merge driver that real merge doesn't see.
        Both the preview and the real merge must report a conflict.
        '''
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            origin, work = _make_fixture(tmp)
            _run_setup(work)
            _diverge(work, main_files={DOC: 'main side\n'}, feature_files={DOC: 'feature side\n'})
            preview = app_branch_helpers._check_merge_conflict(work, MAIN, FEATURE)
            real = _real_merge_conflicts(tmp, origin, with_driver=True)
            self.assertTrue(real, 'expected the real merge to conflict on the same doc line')
            self._assert_preview_matches(preview, real)
            self.assertIs(preview['willConflict'], True)

    def test_driver_inactive_no_conflict_preview_matches_real_merge(self):
        '''Driver-inactive: no candidate-doc driver is registered and the sides edit different files.

        Both the preview and the real merge must report no conflict.
        '''
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            origin, work = _make_fixture(tmp)
            _diverge(work, main_files={OTHER: 'main other\n'}, feature_files={DOC: 'feature side\n'})
            preview = app_branch_helpers._check_merge_conflict(work, MAIN, FEATURE)
            real = _real_merge_conflicts(tmp, origin, with_driver=False)
            self.assertFalse(real, 'expected the real merge to be clean')
            self._assert_preview_matches(preview, real)
            self.assertIs(preview['willConflict'], False)


if __name__ == '__main__':
    unittest.main()
