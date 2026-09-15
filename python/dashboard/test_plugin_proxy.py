"""Tests for routes/plugin_proxy.py -- the generic reverse proxy Phase 3 of the
Chat-plugin extraction adds (see /home/wok/.claude/plans/immutable-noodling-axolotl.md).

Run: .venv/bin/python -m unittest python.dashboard.test_plugin_proxy -v
"""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402


def _manifest(entries):
    return mock.patch.object(app, "_read_plugins_manifest", return_value=entries)


class PluginProxyTest(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_404_when_no_active_plugin_of_that_name(self):
        with _manifest([]):
            res = self.client.get("/api/plugins/agent-manager-chat-plugin/proxy/api/chat/active")
            self.assertEqual(res.status_code, 404)

    def test_404_when_plugin_is_enabled_but_not_active(self):
        with _manifest([{"name": "agent-manager-chat-plugin", "enabled": True, "active": False,
                          "url": "http://localhost:7442", "proxy": {"prefix": "/api/chat"}}]):
            res = self.client.get("/api/plugins/agent-manager-chat-plugin/proxy/api/chat/active")
            self.assertEqual(res.status_code, 404)

    def test_404_when_plugin_has_no_proxy_block(self):
        with _manifest([{"name": "agent-manager-chat-plugin", "active": True,
                          "url": "http://localhost:7442"}]):
            res = self.client.get("/api/plugins/agent-manager-chat-plugin/proxy/api/chat/active")
            self.assertEqual(res.status_code, 404)

    def test_non_sse_get_proxies_and_passes_through_the_body(self):
        entry = {"name": "agent-manager-chat-plugin", "active": True,
                  "url": "http://localhost:7442", "proxy": {"prefix": "/api/chat"}}
        fake_response = mock.MagicMock()
        fake_response.read.return_value = b'{"ok": true}'
        fake_response.headers = {"Content-Type": "application/json"}
        fake_response.__enter__ = lambda self: fake_response
        fake_response.__exit__ = lambda self, *a: None
        with _manifest([entry]), mock.patch("urllib.request.urlopen", return_value=fake_response) as m:
            res = self.client.get("/api/plugins/agent-manager-chat-plugin/proxy/api/chat/active")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.get_json(), {"ok": True})
            called_req = m.call_args[0][0]
            self.assertEqual(called_req.full_url, "http://localhost:7442/api/chat/active")

    def test_non_sse_post_forwards_the_request_body_and_query_string(self):
        entry = {"name": "agent-manager-chat-plugin", "active": True,
                  "url": "http://localhost:7442", "proxy": {"prefix": "/api/chat"}}
        fake_response = mock.MagicMock()
        fake_response.read.return_value = b'{"id": "s1"}'
        fake_response.headers = {"Content-Type": "application/json"}
        fake_response.__enter__ = lambda self: fake_response
        fake_response.__exit__ = lambda self, *a: None
        with _manifest([entry]), mock.patch("urllib.request.urlopen", return_value=fake_response) as m:
            res = self.client.post(
                "/api/plugins/agent-manager-chat-plugin/proxy/api/chat/new?x=1",
                json={"provider": "claude"},
            )
            self.assertEqual(res.status_code, 200)
            called_req = m.call_args[0][0]
            self.assertEqual(called_req.full_url, "http://localhost:7442/api/chat/new?x=1")
            self.assertEqual(called_req.method, "POST")
            self.assertEqual(json.loads(called_req.data), {"provider": "claude"})

    def test_upstream_http_error_is_passed_through_with_its_own_status(self):
        entry = {"name": "agent-manager-chat-plugin", "active": True,
                  "url": "http://localhost:7442", "proxy": {"prefix": "/api/chat"}}
        import urllib.error
        err = urllib.error.HTTPError("http://x", 404, "not found", {"Content-Type": "application/json"}, None)
        err.read = lambda: b'{"error": "no such session"}'
        with _manifest([entry]), mock.patch("urllib.request.urlopen", side_effect=err):
            res = self.client.get("/api/plugins/agent-manager-chat-plugin/proxy/api/chat/bogus-session")
            self.assertEqual(res.status_code, 404)

    def test_connection_failure_is_a_502_not_a_500(self):
        entry = {"name": "agent-manager-chat-plugin", "active": True,
                  "url": "http://localhost:7442", "proxy": {"prefix": "/api/chat"}}
        with _manifest([entry]), mock.patch("urllib.request.urlopen", side_effect=OSError("refused")):
            res = self.client.get("/api/plugins/agent-manager-chat-plugin/proxy/api/chat/active")
            self.assertEqual(res.status_code, 502)

    def test_sse_request_streams_via_requests_not_urllib(self):
        entry = {"name": "agent-manager-chat-plugin", "active": True,
                  "url": "http://localhost:7442",
                  "proxy": {"prefix": "/api/chat", "sse": True, "readTimeoutS": 3660}}

        fake_upstream = mock.MagicMock()
        fake_upstream.iter_content.return_value = [b'data: {"type": "chunk"}\n\n', b'data: {"type": "final"}\n\n']
        fake_upstream.__enter__ = lambda self: fake_upstream
        fake_upstream.__exit__ = lambda self, *a: None

        with _manifest([entry]), \
             mock.patch("urllib.request.urlopen") as m_urllib, \
             mock.patch("requests.request", return_value=fake_upstream) as m_requests:
            res = self.client.post(
                "/api/plugins/agent-manager-chat-plugin/proxy/api/chat/s1/message",
                json={"message": "hi"},
                headers={"Accept": "text/event-stream"},
            )
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.mimetype, "text/event-stream")
            body = res.get_data(as_text=True)
            self.assertIn('"type": "chunk"', body)
            self.assertIn('"type": "final"', body)
            m_urllib.assert_not_called()
            kwargs = m_requests.call_args
            self.assertEqual(kwargs.kwargs["timeout"], (5, 3660))

    def test_non_sse_declared_plugin_never_streams_even_with_the_accept_header(self):
        # proxy.sse is not set -- Accept: text/event-stream alone must not trigger
        # the streaming path for a plugin that never declared it.
        entry = {"name": "agent-manager-hardware-plugin", "active": True,
                  "url": "http://localhost:7440", "proxy": {"prefix": "/api/hardware"}}
        fake_response = mock.MagicMock()
        fake_response.read.return_value = b'{"ok": true}'
        fake_response.headers = {"Content-Type": "application/json"}
        fake_response.__enter__ = lambda self: fake_response
        fake_response.__exit__ = lambda self, *a: None
        with _manifest([entry]), \
             mock.patch("urllib.request.urlopen", return_value=fake_response) as m_urllib, \
             mock.patch("requests.request") as m_requests:
            res = self.client.get(
                "/api/plugins/agent-manager-hardware-plugin/proxy/api/hardware/stats",
                headers={"Accept": "text/event-stream"},
            )
            self.assertEqual(res.status_code, 200)
            m_urllib.assert_called_once()
            m_requests.assert_not_called()


if __name__ == "__main__":
    unittest.main()
