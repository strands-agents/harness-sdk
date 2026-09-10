"""Tests for strategy presets."""

import pytest

from strands._context_manager.presets import (
    STRATEGY_PRESET_NAMES,
    resolve_preset,
    resolve_strategies,
)
from strands._context_manager.strategies.offload import Offload


class TestResolvePreset:
    def test_proactive_summarization(self):
        strategies = resolve_preset("proactive_summarization")
        assert len(strategies) == 1
        assert strategies[0].name == "offload:summarize"

    def test_large_tool_offloading(self):
        strategies = resolve_preset("large_tool_offloading")
        assert len(strategies) == 1
        assert strategies[0].name == "offload:truncate"

    def test_overflow_protection(self):
        strategies = resolve_preset("overflow_protection")
        assert len(strategies) == 1
        assert strategies[0].name == "offload:truncate"

    def test_stale_tool_cleanup(self):
        strategies = resolve_preset("stale_tool_cleanup")
        assert len(strategies) == 1
        assert strategies[0].name == "offload:drop"

    def test_unknown_preset_raises(self):
        with pytest.raises(ValueError, match="Unknown strategy preset"):
            resolve_preset("nonexistent")


class TestResolveStrategies:
    def test_resolves_preset_strings(self):
        strategies = resolve_strategies(["proactive_summarization", "stale_tool_cleanup"])
        assert len(strategies) == 2
        assert strategies[0].name == "offload:summarize"
        assert strategies[1].name == "offload:drop"

    def test_passes_through_instances(self):
        custom = Offload.drop("*").when(threshold=500)
        strategies = resolve_strategies([custom])
        assert strategies == [custom]

    def test_mixed_presets_and_instances(self):
        custom = Offload.drop("*").when(threshold=500)
        strategies = resolve_strategies(["proactive_summarization", custom])
        assert len(strategies) == 2
        assert strategies[0].name == "offload:summarize"
        assert strategies[1] is custom

    def test_unknown_preset_in_list_raises(self):
        with pytest.raises(ValueError, match="Unknown strategy preset"):
            resolve_strategies(["nonexistent"])

    def test_empty_list(self):
        assert resolve_strategies([]) == []


class TestPresetNames:
    def test_all_presets_resolve(self):
        for name in STRATEGY_PRESET_NAMES:
            strategies = resolve_preset(name)
            assert len(strategies) >= 1

    def test_proactive_summarization_preserve_recent_is_ratio(self):
        strategies = resolve_preset("proactive_summarization")
        assert strategies[0]._preserve_recent == 0.7

    def test_overflow_protection_preserve_recent_is_integer(self):
        strategies = resolve_preset("overflow_protection")
        assert strategies[0]._preserve_recent == 4
