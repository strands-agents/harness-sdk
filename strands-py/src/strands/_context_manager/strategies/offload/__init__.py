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
        >>> Offload.truncate("tool_results", {"preview_tokens": 750}).when(threshold=1500)
        >>> Offload.summarize("*").when(utilization=0.85, preserve_recent=2)
        >>> Offload.drop("tool_result_errors").when(threshold=500)
    """

    def drop(self, target: OffloadTarget) -> DropStrategy:
        """Drop matching content from context window entirely.

        Args:
            target: What content to target for dropping.

        Returns:
            A DropStrategy builder (usable directly or with .when()).
        """
        return DropStrategy(target)

    def truncate(self, target: OffloadTarget, config: TruncateConfig | None = None) -> TruncateStrategy:
        """Replace oversized content with a preview.

        Args:
            target: What content to target for truncation.
            config: Method-specific config (preview_tokens, preview mode).

        Returns:
            A TruncateStrategy builder (usable directly or with .when()).
        """
        return TruncateStrategy(target, config)

    def summarize(self, target: OffloadTarget, config: SummarizeConfig | None = None) -> SummarizeStrategy:
        """Replace oversized content with an LLM-generated summary.

        Args:
            target: What content to target for summarization.
            config: Method-specific config (model, system_prompt).

        Returns:
            A SummarizeStrategy builder (usable directly or with .when()).
        """
        return SummarizeStrategy(target, config)


Offload = _OffloadNamespace()
