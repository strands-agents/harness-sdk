"""Anthropic on-demand compaction: the beta, and how a compaction block is stored and sent back.

A compaction block is stored as a text :class:`~strands.types.content.ContentBlock` whose ``text`` is the block's
``content`` and whose ``metadata.serverSideSummary`` marks it as Anthropic's, with the block's ``signature``.
The block is rebuilt from the two when it is sent back; other providers send the text.
"""

import asyncio
import logging
import threading
from typing import Any

from .._async import _poll_cancel_signal
from ..types.content import ContentBlock, Message, Messages, ServerSideSummary
from ..types.event_loop import Usage
from ._summarize import _summary_body

logger = logging.getLogger(__name__)

COMPACTION_BETA = "compact-2026-09-04"
"""Beta that enables on-demand compaction and compaction blocks in later requests."""

_ANTHROPIC_PROVIDER = "anthropic"
"""``metadata.serverSideSummary.provider`` of a summary only Anthropic can read."""

_FORCING_TOOL_CHOICES = frozenset({"any", "tool"})


def _is_native_block(block: ContentBlock) -> bool:
    """Whether ``block`` is a text block holding a summary Anthropic wrote server-side."""
    server_side = block.get("metadata", {}).get("serverSideSummary")
    return "text" in block and isinstance(server_side, dict) and server_side.get("provider") == _ANTHROPIC_PROVIDER


def format_native_block(block: ContentBlock) -> dict[str, Any] | None:
    """Format a summary Anthropic wrote server-side as the compaction block the API returned.

    The block's ``content`` is the text without the context manager's ``[Summarized: ...]`` header.

    Args:
        block: A content block.

    Returns:
        The compaction block, or None for any other block.
    """
    if not _is_native_block(block):
        return None
    signature = block["metadata"]["serverSideSummary"].get("signature")
    return {
        "type": "compaction",
        "content": _summary_body(block["text"]),
        **({"signature": signature} if signature is not None else {}),
    }


def carries_native_block(messages: Messages) -> bool:
    """Whether any message carries a block only Anthropic can read, so the request needs :data:`COMPACTION_BETA`.

    Args:
        messages: The messages of a request.

    Returns:
        True when a summary Anthropic wrote server-side is present.
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
    """Store a returned compaction block: ``content`` as the text, ``signature`` in its metadata.

    Returns:
        The stored block, or None when the block holds no summary.
    """
    content = block.get("content")
    if not isinstance(content, str) or not content:
        return None
    server_side = ServerSideSummary(provider=_ANTHROPIC_PROVIDER)
    signature = block.get("signature")
    if isinstance(signature, str):
        server_side["signature"] = signature
    return ContentBlock(text=content, metadata={"serverSideSummary": server_side})


_DROPPED_FIELDS = frozenset({"stop_sequences", "context_management", "tool_choice", "output_config"})
"""Request fields a compaction request leaves out, or keeps only in part."""


def _without_format_and_remaining(output_config: dict[str, Any]) -> dict[str, Any]:
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


def _compactable(fields: dict[str, Any]) -> dict[str, Any]:
    """Return request ``fields`` without what a compaction request rejects, dropping containers left empty."""
    kept = {key: value for key, value in fields.items() if key not in _DROPPED_FIELDS}
    tool_choice = fields.get("tool_choice")
    if isinstance(tool_choice, dict) and tool_choice.get("type") not in _FORCING_TOOL_CHOICES:
        kept["tool_choice"] = tool_choice
    output_config = fields.get("output_config")
    if isinstance(output_config, dict) and (kept_output := _without_format_and_remaining(output_config)):
        kept["output_config"] = kept_output
    return kept


def compaction_params(request: dict[str, Any], instructions: str | None) -> dict[str, Any]:
    """Turn a conversation request into an on-demand compaction request.

    Leaves out what the API rejects on, or refuses to combine with, a compaction request: ``stop_sequences``, a
    structured-output ``output_config.format``, a ``tool_choice`` that forces a tool,
    ``output_config.task_budget.remaining``, and ``context_management``, both at the top level and in
    ``extra_body``. ``compaction`` is not in the installed SDK's request parameters, so it is sent through
    ``extra_body``.

    Args:
        request: The request the model would send for the same messages, system prompt and tools.
        instructions: Summarization instructions replacing the API's own prompt.

    Returns:
        The keyword arguments of the compaction request.
    """
    params = _compactable({key: value for key, value in request.items() if key != "extra_body"})
    compaction: dict[str, Any] = {"type": "summarize", **({"instructions": instructions} if instructions else {})}
    params["extra_body"] = {**_compactable(request.get("extra_body") or {}), "compaction": compaction}
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
