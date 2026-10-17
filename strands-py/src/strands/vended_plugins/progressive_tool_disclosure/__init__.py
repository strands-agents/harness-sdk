"""Progressive tool disclosure plugin for Strands Agents.

This module provides the ProgressiveToolDisclosure plugin, which replaces the full tool schemas of
each model call with a lean projection: a search tool, a short catalog entry per unexposed tool, and
the full specification of the tools currently in use. The model describes what it needs, the search
tool exposes the matching tools, and their parameters arrive on the next call. Every registered tool
stays in the ``ToolRegistry`` and stays callable — what changes is what a single call is told about.

The search itself is a protocol, :class:`ToolIndex`. The default :class:`LexicalToolIndex` scores term
frequency over the serialized specification text, with no network and no disk, so an alternative
implementation — a reranker, an embedding index, a deterministic double in tests — only has to expose
``build`` and ``search``.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_plugins.progressive_tool_disclosure import ProgressiveToolDisclosure

    # Default wiring: 20-token catalog entries, exposures expiring after 5 idle cycles.
    agent = Agent(tools=[...], plugins=[ProgressiveToolDisclosure()])
    ```

    ```python
    # No catalog at all — the cheapest projection, and the one with the least to go on: with no name
    # to recognize, the model may answer from what it knows instead of searching. A longer TTL keeps
    # a discovered schema resident across more idle cycles, and the tools named in always_available
    # carry their full specification on every call, skipping discovery entirely.
    agent = Agent(
        tools=[...],
        plugins=[
            ProgressiveToolDisclosure(
                catalog_tokens=None,
                ttl_cycles=20,
                always_available=["current_time", "file_read"],
            )
        ],
    )
    ```

    ```python
    # An alternative index, plugged in through the same protocol.
    from collections.abc import Sequence

    from strands.types.tools import ToolSpec
    from strands.vended_plugins.progressive_tool_disclosure import ToolIndex, ToolMatch


    class EmbeddingToolIndex(ToolIndex):
        async def build(self, specs: Sequence[ToolSpec]) -> None:
            self._vectors = await embed([spec["description"] for spec in specs])

        async def search(self, need: str, top_k: int) -> Sequence[ToolMatch]:
            return [ToolMatch(name=name, score=score) for name, score in await nearest(need, top_k)]


    agent = Agent(tools=[...], plugins=[ProgressiveToolDisclosure(index=EmbeddingToolIndex())])
    ```
"""

from .index import LexicalToolIndex, ToolIndex, ToolMatch
from .plugin import ProgressiveToolDisclosure

__all__ = [
    "LexicalToolIndex",
    "ProgressiveToolDisclosure",
    "ToolIndex",
    "ToolMatch",
]
