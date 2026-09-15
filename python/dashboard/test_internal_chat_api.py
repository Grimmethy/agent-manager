"""Tests for routes/internal_chat.py -- the internal API Phase 2 of the Chat-plugin
extraction adds (see /home/wok/.claude/plans/immutable-noodling-axolotl.md). Additive
only: these routes are new and unused by the still-live in-tree routes/chat.py.

Run: .venv/bin/python -m unittest python.dashboard.test_internal_chat_api -v
"""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import app  # noqa: E402
import routes.internal_chat as internal_chat  # noqa: E402

TOKEN = "test-token-abc123"


class InternalChatApiTest(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        self._env_patch = mock.patch.dict("os.environ", {"AGENT_MANAGER_INTERNAL_TOKEN": TOKEN})
        self._env_patch.start()

    def tearDown(self):
        self._env_patch.stop()

    def _post(self, path, body=None, token=TOKEN):
        headers = {"X-Internal-Token": token} if token is not None else {}
        return self.client.post(path, json=body or {}, headers=headers)

    def _get(self, path, token=TOKEN):
        headers = {"X-Internal-Token": token} if token is not None else {}
        return self.client.get(path, headers=headers)

    # --- auth ---------------------------------------------------------------------------

    def test_missing_token_header_is_403(self):
        res = self._get("/api/internal/chat/roots", token=None)
        self.assertEqual(res.status_code, 403)

    def test_wrong_token_is_403(self):
        res = self._get("/api/internal/chat/roots", token="wrong")
        self.assertEqual(res.status_code, 403)

    def test_unconfigured_token_is_500(self):
        with mock.patch.dict("os.environ", {}, clear=True), \
             mock.patch.object(app, "read_env_file", return_value={}):
            res = self._get("/api/internal/chat/roots", token=TOKEN)
            self.assertEqual(res.status_code, 500)

    # --- roots ----------------------------------------------------------------------------

    def test_roots_wraps_chat_roots(self):
        with mock.patch.object(app, "_chat_roots", return_value=["/a", "/b"]):
            res = self._get("/api/internal/chat/roots")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.get_json(), {"roots": ["/a", "/b"]})

    # --- preempt --------------------------------------------------------------------------

    def test_preempt_disabled_returns_empty_without_calling_the_real_preempt(self):
        with mock.patch.object(app, "_chat_preempt_enabled", return_value=False), \
             mock.patch.object(app, "_preempt_pipeline_for_chat") as m:
            res = self._post("/api/internal/chat/preempt")
            self.assertEqual(res.get_json(), {"preempted": []})
            m.assert_not_called()

    def test_preempt_enabled_calls_the_real_preempt_and_returns_its_summary(self):
        summary = [{"lane": "worker-1", "action": "killed", "taskId": "t-1", "ageSeconds": None}]
        with mock.patch.object(app, "_chat_preempt_enabled", return_value=True), \
             mock.patch.object(app, "_preempt_pipeline_for_chat", return_value=summary):
            res = self._post("/api/internal/chat/preempt")
            self.assertEqual(res.get_json(), {"preempted": summary})

    def test_preempt_swallows_an_exception_rather_than_500ing(self):
        with mock.patch.object(app, "_chat_preempt_enabled", return_value=True), \
             mock.patch.object(app, "_preempt_pipeline_for_chat", side_effect=RuntimeError("boom")):
            res = self._post("/api/internal/chat/preempt")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.get_json()["preempted"], [])

    # --- reserve --------------------------------------------------------------------------

    def test_reserve_requires_reservation_id(self):
        res = self._post("/api/internal/chat/reserve", {"on": True, "model": "m"})
        self.assertEqual(res.status_code, 400)

    def test_reserve_claim_requires_model(self):
        res = self._post("/api/internal/chat/reserve", {"reservationId": "s1", "on": True})
        self.assertEqual(res.status_code, 400)

    def test_reserve_claim_acquires_the_lock_and_records_it(self):
        with mock.patch.object(app, "instances_dir", return_value=Path("/inst")), \
             mock.patch("single_flight_lock.acquire", return_value="fake-fh") as m_acquire:
            res = self._post("/api/internal/chat/reserve", {"reservationId": "s1", "model": "m", "on": True})
            self.assertEqual(res.get_json(), {"reservationId": "s1", "reserved": True})
            m_acquire.assert_called_once_with(Path("/inst"), "m")
            self.assertIn("s1", internal_chat._internal_chat_reservations)
        # cleanup so this test doesn't leak state into others
        internal_chat._internal_chat_reservations.pop("s1", None)

    def test_reserve_release_releases_the_lock_and_forgets_it(self):
        internal_chat._internal_chat_reservations["s2"] = {"fh": "fake-fh", "lastActivity": 0}
        with mock.patch("single_flight_lock.release") as m_release:
            res = self._post("/api/internal/chat/reserve", {"reservationId": "s2", "on": False})
            self.assertEqual(res.get_json(), {"reservationId": "s2", "reserved": False})
            m_release.assert_called_once_with("fake-fh")
            self.assertNotIn("s2", internal_chat._internal_chat_reservations)

    def test_reserve_no_instances_dir_aborts_and_does_not_leave_a_stuck_claim(self):
        with mock.patch.object(app, "instances_dir", return_value=None):
            res = self._post("/api/internal/chat/reserve", {"reservationId": "s3", "model": "m", "on": True})
            self.assertEqual(res.status_code, 500)
            self.assertNotIn("s3", internal_chat._internal_chat_reservations)

    def test_reserve_claim_again_while_already_on_refreshes_lastActivity_without_reacquiring(self):
        internal_chat._internal_chat_reservations["s4"] = {"fh": "fake-fh", "lastActivity": 0}
        with mock.patch("single_flight_lock.acquire") as m_acquire:
            res = self._post("/api/internal/chat/reserve", {"reservationId": "s4", "model": "m", "on": True})
            self.assertEqual(res.get_json(), {"reservationId": "s4", "reserved": True})
            m_acquire.assert_not_called()
            self.assertGreater(internal_chat._internal_chat_reservations["s4"]["lastActivity"], 0)
        internal_chat._internal_chat_reservations.pop("s4", None)

    # --- local-turn -----------------------------------------------------------------------

    def test_local_turn_streams_events_from_stream_plan_with_tools(self):
        def fake_stream(**kwargs):
            self.assertEqual(kwargs["prompt"], "hi")
            self.assertEqual(kwargs["max_turns"], 7)
            self.assertTrue(kwargs["allow_write"])
            yield {"type": "chunk", "text": "a"}
            yield {"type": "final", "response": "a"}

        with mock.patch("local_tool_client.stream_plan_with_tools", side_effect=fake_stream):
            res = self._post("/api/internal/chat/local-turn", {
                "prompt": "hi", "maxTurns": 7, "allowWrite": True,
            })
            self.assertEqual(res.status_code, 200)
            body = res.get_data(as_text=True)
            self.assertIn('"type": "chunk"', body)
            self.assertIn('"type": "final"', body)

    def test_local_turn_surfaces_a_tool_client_error_as_an_sse_error_event(self):
        from local_tool_client import LocalToolClientError

        def fake_stream(**kwargs):
            raise LocalToolClientError("node blew up")
            yield  # pragma: no cover -- makes this a generator

        with mock.patch("local_tool_client.stream_plan_with_tools", side_effect=fake_stream):
            res = self._post("/api/internal/chat/local-turn", {"prompt": "hi"})
            body = res.get_data(as_text=True)
            self.assertIn('"type": "error"', body)
            self.assertIn("node blew up", body)

    def test_local_turn_holds_the_priority_marker_for_the_whole_call(self):
        # 2026-09-15 regression: this route's first draft never held
        # single_flight_lock.priority_marker() at all -- without it, a worker/reviewer
        # daemon can respawn and reclaim the GPU BETWEEN this tool-loop's own turns
        # (confirmed live 2026-09-02, the original incident priority_marker exists for).
        marker_active_during_call = []

        class FakeMarkerCm:
            def __enter__(self_inner):
                marker_active_during_call.append(True)
                return self_inner

            def __exit__(self_inner, *a):
                marker_active_during_call.append(False)

        def fake_stream(**kwargs):
            # The marker must already be held by the time the tool loop actually runs.
            self.assertEqual(marker_active_during_call, [True])
            yield {"type": "final", "response": "ok"}

        with mock.patch.object(app, "instances_dir", return_value=Path("/inst")), \
             mock.patch("single_flight_lock.priority_marker", return_value=FakeMarkerCm()) as m_marker, \
             mock.patch("local_tool_client.stream_plan_with_tools", side_effect=fake_stream):
            res = self._post("/api/internal/chat/local-turn", {"prompt": "hi"})
            res.get_data()  # force the streaming generator to actually run
            m_marker.assert_called_once_with(Path("/inst"))
            self.assertEqual(marker_active_during_call, [True, False], "marker must be released after the call finishes")

    def test_local_turn_with_no_instances_dir_still_streams_without_a_marker(self):
        def fake_stream(**kwargs):
            yield {"type": "final", "response": "ok"}

        with mock.patch.object(app, "instances_dir", return_value=None), \
             mock.patch("single_flight_lock.priority_marker") as m_marker, \
             mock.patch("local_tool_client.stream_plan_with_tools", side_effect=fake_stream):
            res = self._post("/api/internal/chat/local-turn", {"prompt": "hi"})
            self.assertIn('"type": "final"', res.get_data(as_text=True))
            m_marker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
