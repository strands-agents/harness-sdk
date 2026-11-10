"""Tests for ``_resolve_extraction_config``.

Ported from ``strands-ts/src/memory/extraction/__tests__/resolve-extraction-config.test.ts``.
Each TS ``it(...)`` maps to a ``test_...`` case here.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from strands.memory.extraction.model_extractor import ModelExtractor
from strands.memory.extraction.resolve_extraction_config import (
    _DEFAULT_EXTRACTION_TRIGGER_TURNS,
    _resolve_extraction_config,
)
from strands.memory.extraction.triggers import IntervalTrigger, InvocationTrigger
from strands.memory.extraction.types import (
    DEFAULT_MEMORY_MESSAGE_FILTER,
    ExtractionConfig,
    MemoryMessageFilter,
)


def _sinks(have: str) -> Any:
    """A minimal store stub exposing only the write sinks the resolver inspects.

    ``have`` is one of ``"add"``, ``"add_messages"``, or ``"both"``. The write
    methods live on a freshly-created class (not the instance) because the
    resolver's ``_has_method`` inspects ``type(store)``.
    """
    methods: dict[str, Any] = {}
    if have in ("add", "both"):
        methods["add"] = AsyncMock(return_value=None)
    if have in ("add_messages", "both"):
        methods["add_messages"] = AsyncMock(return_value=None)
    store_cls = type(f"_FakeStore_{have}", (), methods)
    return store_cls()


def _make_extractor() -> Any:
    extractor = SimpleNamespace()
    extractor.extract = AsyncMock(return_value=[])
    return extractor


# --------------------------------------------------------------------------- #
# Enablement shorthand
# --------------------------------------------------------------------------- #


def test_returns_none_when_extraction_is_false():
    assert _resolve_extraction_config(False, _sinks("add")) is None


def test_returns_none_when_extraction_is_none():
    assert _resolve_extraction_config(None, _sinks("add")) is None


def test_resolves_true_to_a_fully_defaulted_config():
    resolved_config = _resolve_extraction_config(True, _sinks("add"))
    assert resolved_config is not None
    assert len(resolved_config.triggers) == 1
    assert isinstance(resolved_config.triggers[0], IntervalTrigger)
    assert resolved_config.filter is DEFAULT_MEMORY_MESSAGE_FILTER


# --------------------------------------------------------------------------- #
# Trigger defaulting and normalization
# --------------------------------------------------------------------------- #


def test_defaults_an_omitted_trigger_to_interval_of_default_turns():
    # IntervalTrigger has no value equality, so assert on type + cadence rather than ``==``.
    resolved_config = _resolve_extraction_config(ExtractionConfig(), _sinks("add_messages"))
    assert resolved_config is not None
    assert len(resolved_config.triggers) == 1
    trigger = resolved_config.triggers[0]
    assert isinstance(trigger, IntervalTrigger)
    assert trigger._turns == _DEFAULT_EXTRACTION_TRIGGER_TURNS
    assert _DEFAULT_EXTRACTION_TRIGGER_TURNS == 5


def test_wraps_a_single_trigger_into_a_list():
    trigger = InvocationTrigger()
    resolved_config = _resolve_extraction_config(ExtractionConfig(trigger=trigger), _sinks("add_messages"))
    assert resolved_config is not None
    assert resolved_config.triggers == [trigger]


def test_passes_an_explicit_trigger_list_through_unchanged():
    triggers = [InvocationTrigger(), IntervalTrigger(turns=2)]
    resolved_config = _resolve_extraction_config(ExtractionConfig(trigger=triggers), _sinks("add_messages"))
    assert resolved_config is not None
    assert resolved_config.triggers == triggers


def test_leaves_an_explicit_empty_trigger_list_empty():
    resolved_config = _resolve_extraction_config(ExtractionConfig(trigger=[]), _sinks("add_messages"))
    assert resolved_config is not None
    assert resolved_config.triggers == []


# --------------------------------------------------------------------------- #
# Capability-based extractor default
# --------------------------------------------------------------------------- #


def test_defaults_an_add_only_store_to_a_model_extractor():
    resolved_config = _resolve_extraction_config(True, _sinks("add"))
    assert resolved_config is not None
    assert isinstance(resolved_config.extractor, ModelExtractor)


def test_defaults_an_add_messages_only_store_to_the_passthrough():
    resolved_config = _resolve_extraction_config(True, _sinks("add_messages"))
    assert resolved_config is not None
    assert resolved_config.extractor is None


def test_defaults_a_both_sinks_store_to_the_passthrough():
    resolved_config = _resolve_extraction_config(True, _sinks("both"))
    assert resolved_config is not None
    assert resolved_config.extractor is None


def test_keeps_an_explicit_extractor_even_on_an_add_messages_store():
    extractor = _make_extractor()
    resolved_config = _resolve_extraction_config(ExtractionConfig(extractor=extractor), _sinks("both"))
    assert resolved_config is not None
    assert resolved_config.extractor is extractor


# --------------------------------------------------------------------------- #
# Filter defaulting
# --------------------------------------------------------------------------- #


def test_defaults_to_default_memory_message_filter():
    resolved_config = _resolve_extraction_config(True, _sinks("add"))
    assert resolved_config is not None
    assert resolved_config.filter is DEFAULT_MEMORY_MESSAGE_FILTER


def test_passes_an_explicit_filter_through():
    message_filter = MemoryMessageFilter(exclude=[])
    resolved_config = _resolve_extraction_config(ExtractionConfig(filter=message_filter), _sinks("add"))
    assert resolved_config is not None
    assert resolved_config.filter is message_filter
