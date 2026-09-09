"""Context Graph plugin for Strands Agents.

Provides :class:`ContextStrategy`, an agent's single Context Strategy. Under ``strategy="graph"`` short-term memory is a
graph of Cards rather than a linear message list: one Card per turn, derived by deterministic scan, no model call. A
Card enters a call at one of three Resolutions — Title (always present), Description (rule-derived, capped by
``description_tokens``) or Full Content. Each turn a Note is computed per Card from the similarity between the turn's
question and the Card's description, then propagated along the Links; the Note picks the Resolution. Resolution descends
only for budget, never as a verdict, so a Card that will not fit whole keeps its Description and Title.

The strategy reads the per-call deepcopy the event loop hands to ``InvokeModelStage`` and never mutates
``agent.messages``. Pair it with ``NullConversationManager``: another manager edits the live list before the call is
assembled, so it can physically drop what the graph only meant to fold.

The matcher is the :class:`SimilarityMatcher` protocol. The default :class:`EmbeddingSimilarityMatcher` is the graph's
only remote call: one embedding round per turn, cached by ``(purpose, text)``. A custom implementation needs only a
callable ``score`` member returning exactly ``len(descriptions)`` values in ``[0.0, 1.0]``. ``expand_threshold``,
``collapse_floor`` and ``link_threshold`` are calibrated against the default matcher's score distribution and are not
portable; another matcher needs its own.

``expand_threshold=0.0, collapse_floor=0.0`` projects every Card at Full Content, producing a call identical field for
field to the one produced without the plugin, which tells a graph problem apart from a pre-existing one. ``body_budget``
caps the tokens all Full Content Cards may take together, falling the excess back to Description rather than dropping
it.

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
    # referenced_tool_names is a bound method taking the call's agent, so one strategy instance serves every agent it is
    # wired to: tools the surviving Cards still mention keep their full specification, not a catalog entry.
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
