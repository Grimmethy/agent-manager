"""Run: .venv/bin/python -m unittest python.dashboard.tests.test_touchpoints_card"""
import sys
import tempfile
import unittest
from pathlib import Path

DASH = Path(__file__).parent.parent
sys.path.insert(0, str(DASH))


class TouchpointsCardWiring(unittest.TestCase):
    def test_template_has_chip_and_script_before_live_updates(self):
        html = (DASH / "templates" / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="touchpoints-chip"', html)
        self.assertLess(html.index("touchpoints-card.js"), html.index("live-updates.js"))

    def test_stream_has_a_touchpoint_change_provider(self):
        from routes import event_stream as routes_event_stream
        self.assertIn("touchpoints-changed", routes_event_stream._providers())

    def test_provider_watches_the_db_and_its_wal(self):
        from routes import event_stream as routes_event_stream
        import app
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "requeue-attribution.db"
            old = app._requeue_attribution_db_path
            app._requeue_attribution_db_path = lambda: db
            try:
                files = routes_event_stream._touchpoint_files()
            finally:
                app._requeue_attribution_db_path = old
        self.assertEqual([Path(f).name for f in files], ["requeue-attribution.db", "requeue-attribution.db-wal"])

    def test_the_hub_accepts_the_providers_so_the_stream_route_does_not_500(self):
        # event_stream.Hub refuses a provider whose name does not end in -changed; that would break GET /api/stream for every page.
        import event_stream
        from routes import event_stream as routes_event_stream
        providers = routes_event_stream._providers()
        self.assertTrue(all(n.endswith("-changed") for n in providers))
        event_stream.Hub(lambda: {"queue": "/nonexistent", "instances": "/nonexistent", "plugins": "/nonexistent"}, providers=providers)


if __name__ == "__main__":
    unittest.main()
