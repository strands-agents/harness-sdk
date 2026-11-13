"""Offload strategies — reduce content in the context window."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import EmergencyTruncateStrategy, OffloadStrategy
from .conditions import OffloadConditions
from .drop import DropStrategy
from .summarize import SummarizeStrategy
from .target import OffloadTarget
from .truncate import TruncateStrategy

if TYPE_CHECKING:
    from ...methods.truncate import TruncateConfig
    from .summarize import SummarizeConfig

__all__ = [
    "EmergencyTruncateStrategy",
    "Offload",
    "OffloadConditions",
    "OffloadStrategy",
    "OffloadTarget",
]


class _OffloadNamespace:
    """Offload strategies — reduce content in the context window.

    Target ``"*"`` acts on whole messages; any other target acts on each block. ``block_threshold`` measures
    whichever the target acts on, and ``context_utilization`` only gates when the strategy fires. Targets ``"*"`` and
    ``"media"`` need conditions from ``.when()``; any other target without them acts on each matching block as it
    arrives, before the model reads it.

    Example:
        ```python
        # Per-block, eager: truncate each tool result over 1500 tokens to a 750-token preview
        Offload.truncate("tool_results", {"preview_tokens": 750}).when(block_threshold=1500)
        # Per-block, eager: truncate specific tools' results over 5% of the context window
        Offload.truncate(["tool::bash", "tool::read_file"]).when(block_threshold="5%")
        # Messages: summarize the oldest messages at 70% context utilization, keeping the newest 4
        Offload.summarize("*").when(context_utilization="70%", preserve_recent=4)
        # Per-block, eager: with no conditions, drop each failed tool result as it arrives. Warns on init, since a
        # strategy without conditions acts on content the model has not read yet
        Offload.drop("tool_result_errors")
        # Per-block, gated: at 80% context utilization, drop tool results outside the newest 5 messages that hold one
        Offload.drop("tool_results").when(context_utilization="80%", preserve_recent=5)
        # Per-block, gated: at 80% context utilization, drop media outside the newest message that holds any
        Offload.drop("media").when(context_utilization="80%", preserve_recent=1)
        # Messages: once the window is full, drop the oldest messages, keeping the newest 70%
        Offload.drop("*").when(context_utilization="100%", preserve_recent="70%")
        # Messages: at 90% context utilization, summarize messages over 2000 tokens, keeping the newest 4
        Offload.summarize("*").when(context_utilization="90%", block_threshold=2000, preserve_recent=4)
        ```
    """

    def drop(self, target: OffloadTarget) -> OffloadStrategy:
        """Drop matching content from the context window entirely.

        Args:
            target: Content to drop.

        Returns:
            The strategy. Without ``.when()`` conditions, it drops each matching block on arrival.
        """
        return DropStrategy(target)

    def truncate(self, target: OffloadTarget, config: TruncateConfig | None = None) -> OffloadStrategy:
        """Replace oversized content with a preview.

        Args:
            target: Content to truncate.
            config: Preview budget and which portion of the content to keep.

        Returns:
            The strategy. Without ``.when()`` conditions, it truncates each matching block on arrival.
        """
        return TruncateStrategy(target, config)

    def summarize(self, target: OffloadTarget, config: SummarizeConfig | None = None) -> OffloadStrategy:
        """Replace content with a summary the model writes.

        Args:
            target: Content to summarize.
            config: The model that summarizes, and the instructions it is given.

        Returns:
            The strategy. Without ``.when()`` conditions, it summarizes each matching block on arrival.
        """
        return SummarizeStrategy(target, config)


Offload = _OffloadNamespace()
