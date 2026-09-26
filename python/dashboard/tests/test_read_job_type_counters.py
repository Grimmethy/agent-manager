import json
import os
import tempfile
from pathlib import Path

import pytest

from app import read_job_type_counters


def test_read_job_type_counters_rejects_non_dict_json():
    """When job-type-counters.json contains valid JSON that is not an object
    (e.g. a list), read_job_type_counters must return {} rather than the
    non-dict value, so that callers can safely call .get()."""
    with tempfile.TemporaryDirectory() as tmpdir:
        counters_file = Path(tmpdir) / "job-type-counters.json"
        counters_file.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
        os.environ["AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH"] = str(counters_file)
        try:
            result = read_job_type_counters()
        finally:
            del os.environ["AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH"]
        assert result == {}


def test_read_job_type_counters_rejects_scalar_json():
    """A bare JSON string (valid JSON, not an object) must also yield {}."""
    with tempfile.TemporaryDirectory() as tmpdir:
        counters_file = Path(tmpdir) / "job-type-counters.json"
        counters_file.write_text('"hello"', encoding="utf-8")
        os.environ["AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH"] = str(counters_file)
        try:
            result = read_job_type_counters()
        finally:
            del os.environ["AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH"]
        assert result == {}


def test_read_job_type_counters_still_returns_dict_when_valid():
    """A proper JSON object must still be returned unchanged."""
    with tempfile.TemporaryDirectory() as tmpdir:
        counters_file = Path(tmpdir) / "job-type-counters.json"
        data = {"trouble_log": 5, "arch_review": 2}
        counters_file.write_text(json.dumps(data), encoding="utf-8")
        os.environ["AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH"] = str(counters_file)
        try:
            result = read_job_type_counters()
        finally:
            del os.environ["AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH"]
        assert result == data
