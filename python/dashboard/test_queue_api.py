# Tests for GET /api/queue (HUB0510 1/3): project filter + dependency resolution.
import builtins
import json
import math
import os
import shutil
import sys
import tempfile
import time
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


class QueueStateLatencyTests(unittest.TestCase):
    # /api/queue/<state>?project=... paging, latency and body reads (HUB0776 3/3).
    PROJECTS = ('alpha', 'beta', 'gamma')
    PER_PROJECT = 500
    URL = '/api/queue/pending?project=all&limit=10&offset=0'

    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.tmp = tmp
        self.addCleanup(shutil.rmtree, tmp, True)
        n = len(self.PROJECTS)
        for pi, proj in enumerate(self.PROJECTS):
            other = self.PROJECTS[(pi + 1) % n]
            for i in range(self.PER_PROJECT):
                deps = ['%s-%04d' % (other, i)] if i % 5 == 0 else []
                _write_task(tmp / proj / 'queue', 'pending',
                            '%s-%04d' % (proj, i), 'task %d in %s' % (i, proj), depends=deps)
        registry = [
            {'label': p, 'pipelineDir': str(tmp / p), 'repoRoot': str(tmp / p), 'domainsPath': None}
            for p in self.PROJECTS
        ]
        # The page index resolves projects via app.read_project_registry (lazy import),
        # so patch that too; the test never imports the index module itself.
        for p in (
            mock.patch.object(qpf, '_registry', return_value=registry),
            mock.patch.object(dash_app, 'read_project_registry', return_value=registry),
            mock.patch.object(dash_app, 'queue_dir', return_value=None),
        ):
            p.start()
            self.addCleanup(p.stop)
        qpf.queue_filter_stats.clear()
        self.client = dash_app.app.test_client()
        self.total = n * self.PER_PROJECT

    def _get(self, url):
        res = self.client.get(url)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        return res.get_json()

    def test_p95_latency_under_2s(self):
        self._get(self.URL)  # warm-up
        times = []
        for _ in range(20):
            t0 = time.perf_counter()
            data = self._get(self.URL)
            times.append(time.perf_counter() - t0)
            self.assertEqual(len(data['items']), 10)
        times.sort()
        p95 = times[math.ceil(0.95 * len(times)) - 1]
        self.assertLess(p95, 2.0, 'p95=%.3fs' % p95)

    def test_limit_10_reads_at_most_about_10_bodies(self):
        self._get(self.URL)  # warm the index
        reads = []
        real_open = builtins.open
        real_path_open = Path.open
        root = str(self.tmp)

        def _count(f):
            s = str(f)
            if s.startswith(root) and s.endswith('.json'):
                reads.append(s)

        def fake_open(file, *a, **kw):
            _count(file)
            return real_open(file, *a, **kw)

        def fake_path_open(self_path, *a, **kw):
            _count(self_path)
            return real_path_open(self_path, *a, **kw)

        with mock.patch.object(builtins, 'open', fake_open), \
                mock.patch.object(Path, 'open', fake_path_open):
            data = self._get(self.URL)
        self.assertEqual(len(data['items']), 10)
        # 10 page bodies plus a little slack for incidental reads.
        self.assertLessEqual(len(reads), 15, reads)

    def test_paging_disjoint_total_and_shape(self):
        seen = []
        for offset in (0, 10, 20):
            data = self._get('/api/queue/pending?project=all&limit=10&offset=%d' % offset)
            self.assertEqual(set(data), {'items', 'total'})
            self.assertEqual(data['total'], self.total)
            self.assertEqual(len(data['items']), 10)
            for item in data['items']:
                for key in ('id', 'title', 'state', 'project', 'dependsOn'):
                    self.assertIn(key, item)
                self.assertEqual(item['state'], 'pending')
            seen.append([it['id'] for it in data['items']])
        flat = [i for page in seen for i in page]
        self.assertEqual(len(flat), len(set(flat)))
        self.assertEqual(flat, sorted(flat))

    def test_cross_project_depends_on_resolved(self):
        data = self._get(self.URL)
        first = data['items'][0]
        self.assertEqual(first['id'], 'alpha-0000')
        self.assertEqual(first['project'], 'alpha')
        self.assertEqual(first['dependsOn'], [
            {'taskId': 'beta-0000', 'state': 'pending', 'project': 'beta'}])

    def test_cache_invalidated_by_new_task_file(self):
        self.assertEqual(self._get(self.URL)['total'], self.total)
        _write_task(self.tmp / 'alpha' / 'queue', 'pending', 'alpha-9999', 'brand new',
                    depends=['gamma-0000'])
        # Bump mtimes explicitly so coarse filesystem timestamps cannot hide the change.
        bump = time.time_ns() + 5_000_000_000
        state_dir = self.tmp / 'alpha' / 'queue' / 'pending'
        for p in (state_dir, state_dir / 'alpha-9999.json'):
            os.utime(p, ns=(bump, bump))
        data = self._get('/api/queue/pending?project=all&limit=2000&offset=0')
        self.assertEqual(data['total'], self.total + 1)
        rows = {it['id']: it for it in data['items']}
        self.assertIn('alpha-9999', rows)
        self.assertEqual(rows['alpha-9999']['dependsOn'], [
            {'taskId': 'gamma-0000', 'state': 'pending', 'project': 'gamma'}])


if __name__ == '__main__':
    unittest.main()
