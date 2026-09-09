"""Unit tests of ``ContextStrategy`` construction: validation, defaults and the sentinel.

Every test here is an example rather than a property, because none of what it checks varies with the
input: the defaults are fixed values, the accepted set is two strings, and the error message either
names the parameter or it does not. The property test over out-of-domain values lives alongside, and
covers the gradient these examples pin down at the edges.

The whole file asserts the same underlying claim from different angles: a construction that raises
built nothing. No network, no client, no task — which the session-wide network guard enforces for
free, so the constructions below double as proof of Requirement 2.16.
"""

import inspect
import re
from types import SimpleNamespace

import pytest

from strands.vended_plugins.context_graph.plugin import (
    ContextStrategy,
    _GraphStrategy,
)

from .stubs import StubMatcher

RATIO_PARAMETERS = ("expand_threshold", "collapse_floor", "link_threshold", "rarity_weight")
COUNT_PARAMETERS = ("description_tokens", "tags_per_card", "min_cards")


def test_defaults_are_the_documented_values():
    """Requirements 2.11, 2.12, 2.13, 2.14, 2.15: every default, fixed at construction."""
    strategy = ContextStrategy(strategy="graph")

    assert strategy._expand_threshold == 0.55
    assert strategy._collapse_floor == 0.45
    assert strategy._description_tokens == 100
    assert strategy._tags_per_card == 5
    assert strategy._rarity_weight == 0.70
    assert strategy._body_budget is None
    assert strategy._min_cards == 3
    assert strategy._link_threshold == 0.50
    assert strategy._reuse_ttl_cycles == 5
    assert strategy._matcher is None


def test_construction_registers_no_hook():
    """Requirement 1.2: hooks are explicit, so discovery leaves the list empty."""
    assert ContextStrategy(strategy="graph").hooks == []


def test_name_defaults_and_overrides():
    assert ContextStrategy(strategy="graph").name == "strands:context-strategy"
    assert ContextStrategy(strategy="graph", name="mine").name == "mine"


@pytest.mark.parametrize("name", [3, ""])
def test_invalid_name_is_rejected(name):
    with pytest.raises(ValueError, match="name"):
        ContextStrategy(strategy="graph", name=name)


# --- strategy ---------------------------------------------------------------------------------


def test_graph_strategy_constructs():
    assert isinstance(ContextStrategy(strategy="graph")._impl, _GraphStrategy)


@pytest.mark.parametrize("strategy", ["Graph", "GRAPH", "curator", "", "tree", None, 1])
def test_unknown_strategy_is_rejected_case_included(strategy):
    """Requirement 2.1: case divergence is a typo, not a synonym, and only 'graph' is accepted."""
    with pytest.raises(ValueError, match="strategy") as error:
        ContextStrategy(strategy=strategy)
    # The message has to carry the accepted value, or the caller cannot correct the typo.
    assert "'graph'" in str(error.value)


# --- ratios -----------------------------------------------------------------------------------


@pytest.mark.parametrize("parameter", RATIO_PARAMETERS)
@pytest.mark.parametrize("value", [True, False, float("nan"), float("inf"), -0.1, 1.1, "0.5", None, object()])
def test_out_of_domain_ratio_is_rejected(parameter, value):
    """Requirements 2.3, 2.8, 2.10: bool explicitly, ``nan`` through the range comparison."""
    with pytest.raises(ValueError, match=re.escape(parameter)):
        ContextStrategy(strategy="graph", **{parameter: value})


@pytest.mark.parametrize("parameter", RATIO_PARAMETERS)
@pytest.mark.parametrize("value", [0.0, 1.0, 0.5, 0, 1])
def test_ratio_accepts_the_closed_range_including_integers(parameter, value):
    # The relational check is not what is under test here, so the other end of the pair moves along:
    # collapse_floor=1.0 would exceed the default ceiling, expand_threshold=0.0 would fall under the
    # default floor.
    extra = {}
    if parameter == "collapse_floor":
        extra = {"expand_threshold": 1.0}
    elif parameter == "expand_threshold":
        extra = {"collapse_floor": 0.0}
    assert ContextStrategy(strategy="graph", **{parameter: value}, **extra) is not None


def test_floor_above_ceiling_is_rejected_naming_both():
    """Requirement 2.4: a floor above the ceiling makes the middle resolution unreachable."""
    with pytest.raises(ValueError) as error:
        ContextStrategy(strategy="graph", expand_threshold=0.2, collapse_floor=0.5)
    assert "collapse_floor" in str(error.value)
    assert "expand_threshold" in str(error.value)


def test_floor_equal_to_ceiling_is_accepted():
    assert ContextStrategy(strategy="graph", expand_threshold=0.4, collapse_floor=0.4) is not None


def test_expand_threshold_zero_is_accepted():
    """Requirement 2.20: the regression key has to be constructible."""
    assert ContextStrategy(strategy="graph", expand_threshold=0.0, collapse_floor=0.0) is not None


# --- counts -----------------------------------------------------------------------------------


@pytest.mark.parametrize("parameter", COUNT_PARAMETERS)
@pytest.mark.parametrize("value", [True, False, 0, -1, 2.5, 1.0, "3", None])
def test_out_of_domain_count_is_rejected(parameter, value):
    """Requirement 2.5: bool and float both rejected, floor of one."""
    with pytest.raises(ValueError, match=re.escape(parameter)):
        ContextStrategy(strategy="graph", **{parameter: value})


@pytest.mark.parametrize("parameter", COUNT_PARAMETERS)
def test_count_accepts_one(parameter):
    assert ContextStrategy(strategy="graph", **{parameter: 1}) is not None


# --- body_budget ------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [True, False, 0, -1, 2.5, "10"])
def test_out_of_domain_body_budget_is_rejected(value):
    """Requirement 2.6: ``None`` or an integer >= 1, and nothing else."""
    with pytest.raises(ValueError, match="body_budget"):
        ContextStrategy(strategy="graph", body_budget=value)


@pytest.mark.parametrize("value", [None, 1, 100_000])
def test_body_budget_accepts_none_and_positive_integers(value):
    assert ContextStrategy(strategy="graph", body_budget=value)._body_budget == value


# --- reuse_ttl_cycles -------------------------------------------------------------------------


@pytest.mark.parametrize("value", [True, False, -1, 2.5, "5", None])
def test_out_of_domain_reuse_ttl_cycles_is_rejected(value):
    with pytest.raises(ValueError, match="reuse_ttl_cycles"):
        ContextStrategy(strategy="graph", reuse_ttl_cycles=value)


def test_reuse_ttl_cycles_accepts_zero():
    """Requirement 2.9: zero is meaningful — discarded at the end of the turn that created it."""
    assert ContextStrategy(strategy="graph", reuse_ttl_cycles=0)._reuse_ttl_cycles == 0


# --- matcher ----------------------------------------------------------------------------------


def test_matcher_is_checked_by_member_not_by_isinstance():
    """Requirement 2.7: a double that inherits from nothing is a valid matcher."""
    matcher = StubMatcher({"a": 1.0})

    assert ContextStrategy(strategy="graph", matcher=matcher)._matcher is matcher


@pytest.mark.parametrize("matcher", [object(), "matcher", 3])
def test_matcher_without_callable_score_is_rejected(matcher):
    with pytest.raises(ValueError, match="score"):
        ContextStrategy(strategy="graph", matcher=matcher)


def test_matcher_with_non_callable_score_is_rejected():
    class NotAMatcher:
        score = "not callable"

    with pytest.raises(ValueError, match="score"):
        ContextStrategy(strategy="graph", matcher=NotAMatcher())


def test_matcher_none_stays_none():
    """Requirement 2.15: the default matcher is resolved later, never at construction."""
    assert ContextStrategy(strategy="graph", matcher=None)._matcher is None


# --- dispatch ---------------------------------------------------------------------------------
#
# The claim under test is that the choice is made once and has a shape rather than a rule: one slot
# holding one strategy object, so "two strategies on one agent" is a sentence that cannot be written
# instead of a condition that has to be checked.


class RecordingStrategy:
    """Strategy double that records every delegated call. Inherits from nothing, on purpose."""

    def __init__(self) -> None:
        self.agents: list[object] = []
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def init_agent(self, agent):
        self.agents.append(agent)

    async def expand_card(self, title, tool_context):
        self.calls.append(("expand_card", (title, tool_context)))
        return "card"

    async def expand_artifact(self, reference, tool_context, line_range, pattern):
        self.calls.append(("expand_artifact", (reference, tool_context, line_range, pattern)))
        return "artifact"

    async def find_context(self, need, tool_context, tag):
        self.calls.append(("find_context", (need, tool_context, tag)))
        return "context"


def test_graph_selects_the_graph_strategy():
    """Requirement 1.1: one slot, filled at construction."""
    assert isinstance(ContextStrategy(strategy="graph")._impl, _GraphStrategy)


def test_graph_configuration_reaches_the_graph_strategy():
    matcher = StubMatcher()
    strategy = ContextStrategy(
        strategy="graph",
        expand_threshold=0.8,
        collapse_floor=0.2,
        description_tokens=42,
        tags_per_card=2,
        rarity_weight=0.1,
        body_budget=7,
        min_cards=1,
        link_threshold=0.3,
        reuse_ttl_cycles=0,
        matcher=matcher,
    )

    impl = strategy._impl
    assert impl._expand_threshold == 0.8
    assert impl._collapse_floor == 0.2
    assert impl._description_tokens == 42
    assert impl._tags_per_card == 2
    assert impl._rarity_weight == 0.1
    assert impl._body_budget == 7
    assert impl._min_cards == 1
    assert impl._link_threshold == 0.3
    assert impl._reuse_ttl_cycles == 0
    assert impl._matcher is matcher


def test_init_agent_delegates_to_the_chosen_strategy():
    strategy = ContextStrategy(strategy="graph")
    strategy._impl = recording = RecordingStrategy()
    agent = object()

    strategy.init_agent(agent)

    assert recording.agents == [agent]


# --- the three retrieval tools ----------------------------------------------------------------


def test_graph_registers_exactly_the_three_retrieval_tools():
    """Requirement 12.1: three, named, and nothing else."""
    names = {tool.tool_name for tool in ContextStrategy(strategy="graph").tools}

    assert names == {"expand_card", "expand_artifact", "find_context"}


def test_graph_discovers_no_hook():
    """Requirement 1.2: hooks are registered in ``init_agent``, so the list stays empty."""
    assert ContextStrategy(strategy="graph").hooks == []


@pytest.mark.asyncio
async def test_each_tool_delegates_to_the_chosen_strategy():
    """No strategy branch inside a tool body: the body is the delegation and nothing else."""
    strategy = ContextStrategy(strategy="graph")
    strategy._impl = recording = RecordingStrategy()
    context = object()

    assert await strategy.expand_card("a title", context) == "card"
    assert await strategy.expand_artifact("ref-1", context, {"start": 1, "end": 2}, "needle") == "artifact"
    assert await strategy.find_context("what I need", context, "tag") == "context"

    assert recording.calls == [
        ("expand_card", ("a title", context)),
        ("expand_artifact", ("ref-1", context, {"start": 1, "end": 2}, "needle")),
        ("find_context", ("what I need", context, "tag")),
    ]


class BareAgent:
    """Weakref-able agent double carrying nothing at all, so every tool takes its absence path."""


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("operation", "arguments"),
    [
        ("expand_card", ("a title",)),
        ("expand_artifact", ("ref-1",)),
        ("find_context", ("what I need",)),
    ],
)
async def test_every_graph_operation_answers_in_prose_instead_of_raising(operation, arguments):
    """Requirement 16.8: a tool that raises tells the model the tool is broken, not the request."""
    impl = ContextStrategy(strategy="graph", matcher=StubMatcher())._impl
    tool_context = SimpleNamespace(agent=BareAgent())

    result = getattr(impl, operation)(*arguments, tool_context)
    if inspect.isawaitable(result):
        result = await result

    assert isinstance(result, str)
    assert operation in result
