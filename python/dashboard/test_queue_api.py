# Tests for GET /api/queue (HUB0510 1/3): project filter + dependency resolution.
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import app as dash_app  # noqa: E402
from routes import queue_project_filter as qpf  # noqa: E402


def _write_task(qdir, state, task_id, title, depends=()):
    d = qdir / state
    d.mkdir(parents=True, exist_ok=True)
    body = {'id': task_id, 'title': title, 'dependsOn': list(depends)}
    (d / (task_id + '.json')).write_text(json.dumps(body), encoding='utf-8')


class QueueApiTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        alpha = tmp / 'alpha'
        beta = tmp / 'beta'
        _write_task(alpha / 'queue', 'pending', 'A-1', 'task in alpha', depends=['B-1'])
        _write_task(alpha / 'queue', 'pending', 'A-2', 'orphan', depends=['GHOST'])
        _write_task(beta / 'queue', 'done', 'B-1', 'dep in beta')
        _write_task(beta / 'queue', 'pending', 'B-2', 'beta only')
        registry = [
            {'label': 'alpha', 'pipelineDir': str(alpha), 'repoRoot': str(alpha), 'domainsPath': None},
            {'label': 'beta', 'pipelineDir': str(beta), 'repoRoot': str(beta), 'domainsPath': None},
        ]
        for p in (
            mock.patch.object(qpf, '_registry', return_value=registry),
            mock.patch.object(dash_app, 'queue_dir', return_value=None),
        ):
            p.start()
            self.addCleanup(p.stop)
        qpf.queue_filter_stats.clear()
        self.client = dash_app.app.test_client()

    def _rows(self, query):
        res = self.client.get('/api/queue' + query)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        return {r['id']: r for r in res.get_json()}

    def test_all_returns_every_project(self):
        rows = self._rows('?project=all')
        self.assertEqual(set(rows), {'A-1', 'A-2', 'B-1', 'B-2'})
        self.assertEqual(rows['B-2']['project'], 'beta')

    def test_cross_project_dependency_survives_filter(self):
        rows = self._rows('?project=alpha')
        self.assertIn('A-1', rows)
        self.assertNotIn('B-1', rows)
        self.assertEqual(rows['A-1']['dependsOn'], [
            {'taskId': 'B-1', 'state': 'done', 'project': 'beta'}])

    def test_slug_filter_excludes_other_projects(self):
        self.assertEqual(set(self._rows('?project=beta')), {'B-1', 'B-2'})

    def test_missing_dependency_is_kept_with_nulls(self):
        rows = self._rows('?project=alpha')
        self.assertEqual(rows['A-2']['dependsOn'], [
            {'taskId': 'GHOST', 'state': None, 'project': None}])

    def test_unknown_project_is_400(self):
        res = self.client.get('/api/queue?project=nonexistent')
        self.assertEqual(res.status_code, 400)

    def test_dismissal_counters(self):
        self._rows('?project=alpha')
        self.assertEqual(qpf.queue_filter_stats.get('excluded_by_project:beta'), 2)
        self.assertEqual(qpf.queue_filter_stats.get('unresolved_dependency'), 1)


if __name__ == '__main__':
    unittest.main()
