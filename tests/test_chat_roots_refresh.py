"""Roots refresh, registry validation warnings and the register-repo route.

Every test points app.PROJECT_REGISTRY_PATH at a temp file; the real projects.json is never read or written.

Run: .venv/bin/python -m unittest tests.test_chat_roots_refresh -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python" / "dashboard"))

import app  # noqa: E402
import chat_sessions  # noqa: E402


class _Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.registry = self.tmp / "projects.json"
        self.storage = self.tmp / "chat-storage"
        self.storage.mkdir()
        for p in (
            mock.patch.object(app, "PROJECT_REGISTRY_PATH", self.registry),
            mock.patch.object(app, "_read_plugins_manifest", lambda *a, **k: []),
        ):
            p.start()
            self.addCleanup(p.stop)

    def make_entry(self, name="proj", **overrides):
        repo = self.tmp / name
        pipe = self.tmp / f"{name}-pipeline"
        repo.mkdir(exist_ok=True)
        pipe.mkdir(exist_ok=True)
        domains = pipe / "task-domains.json"
        domains.write_text("{}", encoding="utf-8")
        entry = {"repoRoot": str(repo), "pipelineDir": str(pipe), "domainsPath": str(domains), "label": name}
        entry.update(overrides)
        return entry

    def write_registry(self, entries):
        self.registry.write_text(json.dumps(entries), encoding="utf-8")


class SessionRootsRefreshTest(_Base):
    def test_new_registry_entry_appears_in_active_session_without_new_session(self):
        paths = [self.registry]
        first = chat_sessions.get_active_session(self.storage, app._chat_roots(), registry_paths=paths)
        sid = first["id"]
        roots_before = list(first["roots"])
        entry = self.make_entry("fresh")
        new_root = os.path.realpath(entry["repoRoot"])
        self.assertNotIn(new_root, roots_before)

        self.write_registry([entry])
        st = self.registry.stat()
        os.utime(self.registry, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))

        second = chat_sessions.get_active_session(self.storage, app._chat_roots(), registry_paths=paths)
        self.assertEqual(second["id"], sid)
        self.assertIn(new_root, second["roots"])
        self.assertEqual(second["repoRoot"], roots_before[0])
        self.assertNotEqual(second["rootsMtime"], first["rootsMtime"])


class RegistryWarningsTest(_Base):
    def reasons(self):
        return [w for w in app.get_registry_warnings()]

    def test_valid_entry_has_no_problems_and_no_warning(self):
        entry = self.make_entry()
        self.assertEqual(app.validate_project_entry(entry), [])
        self.write_registry([entry])
        roots = app._chat_roots()
        self.assertIn(os.path.realpath(entry["repoRoot"]), roots)
        self.assertEqual(app.get_registry_warnings(), [])

    def test_pipeline_dir_equal_repo_root(self):
        entry = self.make_entry()
        entry["pipelineDir"] = entry["repoRoot"]
        self.assertTrue(app.validate_project_entry(entry))
        self.write_registry([entry])
        app._chat_roots()
        warnings = self.reasons()
        self.assertTrue(any(w["reason"] and w["entry"] == entry for w in warnings), warnings)

    def test_missing_domains_path(self):
        entry = self.make_entry()
        entry["domainsPath"] = str(self.tmp / "nope" / "task-domains.json")
        self.assertTrue(app.validate_project_entry(entry))
        self.write_registry([entry])
        app._chat_roots()
        self.assertTrue(any(w["entry"] == entry and w["reason"] for w in self.reasons()))

    def test_missing_repo_root(self):
        entry = self.make_entry()
        entry["repoRoot"] = str(self.tmp / "does-not-exist")
        self.assertTrue(app.validate_project_entry(entry))
        self.write_registry([entry])
        roots = app._chat_roots()
        self.assertNotIn(os.path.realpath(entry["repoRoot"]), roots)
        self.assertTrue(any(w["entry"] == entry and w["reason"] for w in self.reasons()))

    def test_corrupt_json(self):
        self.registry.write_text("{not json", encoding="utf-8")
        roots = app._chat_roots()
        self.assertTrue(roots)
        warnings = self.reasons()
        self.assertTrue(warnings)
        self.assertTrue(all(w["reason"] for w in warnings))
        self.assertIn("corrupt", warnings[0]["reason"])


class RegisterRouteTest(_Base):
    def test_register_repo_creates_files_records_entry_and_adds_one_root(self):
        repo = self.tmp / "newrepo"
        repo.mkdir()
        pipe = self.tmp / "newrepo-pipeline"
        domains = pipe / "task-domains.json"
        self.assertFalse(pipe.exists())

        real_record = app.record_project_registry_entry
        calls = []

        def spy(*args, **kwargs):
            calls.append(args)
            return real_record(*args, **kwargs)

        client = app.app.test_client()
        headers = {"X-Internal-Token": "test-token"}
        body = {"path": str(repo)}
        with mock.patch.dict(os.environ, {"AGENT_MANAGER_INTERNAL_TOKEN": "test-token"}), \
                mock.patch.object(app, "record_project_registry_entry", spy):
            resp = client.post("/api/internal/chat/register-repo", json=body, headers=headers)
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        data = resp.get_json()
        for key in ("rootsBefore", "rootsAfter", "registered", "warnings"):
            self.assertIn(key, data)
        self.assertTrue(calls, "record_project_registry_entry was not called")
        self.assertTrue(pipe.is_dir())
        self.assertTrue(domains.is_file())
        self.assertEqual(len(data["rootsAfter"]), len(data["rootsBefore"]) + 1)
        self.assertIn(os.path.realpath(str(repo)), data["rootsAfter"])
        self.assertNotIn(os.path.realpath(str(repo)), data["rootsBefore"])
        saved = json.loads(self.registry.read_text(encoding="utf-8"))
        self.assertEqual(os.path.normpath(saved[0]["repoRoot"]), os.path.normpath(str(repo)))


if __name__ == "__main__":
    unittest.main()
