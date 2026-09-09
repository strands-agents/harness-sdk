"""Context Graph plugin for Strands Agents.

This module provides :class:`ContextStrategy`, the single Context Strategy of an agent. Under
``strategy="graph"`` it replaces the linear message list as short-term memory with a graph of Cards —
one Card per turn, derived by deterministic scan, with no language model call. Each Card enters a call
at one of three Resolutions: Title (always present), Description (derived by rule, capped by
``description_tokens``) or Full Content. A Note is computed per Card each turn, from the similarity
between the turn's question and each Card's description, and propagated along the Links; the Note
decides the Resolution. Resolution only ever descends for budget, never as a verdict: the Card at the
end of the queue was not judged irrelevant, it just would not fit whole, and it keeps its Description
and its Title.

The strategy operates on the per-call copy of the conversation — the deepcopy the event loop hands to
``InvokeModelStage`` — and **never** mutates ``agent.messages``. Nothing is destroyed: the cost of a
wrong choice is one poorer call, which the next turn reprojects, not lost information. Pair it with
``NullConversationManager``: a manager that removes or replaces messages does so on the live list,
before the call is assembled, so it can physically drop what the graph only meant to fold.

The similarity matcher is a protocol, :class:`SimilarityMatcher`, and the default
:class:`EmbeddingSimilarityMatcher` is the graph's only remote call: one embedding round per turn,
cached by ``(purpose, text)``, so an unchanged description costs nothing on the next turn. Supplying
your own implementation only requires a callable ``score`` member. Note that ``expand_threshold``,
``collapse_floor`` and ``link_threshold`` are calibrated against the default matcher's score
distribution and are **not** portable to another implementation: a different matcher needs its own
thresholds, recalibrated against its own scores.

Example Usage:
    ```python
    from strands import Agent
    from strands.agent.conversation_manager import NullConversationManager
    from strands.vended_plugins.context_graph import ContextStrategy

    # Default wiring. Pair it with NullConversationManager: a destructive window manager mutates the
    # live list before the call is assembled, and can drop what the graph only meant to fold.
    agent = Agent(
        conversation_manager=NullConversationManager(),
        plugins=[ContextStrategy(strategy="graph")],
    )
    ```

    ```python
    # The regression key. With expand_threshold=0.0 every Card is projected at Full Content, so the
    # call is identical field for field to the one produced without the plugin. Reach for it to tell a
    # graph problem apart from a problem that was there all along.
    agent = Agent(
        conversation_manager=NullConversationManager(),
        plugins=[ContextStrategy(strategy="graph", expand_threshold=0.0, collapse_floor=0.0)],
    )
    ```

    ```python
    # A ceiling on how many tokens all the Cards in Full Content may take together. Cards past the
    # ceiling are not dropped — they fall back to Description and Title, and the model can call
    # expand_card to bring one back for the rest of the turn.
    agent = Agent(
        conversation_manager=NullConversationManager(),
        plugins=[ContextStrategy(strategy="graph", body_budget=20_000, description_tokens=150)],
    )
    ```

    ```python
    # Feeding the tool-disclosure plugin. referenced_tool_names is a bound method taking the agent of
    # the call, so one strategy instance serves every agent it is wired to. The names of tools the
    # surviving Cards still mention arrive as a supplemental referenced source, and those tools carry
    # their full specification on this call instead of a catalog entry.
    from strands.vended_plugins.progressive_tool_disclosure import ProgressiveToolDisclosure

    strategy = ContextStrategy(strategy="graph")
    agent = Agent(
        conversation_manager=NullConversationManager(),
        plugins=[
            strategy,
            ProgressiveToolDisclosure(referenced_source=strategy.referenced_tool_names),
        ],
    )
    ```

    ```python
    # Your own matcher, plugged in through the same protocol — and with its own thresholds, since the
    # defaults were calibrated for the embedding matcher's scores and do not carry over.
    from collections.abc import Sequence

    from strands.vended_plugins.context_graph import SimilarityMatcher


    class RerankerMatcher(SimilarityMatcher):
        def score(self, question: str, descriptions: Sequence[str]) -> Sequence[float]:
            # Exactly len(descriptions) values in [0.0, 1.0], same order. Must not raise: return an
            # empty sequence to signal unavailability, and the graph degrades to Full Content.
            return rerank(question, descriptions)


    agent = Agent(
        conversation_manager=NullConversationManager(),
        plugins=[
            ContextStrategy(
                strategy="graph",
                matcher=RerankerMatcher(),
                expand_threshold=0.40,
                collapse_floor=0.10,
                link_threshold=0.35,
            )
        ],
    )
    ```
"""

from .matcher import EmbeddingSimilarityMatcher, SimilarityMatcher
from .plugin import ContextStrategy

__all__ = [
    "ContextStrategy",
    "EmbeddingSimilarityMatcher",
    "SimilarityMatcher",
]
