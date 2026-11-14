"""Tests for response_compression.compress_response (the dashboard's gzip hook).

Run: .venv/bin/python -m unittest python.dashboard.test_response_compression -v
"""
import gzip
import sys
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask, Response

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
from response_compression import MIN_BYTES, compress_response  # noqa: E402

SCRIPT_URL = "/static/js/core-ui.js"
SCRIPT_FILE = Path(__file__).parent / "static" / "js" / "core-ui.js"
GZIP = {"Accept-Encoding": "gzip, deflate"}
BIG = ("x" * 80 + "\n") * 40  # well over MIN_BYTES and very compressible


def make_app():
    """A throwaway app with the real hook, one route per response shape the hook must tell apart."""
    a = Flask(__name__)
    a.after_request(compress_response)

    @a.route("/json")
    def json_route():
        return {"rows": ["row"] * 400}

    @a.route("/small")
    def small():
        return Response("tiny", mimetype="text/plain")

    @a.route("/sse-bytes")
    def sse_bytes():
        return Response(BIG, mimetype="text/event-stream")

    @a.route("/sse-stream")
    def sse_stream():
        return Response((BIG for _ in range(3)), mimetype="text/event-stream")

    @a.route("/text-stream")
    def text_stream():
        return Response((BIG for _ in range(3)), mimetype="text/plain")

    @a.route("/binary")
    def binary():
        return Response(b"\x00" * 5000, mimetype="application/octet-stream")

    @a.route("/encoded")
    def encoded():
        return Response(BIG, mimetype="text/plain", headers={"Content-Encoding": "br"})

    @a.route("/missing")
    def missing():
        return Response(BIG, status=404, mimetype="text/plain")

    return a.test_client()


class ThroughTheRealApp(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_hook_is_registered_on_the_real_app(self):
        self.assertIn(compress_response, app.app.after_request_funcs[None])

    def test_static_script_is_gzipped_and_round_trips(self):
        plain = self.client.get(SCRIPT_URL)
        self.assertNotIn("Content-Encoding", plain.headers)
        self.assertEqual(plain.data, SCRIPT_FILE.read_bytes())
        packed = self.client.get(SCRIPT_URL, headers=GZIP)
        self.assertEqual(packed.headers["Content-Encoding"], "gzip")
        self.assertIn("Accept-Encoding", packed.headers["Vary"])
        self.assertEqual(gzip.decompress(packed.data), plain.data)
        self.assertEqual(int(packed.headers["Content-Length"]), len(packed.data))
        self.assertLess(len(packed.data), len(plain.data) // 2)

    def test_compressed_copy_gets_a_weak_etag_and_the_plain_copy_keeps_its_strong_one(self):
        plain_tag = self.client.get(SCRIPT_URL).headers["ETag"]
        packed_tag = self.client.get(SCRIPT_URL, headers=GZIP).headers["ETag"]
        self.assertFalse(plain_tag.startswith("W/"))
        self.assertEqual(packed_tag, "W/" + plain_tag)

    def test_no_accept_encoding_gets_the_plain_body_but_still_varies(self):
        plain = self.client.get(SCRIPT_URL)
        self.assertEqual(plain.headers.get("Vary"), "Accept-Encoding")

    def test_gzip_refused_with_q_zero(self):
        resp = self.client.get(SCRIPT_URL, headers={"Accept-Encoding": "gzip;q=0"})
        self.assertNotIn("Content-Encoding", resp.headers)

    def test_conditional_request_still_returns_304(self):
        packed = self.client.get(SCRIPT_URL, headers=GZIP)
        tag = packed.headers["ETag"]
        again = self.client.get(SCRIPT_URL, headers={**GZIP, "If-None-Match": tag})
        self.assertEqual(again.status_code, 304)
        self.assertEqual(again.data, b"")
        self.assertNotIn("Content-Encoding", again.headers)

    def test_strong_tag_from_a_plain_fetch_revalidates_a_gzip_request(self):
        strong = self.client.get(SCRIPT_URL).headers["ETag"]
        again = self.client.get(SCRIPT_URL, headers={**GZIP, "If-None-Match": strong})
        self.assertEqual(again.status_code, 304)

    def test_plugin_proxy_reply_is_gzipped(self):
        upstream = mock.MagicMock()
        upstream.__enter__.return_value = upstream
        upstream.read.return_value = BIG.encode()
        upstream.headers.get.return_value = "text/javascript; charset=utf-8"
        entry = {"url": "http://plugin.invalid", "proxy": {}}
        with mock.patch("routes.plugin_proxy._proxy_entry", return_value=entry), \
                mock.patch("routes.plugin_proxy.urllib.request.urlopen", return_value=upstream):
            resp = self.client.get("/api/plugins/demo/proxy/static/chat.js", headers=GZIP)
        self.assertEqual(resp.headers["Content-Encoding"], "gzip")
        self.assertEqual(gzip.decompress(resp.data), BIG.encode())


class WhatTheHookLeavesAlone(unittest.TestCase):
    def setUp(self):
        self.client = make_app()

    def test_json_over_the_threshold_is_compressed(self):
        plain = self.client.get("/json")
        packed = self.client.get("/json", headers=GZIP)
        self.assertEqual(packed.headers["Content-Encoding"], "gzip")
        self.assertEqual(gzip.decompress(packed.data), plain.data)

    def test_body_under_the_threshold_is_not_compressed(self):
        resp = self.client.get("/small", headers=GZIP)
        self.assertLess(len(resp.data), MIN_BYTES)
        self.assertNotIn("Content-Encoding", resp.headers)
        self.assertEqual(resp.data, b"tiny")

    def test_event_stream_with_a_plain_body_is_not_compressed(self):
        resp = self.client.get("/sse-bytes", headers=GZIP)
        self.assertNotIn("Content-Encoding", resp.headers)
        self.assertEqual(resp.data, BIG.encode())

    def test_generator_event_stream_is_not_compressed(self):
        resp = self.client.get("/sse-stream", headers=GZIP)
        self.assertNotIn("Content-Encoding", resp.headers)
        self.assertEqual(resp.data, BIG.encode() * 3)

    def test_any_generator_body_is_not_compressed(self):
        resp = self.client.get("/text-stream", headers=GZIP)
        self.assertNotIn("Content-Encoding", resp.headers)
        self.assertEqual(resp.data, BIG.encode() * 3)

    def test_non_text_types_are_not_compressed(self):
        resp = self.client.get("/binary", headers=GZIP)
        self.assertNotIn("Content-Encoding", resp.headers)

    def test_an_already_encoded_reply_is_left_alone(self):
        resp = self.client.get("/encoded", headers=GZIP)
        self.assertEqual(resp.headers["Content-Encoding"], "br")
        self.assertEqual(resp.data, BIG.encode())

    def test_error_statuses_are_not_compressed(self):
        resp = self.client.get("/missing", headers=GZIP)
        self.assertEqual(resp.status_code, 404)
        self.assertNotIn("Content-Encoding", resp.headers)


if __name__ == "__main__":
    unittest.main()
