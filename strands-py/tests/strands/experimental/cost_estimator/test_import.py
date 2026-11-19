"""Tests for importing the cost estimator without its optional dependency."""

import importlib
import sys

import pytest


def test_import_without_genai_prices_names_the_python_version_and_the_extra(monkeypatch):
    for module in ("strands.experimental.cost_estimator", "strands.experimental.cost_estimator.plugin"):
        monkeypatch.delitem(sys.modules, module, raising=False)
    monkeypatch.setitem(sys.modules, "genai_prices", None)

    with pytest.raises(ImportError, match=r"Python 3\.11\+.*pip install 'strands-agents\[cost-estimation\]'"):
        importlib.import_module("strands.experimental.cost_estimator")
