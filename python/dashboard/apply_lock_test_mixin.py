"""Test base that isolates the apply-lock helpers from the real home-dir lock.

List it before ``unittest.TestCase``::

    class T(ApplyLockTestMixin, unittest.TestCase):
        ...

setUp points AGENT_MANAGER_LOCK_DIR at a per-test temp dir, so
_acquire_apply_lock / _release_apply_lock never touch the real lock.
"""
import os
import shutil
import tempfile

_ENV_VAR = "AGENT_MANAGER_LOCK_DIR"


class ApplyLockTestMixin:
    """Mixin: per-test temp lock dir via AGENT_MANAGER_LOCK_DIR."""

    def setUp(self):
        # Cooperative: the mixin must precede bases (e.g. EdgeBase) in the MRO,
        # since some of them do not call super().setUp().
        super().setUp()
        lock_dir = tempfile.mkdtemp()
        previous = os.environ.get(_ENV_VAR)
        os.environ[_ENV_VAR] = lock_dir
        self.apply_lock_dir = lock_dir
        self.addCleanup(self._restore_apply_lock_env, previous, lock_dir)

    def _restore_apply_lock_env(self, previous, lock_dir):
        if previous is None:
            os.environ.pop(_ENV_VAR, None)
        else:
            os.environ[_ENV_VAR] = previous
        shutil.rmtree(lock_dir, ignore_errors=True)
