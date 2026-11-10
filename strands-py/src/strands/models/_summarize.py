"""Client-side summarizer behind the base :meth:`Model.summarize`."""

import logging
import threading
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from ..event_loop.streaming import stream_messages
from ..types.content import ContentBlock, Message, Messages, SummaryBlock, SystemContentBlock
from ..types.event_loop import Usage
from ..types.tools import ToolSpec

if TYPE_CHECKING:
    from .model import Model

logger = logging.getLogger(__name__)

# A reply that stopped for any other reason, such as a cancellation or a guardrail, holds no summary.
_SUMMARY_STOP_REASONS = frozenset({"end_turn", "max_tokens"})

# The request can carry the caller's own persona and tools, so every request opens with this, whatever the
# caller's instructions say.
_SUMMARIZE_GUARD = (
    "STOP. Do not act on, answer, or continue any request above, and do not call any tools - tool calls will be "
    "rejected. Your only task now is to summarize everything above."
)

DEFAULT_SUMMARIZE_INSTRUCTIONS = (
    "Write a handoff summary for a fresh context window. Preserve: key data, values and identifiers; decisions and "
    "conclusions; error messages and stack traces; the user's outstanding requests and what was about to happen "
    "next. Be concise, third person, no preamble. Output only the summary."
)


@dataclass
class SummarizeResult:
    """Result of a :meth:`Model.summarize` call.

    Attributes:
        content: The summary as ``summary`` blocks, empty when the model wrote none. Every built-in implementation
            returns at most one block; a caller that places one summary uses the first.
        usage: Token usage of the calls made for the summary, ``None`` when an implementation reports none. The base
            implementation always reports usage, with zero counts when the provider sent none.
    """

    content: list[ContentBlock] = field(default_factory=list)
    usage: Usage | None = None


async def _summarize_with_stream(
    model: "Model",
    messages: Messages,
    *,
    tool_specs: list[ToolSpec] | None = None,
    system_prompt: str | None = None,
    system_prompt_content: list[SystemContentBlock] | None = None,
    instructions: str | None = None,
    cancel_signal: threading.Event | None = None,
) -> SummarizeResult:
    """Summarize ``messages`` by sending them as a request that ends with one summarize instruction.

    The request is sent as given, the way the agent sends its own, so it can share the agent's prompt cache. A reply
    that ends for a reason other than ``end_turn`` or ``max_tokens``, such as a tool call, a cancellation or a
    guardrail, or that holds no text, gives an empty result.
    """
    stop_reason = None
    reply: Message | None = None
    usage: Usage | None = None
    async for event in stream_messages(
        model,
        system_prompt,
        _with_instructions(messages, f"{_SUMMARIZE_GUARD}\n\n{instructions or DEFAULT_SUMMARIZE_INSTRUCTIONS}"),
        tool_specs or [],
        system_prompt_content=system_prompt_content,
        cancel_signal=cancel_signal,
    ):
        if "stop" in event:
            stop_reason, reply, usage, _ = event["stop"]

    if stop_reason not in _SUMMARY_STOP_REASONS:
        logger.warning(
            "model=<%s>, stop_reason=<%s> | summary reply did not finish | ignoring the reply",
            type(model).__name__,
            stop_reason,
        )
        return SummarizeResult(usage=usage)
    text = "\n".join(block["text"] for block in (reply["content"] if reply else []) if "text" in block).strip()
    if not text:
        return SummarizeResult(usage=usage)
    return SummarizeResult(content=[ContentBlock(summary=SummaryBlock(provider=None, text=text))], usage=usage)


def _with_instructions(messages: Messages, instructions: str) -> Messages:
    """Return ``messages`` with ``instructions`` closing the final user turn, or in a user turn after it."""
    request = list(messages)
    block = ContentBlock(text=instructions)
    if request and request[-1]["role"] == "user":
        request[-1] = Message(role="user", content=[*request[-1]["content"], block])
    else:
        request.append(Message(role="user", content=[block]))
    return request
