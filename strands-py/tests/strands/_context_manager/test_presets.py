"""Tests for strategy presets."""

import pytest

from strands._context_manager.context_manager import ContextManager
from strands._context_manager.presets import STRATEGY_PRESET_NAMES, _resolve_preset, _resolve_strategies
from strands._context_manager.strategies.offload import Offload
from strands._context_manager.types import ContextState


class _CustomStrategy:
    """A strategy of the user's own, which the resolver passes through untouched."""

    name = "custom"

    async def apply(self, context: ContextState) -> bool:
        return False


class TestResolvePreset:
    @pytest.mark.parametrize("name", STRATEGY_PRESET_NAMES)
    def test_resolves_every_preset_name_to_strategies(self, name):
        strategies = _resolve_preset(name)

        assert len(strategies) > 0
        for strategy in strategies:
            assert strategy.name
            assert callable(strategy.apply)

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("proactive_summarization", "offload:summarize"),
            ("large_tool_offloading", "offload:truncate"),
            ("overflow_protection", "offload:drop"),
            ("stale_tool_cleanup", "offload:drop"),
        ],
    )
    def test_resolves_a_preset_to_its_method(self, name, expected):
        strategies = _resolve_preset(name)

        assert len(strategies) == 1
        assert strategies[0].name == expected

    def test_unknown_preset_raises(self):
        with pytest.raises(ValueError, match='Unknown strategy preset: "nonexistent"'):
            _resolve_preset("nonexistent")


class TestResolveStrategies:
    def test_passes_raw_strategies_through_unchanged(self):
        raw = _CustomStrategy()
        assert _resolve_strategies([raw]) == [raw]

    def test_resolves_preset_strings(self):
        resolved = _resolve_strategies(["large_tool_offloading"])

        assert len(resolved) == 1
        assert resolved[0].name == "offload:truncate"

    def test_handles_a_mix_of_presets_and_raw_strategies(self):
        raw = _CustomStrategy()

        resolved = _resolve_strategies(["large_tool_offloading", raw, "overflow_protection"])

        assert [strategy.name for strategy in resolved] == ["offload:truncate", "custom", "offload:drop"]
        assert resolved[1] is raw

    def test_preserves_the_order_of_preset_expansion(self):
        resolved = _resolve_strategies(["stale_tool_cleanup", "proactive_summarization"])

        assert [strategy.name for strategy in resolved] == ["offload:drop", "offload:summarize"]

    def test_unknown_preset_in_list_raises(self):
        with pytest.raises(ValueError, match='Unknown strategy preset: "proactive_summarisation"'):
            _resolve_strategies(["proactive_summarisation"])

    def test_names_the_entry_that_is_neither_a_strategy_nor_a_preset_name(self):
        with pytest.raises(ValueError, match="Strategy entries must be a strategy or a preset name, got None"):
            _resolve_strategies([None])

    def test_accepts_an_offload_strategy_without_when(self):
        strategy = Offload.drop("tool_results")
        assert _resolve_strategies([strategy]) == [strategy]

    def test_empty_list(self):
        assert _resolve_strategies([]) == []


class TestContextManagerFromStrategy:
    def test_resolves_preset_strings_in_a_config_strategies_list(self):
        manager = ContextManager.from_strategy({"strategies": ["large_tool_offloading", "proactive_summarization"]})
        assert isinstance(manager, ContextManager)

    def test_resolves_a_mix_of_preset_strings_and_raw_strategies(self):
        manager = ContextManager.from_strategy({"strategies": ["large_tool_offloading", _CustomStrategy()]})
        assert isinstance(manager, ContextManager)

    @pytest.mark.parametrize("preset", ["auto", "agentic"])
    def test_resolves_a_context_manager_preset(self, preset):
        assert isinstance(ContextManager.from_strategy(preset), ContextManager)

    @pytest.mark.parametrize("value", [False, None])
    def test_returns_none_when_disabled(self, value):
        assert ContextManager.from_strategy(value) is None

    def test_unknown_context_manager_preset_raises(self):
        with pytest.raises(ValueError, match="Unknown context_manager preset"):
            ContextManager.from_strategy("atuo")
