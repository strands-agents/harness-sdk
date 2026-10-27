"""Unit tests of the package's public surface and of the examples its docstring publishes.

* **The three names are importable from the package itself.** ``ContextStrategy`` and both matcher
  types — the last two so that the type of the ``matcher`` parameter is reachable by whoever supplies
  an implementation, without importing a private module (Requirement 1.8).

The docstring examples are constructed rather than run: an ``Agent`` needs a model, and the claim under
test is that the parameters and signatures the docstring publishes are real. No network call is made,
and no example here is allowed to be the only place a signature is checked.
"""

from __future__ import annotations

from collections.abc import Sequence

from strands.vended_plugins import context_graph
from strands.vended_plugins.context_graph import (
    ContextStrategy,
    EmbeddingSimilarityMatcher,
    SimilarityMatcher,
)
from strands.vended_plugins.context_graph.matcher import (
    EmbeddingSimilarityMatcher as _MatcherFromModule,
)
from strands.vended_plugins.context_graph.plugin import ContextStrategy as _StrategyFromModule
from strands.vended_plugins.progressive_tool_disclosure import ProgressiveToolDisclosure


def test_all_lists_exactly_the_documented_surface() -> None:
    """``__all__`` names the three exports and nothing else."""
    assert sorted(context_graph.__all__) == [
        "ContextStrategy",
        "EmbeddingSimilarityMatcher",
        "SimilarityMatcher",
    ]


def test_every_exported_name_resolves_to_the_defining_object() -> None:
    """The package re-exports the same objects the modules define, not copies of them."""
    assert ContextStrategy is _StrategyFromModule
    assert EmbeddingSimilarityMatcher is _MatcherFromModule
    assert context_graph.SimilarityMatcher is SimilarityMatcher


def test_default_and_regression_configurations_construct() -> None:
    """The default wiring and the ``expand_threshold=0.0`` regression key of the docstring."""
    assert ContextStrategy(strategy="graph") is not None
    assert ContextStrategy(strategy="graph", expand_threshold=0.0, collapse_floor=0.0) is not None


def test_body_budget_example_constructs() -> None:
    """The ``body_budget`` example of the docstring."""
    assert ContextStrategy(strategy="graph", body_budget=20_000, description_tokens=150) is not None


def test_referenced_source_example_wires_into_tool_disclosure() -> None:
    """The bound method is accepted as the supplemental referenced source, as documented."""
    strategy = ContextStrategy(strategy="graph")
    assert ProgressiveToolDisclosure(referenced_source=strategy.referenced_tool_names) is not None


def test_custom_matcher_example_constructs_with_its_own_thresholds() -> None:
    """The exported protocol is subclassable and satisfies the ``matcher`` check by member."""

    class RerankerMatcher(SimilarityMatcher):
        def score(self, question: str, descriptions: Sequence[str]) -> Sequence[float]:
            return [0.5] * len(descriptions)

    strategy = ContextStrategy(
        strategy="graph",
        matcher=RerankerMatcher(),
        expand_threshold=0.40,
        collapse_floor=0.10,
        link_threshold=0.35,
    )
    assert strategy is not None
