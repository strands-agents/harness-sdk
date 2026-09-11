"""Tests for strategy presets."""

import pytest

from strands._context_manager.presets import (
    STRATEGY_PRESET_NAMES,
    _resolve_preset,
    _resolve_strategies,
)
from strands._context_manager.strategies.offload import Offload


class TestResolvePreset:
    def test_proactive_summarization(self):
        strategies = _resolve_preset("proactive_summarization")
        assert len(strategies) == 1
        assert strategies[0].name == "offload:summarize"

    def test_large_tool_offloading(self):
        strategies = _resolve_preset("large_tool_offloading")
        assert len(strategies) == 1
        assert strategies[0].name == "offload:truncate"

    def test_overflow_protection(self):
        strategies = _resolve_preset("overflow_protection")
        assert len(strategies) == 1
        assert strategies[0].name == "offload:truncate"

    def test_stale_tool_cleanup(self):
        strategies = _resolve_preset("stale_tool_cleanup")
        assert len(strategies) == 1
        assert strategies[0].name == "offload:drop"

    def test_unknown_preset_raises(self):
        with pytest.raises(ValueError, match="Unknown strategy preset"):
            _resolve_preset("nonexistent")


class TestResolveStrategies:
    def test_resolves_preset_strings(self):
        strategies = _resolve_strategies(["proactive_summarization", "stale_tool_cleanup"])
        assert len(strategies) == 2
        assert strategies[0].name == "offload:summarize"
        assert strategies[1].name == "offload:drop"

    def test_passes_through_instances(self):
        custom = Offload.drop("*").when(threshold=500)
        strategies = _resolve_strategies([custom])
        assert strategies == [custom]

    def test_mixed_presets_and_instances(self):
        custom = Offload.drop("*").when(threshold=500)
        strategies = _resolve_strategies(["proactive_summarization", custom])
        assert len(strategies) == 2
        assert strategies[0].name == "offload:summarize"
        assert strategies[1] is custom

    def test_unknown_preset_in_list_raises(self):
        with pytest.raises(ValueError, match="Unknown strategy preset"):
            _resolve_strategies(["nonexistent"])

    def test_empty_list(self):
        assert _resolve_strategies([]) == []


class TestPresetNames:
    def test_all_presets_resolve(self):
        for name in STRATEGY_PRESET_NAMES:
            strategies = _resolve_preset(name)
            assert len(strategies) >= 1

    def test_proactive_summarization_preserve_recent_is_ratio(self):
        """Ratio preserve_recent (0.7) keeps 70% of matches — 5 messages → 4 preserved, 1 returned."""
        from strands._context_manager.strategies.offload.base import _get_oldest_matches
        from strands.types.content import ContentBlock, Message

        strategies = _resolve_preset("proactive_summarization")
        messages = [Message(role="user", content=[ContentBlock(text=f"m{i}")]) for i in range(5)]
        oldest = _get_oldest_matches(messages, "*", strategies[0]._preserve_recent, {}, None, None)
        assert len(oldest) == 1

    def test_overflow_protection_preserve_recent_is_integer(self):
        """Integer preserve_recent (4) keeps exactly 4 most-recent matches."""
        from strands._context_manager.strategies.offload.base import _get_oldest_matches
        from strands.types.content import ContentBlock, Message

        strategies = _resolve_preset("overflow_protection")
        messages = [Message(role="user", content=[ContentBlock(text=f"m{i}")]) for i in range(10)]
        oldest = _get_oldest_matches(messages, "*", strategies[0]._preserve_recent, {}, None, None)
        assert len(oldest) == 6
