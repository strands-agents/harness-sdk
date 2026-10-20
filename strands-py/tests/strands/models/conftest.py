"""Pytest configuration for model tests."""

import sys
import unittest.mock

import pytest

from strands.models import _native_output

# Mock OpenAI version check before the openai_responses module is imported.
# This is necessary because the version check happens at module import time.
# We patch importlib.metadata.version directly since that's where get_package_version comes from.
if "strands.models.openai_responses" not in sys.modules:
    _original_version = None
    try:
        from importlib.metadata import version as _original_version_func

        _original_version = _original_version_func
    except ImportError:
        pass

    def _mock_version(package_name: str) -> str:
        if package_name == "openai":
            return "2.0.0"
        if _original_version:
            return _original_version(package_name)
        raise Exception(f"Package {package_name} not found")

    unittest.mock.patch("importlib.metadata.version", _mock_version).start()


@pytest.fixture(autouse=True)
def native_output_caches(monkeypatch):
    """Isolate the structured output support each test learns from the process-global caches."""
    monkeypatch.setattr(_native_output, "_UNSUPPORTED_MECHANISMS", {})
    monkeypatch.setattr(_native_output, "_REJECTED_NATIVE_SCHEMAS", set())
