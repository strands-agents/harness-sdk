"""Summarize reduction method: its configuration and the marker that holds a summary.

Summaries are written by :meth:`Model.summarize`; strategies handle selection and placement.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from typing_extensions import TypedDict

if TYPE_CHECKING:
    from ...models.model import Model


def _format_summarized(description: str, tokens: int, summary: str | None = None) -> str:
    """Format a ``[Summarized: ...]`` marker with an optional summary body."""
    header = f"[Summarized: {description}, ~{tokens:,} tokens]"
    if summary:
        return f"{header}\n\n{summary}"
    return header


class SummarizeConfig(TypedDict, total=False):
    """Configuration for the summarize method.

    Attributes:
        model: Model used for summarization. Resolution order: this ``model`` > ``agent.aux_model``
            > ``agent.model``.
        system_prompt: Custom system prompt for the summarization model.
    """

    model: Model
    system_prompt: str
