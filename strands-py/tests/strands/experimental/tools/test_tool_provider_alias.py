"""Tests to verify that experimental ToolProvider alias works with deprecation warning.

This test module ensures that the experimental ToolProvider alias maintains
backwards compatibility and can be used interchangeably with the actual
ToolProvider type from strands.tools.
"""

import importlib
import sys
import warnings

import pytest

from strands.tools import ToolProvider


def test_experimental_alias_is_same_type():
    """Verify that experimental ToolProvider alias is identical to the actual type."""

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        from strands.experimental.tools import ToolProvider as ExperimentalToolProvider

    assert ExperimentalToolProvider is ToolProvider


def test_deprecation_warning_on_import(captured_warnings):
    """Verify that importing ToolProvider from experimental emits deprecation warning."""
    # Clear the module from cache to trigger fresh import
    if "strands.experimental.tools" in sys.modules:
        del sys.modules["strands.experimental.tools"]

    # Clear any existing warnings
    captured_warnings.clear()

    # Import from experimental - this should trigger the warning
    from strands.experimental import tools

    _ = tools.ToolProvider

    assert len(captured_warnings) >= 1
    warning = captured_warnings[0]
    assert issubclass(warning.category, DeprecationWarning)
    assert "ToolProvider" in str(warning.message)
    assert "strands.tools" in str(warning.message)


def test_deprecation_warning_on_direct_import(captured_warnings):
    """Verify that direct import from experimental.tools emits deprecation warning."""
    # Clear the module from cache to trigger fresh import
    if "strands.experimental.tools" in sys.modules:
        del sys.modules["strands.experimental.tools"]

    # Clear any existing warnings
    captured_warnings.clear()

    # Direct import - this should trigger the warning
    from strands.experimental.tools import ToolProvider as _  # noqa: F401

    assert len(captured_warnings) >= 1
    warning = captured_warnings[0]
    assert issubclass(warning.category, DeprecationWarning)
    assert "ToolProvider" in str(warning.message)
    assert "strands.tools" in str(warning.message)


def test_attribute_error_on_unknown_attribute():
    """Verify that accessing unknown attributes raises AttributeError."""
    import strands.experimental.tools as tools_module

    with pytest.raises(AttributeError, match="has no attribute"):
        _ = tools_module.NonExistentClass


def test_no_warning_on_production_import(captured_warnings):
    """Verify that importing from strands.tools does not emit deprecation warning."""
    # Clear any existing warnings
    captured_warnings.clear()

    # Import from production - should NOT trigger warning
    from strands.tools import ToolProvider as _  # noqa: F401

    # Filter for ToolProvider-related deprecation warnings
    tool_provider_warnings = [
        w for w in captured_warnings if "ToolProvider" in str(w.message) and issubclass(w.category, DeprecationWarning)
    ]

    assert len(tool_provider_warnings) == 0


def test_stop_experimental_import_warns():
    sys.modules.pop("strands.experimental.tools", None)
    tools = importlib.import_module("strands.experimental.tools")
    with pytest.warns(DeprecationWarning, match="stop has been moved"):
        _ = tools.stop
    with pytest.warns(DeprecationWarning, match="make_stop has been moved"):
        _ = tools.make_stop
