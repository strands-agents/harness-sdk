"""Summarize reduction method.

Summaries come from ``Model.summarize()``; these helpers configure it and format the summary markers. Strategies
handle selection and placement.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from typing_extensions import TypedDict

if TYPE_CHECKING:
    from ...models.model import Model


_SUMMARIZED_PREFIX = "[Summarized:"


def _format_summarized(description: str, tokens: int, summary: str | None = None) -> str:
    """Format a ``[Summarized: ...]`` marker with an optional summary body."""
    header = f"{_SUMMARIZED_PREFIX} {description}, ~{tokens:,} tokens]"
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
