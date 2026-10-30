"""Offload strategies — reduce content in the context window."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .drop import DropStrategy
from .summarize import SummarizeStrategy
from .truncate import TruncateStrategy

if TYPE_CHECKING:
    from ...methods.summarize import SummarizeConfig
    from ...methods.truncate import TruncateConfig
    from .base import OffloadTarget


class _OffloadNamespace:
    """Factory for creating offload strategies via ``Offload.truncate(...)``, ``Offload.drop(...)``, etc.

    Example:
        >>> Offload.truncate("tool_results", {"preview_tokens": 750}).when(block_threshold=1500)
        >>> Offload.summarize("*").when(context_utilization="85%", preserve_recent=2)
        >>> Offload.drop("tool_result_errors")
        >>> Offload.drop("media").when(context_utilization="80%", preserve_recent=1)
        >>> Offload.summarize("*").when(context_utilization="90%", block_threshold=2000, preserve_recent=4)
    """

    def drop(self, target: OffloadTarget) -> DropStrategy:
        """Drop matching content from context window entirely.

        Args:
            target: What content to target for dropping.

        Returns:
            The strategy. With no ``.when()`` conditions, it drops each matching block as it arrives.
        """
        return DropStrategy(target)

    def truncate(self, target: OffloadTarget, config: TruncateConfig | None = None) -> TruncateStrategy:
        """Replace oversized content with a preview.

        Args:
            target: What content to target for truncation.
            config: Method-specific config (preview_tokens, preview mode).

        Returns:
            The strategy. With no ``.when()`` conditions, it truncates each matching block as it arrives.
        """
        return TruncateStrategy(target, config)

    def summarize(self, target: OffloadTarget, config: SummarizeConfig | None = None) -> SummarizeStrategy:
        """Replace oversized content with an LLM-generated summary.

        Args:
            target: What content to target for summarization.
            config: Method-specific config (model, system_prompt).

        Returns:
            The strategy. With no ``.when()`` conditions, it summarizes each matching block as it arrives.
        """
        return SummarizeStrategy(target, config)


Offload = _OffloadNamespace()
