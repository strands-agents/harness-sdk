"""Tests for importing the cost estimator when its optional dependency cannot be used."""

import importlib
import sys
import types

import pytest


@pytest.mark.parametrize(
    ("python_version", "genai_prices", "exp_reason"),
    [
        ((3, 10), None, "requires Python 3.11 or later; InvocationContext.usage_by_model works without it"),
        (
            (3, 11),
            None,
            "requires the genai-prices package. Install with: pip install 'strands-agents[cost-estimator]'",
        ),
        (
            (3, 11),
            types.ModuleType("genai_prices"),
            "supports genai-prices>=0.2.4,<0.3; the installed version is not compatible",
        ),
    ],
    ids=["python-3.10", "package-missing", "package-incompatible"],
)
def test_import_error_says_what_to_change(python_version, genai_prices, exp_reason, monkeypatch):
    for module in ("strands.vended_plugins.cost_estimator", "strands.vended_plugins.cost_estimator.plugin"):
        monkeypatch.delitem(sys.modules, module, raising=False)
    monkeypatch.setitem(sys.modules, "genai_prices", genai_prices)
    monkeypatch.setattr(sys, "version_info", python_version)

    with pytest.raises(ImportError) as error:
        importlib.import_module("strands.vended_plugins.cost_estimator")

    assert str(error.value) == f"strands.vended_plugins.cost_estimator {exp_reason}"
