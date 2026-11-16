'''Tests for GET /api/reports paging (routes/reports.py).

Run: python3 python/dashboard/test_reports_routes.py -v
'''
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402

PERIODS = {'hourly': 10, 'daily': 12, 'weekly': 8}
BASE_MTIME = 1700000000


class ReportsRoutesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        sb = Path(tmp.name)
        root = sb / 'Agent Manager Reports'
        items = []
        n = 0
        for period, count in PERIODS.items():
            d = root / period
            d.mkdir(parents=True)
            for i in range(count):
                name = '%s-%02d.md' % (period, i)
                p = d / name
                p.write_text('# report', encoding='utf-8')
                mtime = BASE_MTIME + n * 3600
                os.utime(p, (mtime, mtime))
                items.append((mtime, period, name))
                n += 1
        items.sort(reverse=True)
        self.all_items = [(period, name) for _, period, name in items]
        patcher = mock.patch.object(app, 'second_brain_dir', return_value=sb)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = app.app.test_client()

    def _get(self, qs=''):
        return self.client.get('/api/reports' + qs)

    @staticmethod
    def _pairs(reports):
        return [(r['period'], r['filename']) for r in reports]

    def test_no_params_returns_the_bare_array_unchanged(self):
        res = self._get()
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertIsInstance(body, list)
        self.assertEqual(self._pairs(body), self.all_items)

    def test_limit_24_offset_0_returns_first_page_newest_first(self):
        res = self._get('?limit=24&offset=0')
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertIsInstance(body['total'], int)
        self.assertEqual(body['total'], 30)
        self.assertEqual(len(body['reports']), 24)
        self.assertEqual(self._pairs(body['reports']), self.all_items[:24])

    def test_offset_past_end_gives_empty_page_with_same_total(self):
        res = self._get('?limit=24&offset=40')
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertEqual(body['reports'], [])
        self.assertEqual(body['total'], 30)

    def test_invalid_limit_or_offset_is_400(self):
        for qs in ('?limit=abc', '?limit=0', '?limit=-1', '?offset=abc', '?offset=-1'):
            with self.subTest(qs=qs):
                self.assertEqual(self._get(qs).status_code, 400)

    def test_period_filter_changes_total(self):
        res = self._get('?limit=24&offset=0&period=daily')
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertEqual(body['total'], PERIODS['daily'])
        self.assertLess(body['total'], 30)
        want = [x for x in self.all_items if x[0] == 'daily']
        self.assertEqual(self._pairs(body['reports']), want)


if __name__ == '__main__':
    unittest.main()
