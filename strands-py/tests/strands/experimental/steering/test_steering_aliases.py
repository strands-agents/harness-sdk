"""Tests to verify that experimental steering aliases work with deprecation warning.

This test module ensures that the experimental steering aliases maintain
backwards compatibility and can be used interchangeably with the actual
types from strands.vended_plugins.steering.
"""

import importlib
import sys
import warnings

import pytest

from strands.vended_plugins.steering import (
    Guide,
    Interrupt,
    LedgerAfterToolCall,
    LedgerBeforeToolCall,
    LedgerProvider,
    LLMPromptMapper,
    LLMSteeringHandler,
    ModelSteeringAction,
    Proceed,
    SteeringContextCallback,
    SteeringContextProvider,
    SteeringHandler,
    ToolSteeringAction,
)

_ALL_NAMES = [
    "ToolSteeringAction",
    "ModelSteeringAction",
    "Proceed",
    "Guide",
    "Interrupt",
    "SteeringHandler",
    "SteeringContextCallback",
    "SteeringContextProvider",
    "LedgerBeforeToolCall",
    "LedgerAfterToolCall",
    "LedgerProvider",
    "LLMSteeringHandler",
    "LLMPromptMapper",
]

_PRODUCTION_TYPES = {
    "ToolSteeringAction": ToolSteeringAction,
    "ModelSteeringAction": ModelSteeringAction,
    "Proceed": Proceed,
    "Guide": Guide,
    "Interrupt": Interrupt,
    "SteeringHandler": SteeringHandler,
    "SteeringContextCallback": SteeringContextCallback,
    "SteeringContextProvider": SteeringContextProvider,
    "LedgerBeforeToolCall": LedgerBeforeToolCall,
    "LedgerAfterToolCall": LedgerAfterToolCall,
    "LedgerProvider": LedgerProvider,
    "LLMSteeringHandler": LLMSteeringHandler,
    "LLMPromptMapper": LLMPromptMapper,
}


@pytest.mark.parametrize("name", _ALL_NAMES)
def test_experimental_alias_is_same_type(name):
    """Verify that experimental steering alias is identical to the actual type."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        from strands.experimental import steering

        experimental_type = getattr(steering, name)

    assert experimental_type is _PRODUCTION_TYPES[name]


@pytest.mark.parametrize("name", _ALL_NAMES)
def test_deprecation_warning_on_access(name, captured_warnings):
    """Verify that accessing deprecated aliases emits deprecation warning."""
    # Clear the module from cache to trigger fresh import
    if "strands.experimental.steering" in sys.modules:
        del sys.modules["strands.experimental.steering"]

    # Clear any existing warnings
    captured_warnings.clear()

    # Access from experimental - this should trigger the warning
    from strands.experimental import steering

    _ = getattr(steering, name)

    assert len(captured_warnings) >= 1
    warning = captured_warnings[0]
    assert issubclass(warning.category, DeprecationWarning)
    assert name in str(warning.message)
    assert "strands.vended_plugins.steering" in str(warning.message)


def test_attribute_error_on_unknown_attribute():
    """Verify that accessing unknown attributes raises AttributeError."""
    import strands.experimental.steering as steering_module

    with pytest.raises(AttributeError, match="has no attribute"):
        _ = steering_module.NonExistentClass


def test_no_warning_on_production_import(captured_warnings):
    """Verify that importing from strands.vended_plugins.steering does not emit deprecation warning."""
    # Clear any existing warnings
    captured_warnings.clear()

    # Import from production - should NOT trigger warning
    from strands.vended_plugins.steering import Proceed as _  # noqa: F401

    # Filter for steering-related deprecation warnings
    steering_warnings = [
        w
        for w in captured_warnings
        if "has been moved" in str(w.message) and issubclass(w.category, DeprecationWarning)
    ]

    assert len(steering_warnings) == 0


# Submodule import tests - verify deep import paths still work with deprecation warnings

_SUBMODULE_IMPORTS = [
    ("strands.experimental.steering.core.action", "Guide", Guide),
    ("strands.experimental.steering.core.action", "Interrupt", Interrupt),
    ("strands.experimental.steering.core.action", "Proceed", Proceed),
    ("strands.experimental.steering.core.context", "SteeringContextCallback", SteeringContextCallback),
    ("strands.experimental.steering.core.context", "SteeringContextProvider", SteeringContextProvider),
    ("strands.experimental.steering.core.handler", "SteeringHandler", SteeringHandler),
    ("strands.experimental.steering.context_providers.ledger_provider", "LedgerProvider", LedgerProvider),
    ("strands.experimental.steering.context_providers.ledger_provider", "LedgerBeforeToolCall", LedgerBeforeToolCall),
    ("strands.experimental.steering.context_providers.ledger_provider", "LedgerAfterToolCall", LedgerAfterToolCall),
    ("strands.experimental.steering.handlers.llm.llm_handler", "LLMSteeringHandler", LLMSteeringHandler),
    ("strands.experimental.steering.handlers.llm.mappers", "DefaultPromptMapper", None),
]


@pytest.mark.parametrize(
    "module_path,attr_name,expected_type",
    _SUBMODULE_IMPORTS,
    ids=[f"{m}.{a}" for m, a, _ in _SUBMODULE_IMPORTS],
)
def test_submodule_import_resolves_correctly(module_path, attr_name, expected_type):
    """Verify that submodule imports resolve to the correct production types."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        mod = importlib.import_module(module_path)
        obj = getattr(mod, attr_name)

    if expected_type is not None:
        assert obj is expected_type


@pytest.mark.parametrize(
    "module_path,attr_name,expected_type",
    _SUBMODULE_IMPORTS,
    ids=[f"{m}.{a}" for m, a, _ in _SUBMODULE_IMPORTS],
)
def test_submodule_import_emits_deprecation_warning(module_path, attr_name, expected_type, captured_warnings):
    """Verify that submodule imports emit deprecation warnings."""
    # Clear module from cache to trigger fresh import
    if module_path in sys.modules:
        del sys.modules[module_path]

    captured_warnings.clear()

    mod = importlib.import_module(module_path)
    _ = getattr(mod, attr_name)

    assert len(captured_warnings) >= 1
    warning = captured_warnings[0]
    assert issubclass(warning.category, DeprecationWarning)
    assert attr_name in str(warning.message)
    assert "has been moved to production" in str(warning.message)
