"""Summarize reduction method.

Compresses text via an LLM call. The method is target-agnostic — it operates
on any content. Strategies handle selection and placement.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from typing_extensions import TypedDict

from ...models._summarize import _summarize_blocks
from ...types.content import ContentBlock

if TYPE_CHECKING:
    from ...agent.invocation_context import InvocationContext
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


async def _summarize_content(
    content: list[ContentBlock],
    model: Model,
    config: SummarizeConfig | None = None,
    invocation_context: InvocationContext | None = None,
) -> str | None:
    """Summarize content blocks via an LLM call. Model errors propagate to the caller."""
    return await _summarize_blocks(model, content, (config or {}).get("system_prompt"), invocation_context)
