"""Context Graph plugin for Strands Agents.

This module provides :class:`ContextStrategy`, the single Context Strategy of an agent. Under
``strategy="graph"`` it replaces the linear message list as short-term memory with a graph of Cards —
one Card per turn, derived by deterministic scan, with no language model call. Each Card enters a call
at one of three Resolutions: Title (always present), Description (derived by rule, capped by
``description_tokens``) or Full Content. A Note is computed per Card each turn, from the similarity
between the turn's question and each Card's description, and propagated along the Links; the Note
decides the Resolution. Resolution only ever descends for budget, never as a verdict, so a Card that
would not fit whole keeps its Description and its Title.

The strategy operates on the per-call copy of the conversation — the deepcopy the event loop hands to
``InvokeModelStage`` — and **never** mutates ``agent.messages``. Pair it with
``NullConversationManager``: a manager that removes or replaces messages does so on the live list,
before the call is assembled, so it can physically drop what the graph only meant to fold.

The similarity matcher is a protocol, :class:`SimilarityMatcher`, and the default
:class:`EmbeddingSimilarityMatcher` is the graph's only remote call: one embedding round per turn,
cached by ``(purpose, text)``. Supplying your own implementation only requires a callable ``score``
member returning exactly ``len(descriptions)`` values in ``[0.0, 1.0]``. Note that
``expand_threshold``, ``collapse_floor`` and ``link_threshold`` are calibrated against the default
matcher's score distribution and are **not** portable: a different matcher needs its own thresholds.

Two configurations worth knowing: ``expand_threshold=0.0, collapse_floor=0.0`` projects every Card at
Full Content, producing a call identical field for field to the one produced without the plugin, which
tells a graph problem apart from one that was there all along; and ``body_budget`` caps how many tokens
all Cards in Full Content may take together, falling the excess back to Description rather than
dropping it.

Example Usage:
    ```python
    from strands import Agent
    from strands.agent.conversation_manager import NullConversationManager
    from strands.vended_plugins.context_graph import ContextStrategy

    agent = Agent(
        conversation_manager=NullConversationManager(),
        plugins=[ContextStrategy(strategy="graph")],
    )
    ```

    ```python
    # Feeding the tool-disclosure plugin. referenced_tool_names is a bound method taking the agent of
    # the call, so one strategy instance serves every agent it is wired to: tools the surviving Cards
    # still mention carry their full specification instead of a catalog entry.
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
"""

from .matcher import EmbeddingSimilarityMatcher, SimilarityMatcher
from .plugin import ContextStrategy

__all__ = [
    "ContextStrategy",
    "EmbeddingSimilarityMatcher",
    "SimilarityMatcher",
]
