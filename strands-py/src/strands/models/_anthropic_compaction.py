"""Anthropic on-demand compaction: the beta, and how a compaction block is stored and sent back.

A compaction block is stored as a text :class:`~strands.types.content.ContentBlock` whose ``text`` is the block's
``content``, for other providers, and whose ``metadata.providerData.data`` is the block the API returned, sent back
unchanged.
"""

import asyncio
import logging
import threading
from typing import Any

from ..types.content import ContentBlock, Message, Messages
from ..types.event_loop import Usage

logger = logging.getLogger(__name__)

COMPACTION_BETA = "compact-2026-09-04"
"""Beta that enables on-demand compaction and compaction blocks in later requests."""

_ANTHROPIC_PROVIDER = "anthropic"
"""``metadata.providerData.provider`` of a block only Anthropic can read."""

_FORCING_TOOL_CHOICES = frozenset({"any", "tool"})

_CANCEL_POLL_INTERVAL = 0.05


def _is_native_block(block: ContentBlock) -> bool:
    """Whether ``block`` is a text block holding Anthropic provider data."""
    provider_data = block.get("metadata", {}).get("providerData")
    return "text" in block and provider_data is not None and provider_data.get("provider") == _ANTHROPIC_PROVIDER


def format_native_block(block: ContentBlock) -> dict[str, Any] | None:
    """Format a block that holds Anthropic provider data as the block the API returned.

    Args:
        block: A content block.

    Returns:
        The returned block, unchanged, or None for any other block.
    """
    if not _is_native_block(block):
        return None
    data: dict[str, Any] = block["metadata"]["providerData"]["data"]
    return data


def carries_native_block(messages: Messages) -> bool:
    """Whether any message carries a block only Anthropic can read, so the request needs :data:`COMPACTION_BETA`.

    Args:
        messages: The messages of a request.

    Returns:
        True when a block with Anthropic provider data is present.
    """
    return any(_is_native_block(block) for message in messages for block in message["content"])


def from_last_native_block(messages: Messages) -> Messages:
    """The messages a request sends: from the last block only Anthropic can read, or all of them when there is none.

    That block must come first and stands in for every message before it.

    Args:
        messages: The stored messages, left unmodified.

    Returns:
        The messages to send.
    """
    for index in reversed(range(len(messages))):
        message = messages[index]
        positions = [position for position, block in enumerate(message["content"]) if _is_native_block(block)]
        if not positions:
            continue
        first = Message(role=message["role"], content=message["content"][positions[-1] :])
        return [first, *messages[index + 1 :]]
    return messages


def _store_compaction_block(block: dict[str, Any]) -> ContentBlock | None:
    """Store a returned compaction block: ``content`` as the text, the whole block as opaque provider data.

    Returns:
        The stored block, or None when the block holds no summary.
    """
    content = block.get("content")
    if not isinstance(content, str) or not content:
        return None
    return ContentBlock(text=content, metadata={"providerData": {"provider": _ANTHROPIC_PROVIDER, "data": block}})


def _without_task_budget_remaining(output_config: dict[str, Any]) -> dict[str, Any]:
    """Return ``output_config`` without ``format`` and ``task_budget.remaining``, dropping what is left empty."""
    kept = {key: value for key, value in output_config.items() if key != "format"}
    task_budget = kept.get("task_budget")
    if isinstance(task_budget, dict) and "remaining" in task_budget:
        kept_budget = {key: value for key, value in task_budget.items() if key != "remaining"}
        if kept_budget:
            kept["task_budget"] = kept_budget
        else:
            del kept["task_budget"]
    return kept


def compaction_params(request: dict[str, Any], instructions: str | None) -> dict[str, Any]:
    """Turn a conversation request into an on-demand compaction request.

    Leaves out what the API rejects on, or refuses to combine with, a compaction request: ``stop_sequences``, a
    structured-output ``output_config.format``, a ``tool_choice`` that forces a tool,
    ``output_config.task_budget.remaining``, and ``context_management``. ``compaction`` is not in the installed SDK's
    request parameters, so it is sent through ``extra_body``.

    Args:
        request: The request the model would send for the same messages, system prompt and tools.
        instructions: Summarization instructions replacing the API's own prompt.

    Returns:
        The keyword arguments of the compaction request.
    """
    dropped = {"stop_sequences", "context_management", "tool_choice", "output_config", "extra_body"}
    params = {key: value for key, value in request.items() if key not in dropped}
    tool_choice = request.get("tool_choice")
    if tool_choice and tool_choice.get("type") not in _FORCING_TOOL_CHOICES:
        params["tool_choice"] = tool_choice
    if output_config := _without_task_budget_remaining(request.get("output_config") or {}):
        params["output_config"] = output_config
    compaction: dict[str, Any] = {"type": "summarize", **({"instructions": instructions} if instructions else {})}
    params["extra_body"] = {**(request.get("extra_body") or {}), "compaction": compaction}
    return params


def read_compaction(response: dict[str, Any], model_id: str) -> tuple[ContentBlock, Usage | None] | None:
    """Read a compaction response.

    Args:
        response: The response message.
        model_id: The model id, for the log line.

    Returns:
        The stored summary and the compaction iteration's usage, or None when no summary was written.
    """
    returned = next((block for block in response.get("content") or [] if block.get("type") == "compaction"), None)
    stop_reason = response.get("stop_reason")
    block = _store_compaction_block(returned) if stop_reason == "compaction" and returned else None
    if block is None:
        logger.warning("model_id=<%s>, stop_reason=<%s> | compaction returned no summary", model_id, stop_reason)
        return None
    return block, _compaction_usage(response.get("usage") or {})


def _compaction_usage(usage: dict[str, Any]) -> Usage | None:
    """The usage of the compaction iteration; the top-level counts of a compaction response are zero."""
    iteration = next((entry for entry in usage.get("iterations") or [] if entry.get("type") == "compaction"), None)
    if iteration is None:
        return None
    input_tokens = iteration.get("input_tokens") or 0
    output_tokens = iteration.get("output_tokens") or 0
    cache_read = iteration.get("cache_read_input_tokens") or 0
    cache_write = iteration.get("cache_creation_input_tokens") or 0
    result = Usage(inputTokens=input_tokens, outputTokens=output_tokens, totalTokens=input_tokens + output_tokens)
    if cache_read > 0:
        result["cacheReadInputTokens"] = cache_read
    if cache_write > 0:
        result["cacheWriteInputTokens"] = cache_write
    return result


async def _poll_cancel_signal(cancel_signal: threading.Event) -> None:
    """Complete once the cancellation signal is set."""
    while not cancel_signal.is_set():
        await asyncio.sleep(_CANCEL_POLL_INTERVAL)


async def until_cancelled(request: "asyncio.Future[Any]", cancel_signal: threading.Event | None) -> bool:
    """Wait for ``request``, cancelling it when ``cancel_signal`` is set first or the wait itself is cancelled.

    Args:
        request: The in-flight request.
        cancel_signal: Event that aborts the request.

    Returns:
        True when the request was cancelled, False when it completed.
    """
    poll = asyncio.ensure_future(_poll_cancel_signal(cancel_signal)) if cancel_signal else None
    try:
        await asyncio.wait([request, *([poll] if poll else [])], return_when=asyncio.FIRST_COMPLETED)
        return not request.done()
    finally:
        if poll is not None:
            poll.cancel()
        if not request.done():
            request.cancel()
