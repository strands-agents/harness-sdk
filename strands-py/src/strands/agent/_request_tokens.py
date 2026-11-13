"""Token counting for a whole model request."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..types.content import Messages

if TYPE_CHECKING:
    from .agent import Agent


async def _count_request_tokens(agent: Agent, messages: Messages) -> int:
    """Count what the next request carries: the messages, plus the system prompt and tool specs.

    The system prompt and tool specs occupy the same context window as the messages, so a count that
    leaves them out reads low. These are the same inputs behind
    ``BeforeModelCallEvent.projected_input_tokens``.

    Counts that measure a single block or a subset rather than a whole request call ``count_tokens``
    directly — including the system prompt there would inflate every block against its threshold.

    Args:
        agent: The agent whose system prompt and tool specs the request carries.
        messages: The messages the request would send.

    Returns:
        Total input token count for the request.
    """
    # Imported here because ``strands.models`` reaches this module through the event loop while it is still loading.
    from ..models._model_proxy import ModelProxy

    return await ModelProxy(agent.model).count_tokens(
        messages,
        tool_specs=agent.tool_registry.get_all_tool_specs(),
        system_prompt=agent.system_prompt,
        system_prompt_content=agent._system_prompt_content,
    )
