"""Anthropic Messages request bodies for Bedrock ``InvokeModel``, built without the ``anthropic`` SDK.

``BedrockModel`` sends a model that declares ``server_side_summary`` through InvokeModel, because a stored
compaction block has no Converse equivalent. Only Claude models accept these bodies.
"""

import json
import logging
from collections import Counter
from typing import Any

from ..types.content import Messages, SystemContentBlock
from ..types.tools import ToolChoice, ToolSpec
from ._anthropic_compaction import COMPACTION_BETA, carries_native_block, compaction_params, format_native_block
from ._anthropic_messages import attach_cache_control, format_content_block, format_tool_choice
from ._strict_schema import ensure_strict_json_schema
from ._validation import _has_location_source, _log_skipped_blocks
from .model import CacheConfig, _messages_cache_ttl

logger = logging.getLogger(__name__)

ANTHROPIC_VERSION = "bedrock-2023-05-31"
"""``anthropic_version`` Bedrock requires in every Anthropic request body."""

DEFAULT_MAX_TOKENS = 4096
"""``max_tokens`` sent when neither the config nor the model info sets one; the Messages API requires it."""


def build_body(
    messages: Messages,
    *,
    tool_specs: list[ToolSpec] | None,
    system_prompt_content: list[SystemContentBlock] | None,
    tool_choice: ToolChoice | None,
    max_tokens: int | None,
    inference: dict[str, Any],
    additional_fields: dict[str, Any],
    cache_config: CacheConfig | None,
    tools_cache_ttl: tuple[bool, str | None],
    system_cache_ttl: tuple[bool, str | None],
    dynamic_trailing_blocks: int = 0,
    strict_tools: bool = False,
) -> dict[str, Any]:
    """Build an InvokeModel body for a Claude model.

    Args:
        messages: The messages to send, already starting at the last compaction block.
        tool_specs: Tool specifications to make available to the model.
        system_prompt_content: System prompt content blocks, which can carry cache points.
        tool_choice: Selection strategy for tool invocation.
        max_tokens: Maximum tokens to generate; :data:`DEFAULT_MAX_TOKENS` when None.
        inference: ``temperature``, ``top_p`` and ``stop_sequences`` that are set.
        additional_fields: The model's ``additional_request_fields`` for this request, merged into the body.
        cache_config: Prompt caching config when the cache strategy is ``anthropic``, else None.
        tools_cache_ttl: Whether to cache the tool definitions, and the TTL to use.
        system_cache_ttl: Whether to cache the system prompt, and the TTL to use.
        dynamic_trailing_blocks: How many trailing blocks of the last user message are rebuilt on every call.
        strict_tools: Whether tool schemas are sent strict.

    Returns:
        The request body.
    """
    body: dict[str, Any] = {
        "anthropic_version": ANTHROPIC_VERSION,
        "max_tokens": max_tokens or DEFAULT_MAX_TOKENS,
        "messages": _format_messages(messages, cache_config, dynamic_trailing_blocks),
    }
    if system := _format_system(system_prompt_content, system_cache_ttl):
        body["system"] = system
    if tools := _format_tools(tool_specs, tools_cache_ttl, strict_tools):
        body["tools"] = tools
        body.update(format_tool_choice(tool_choice))
    body.update(inference)
    body.update(additional_fields)
    if carries_native_block(messages):
        body = with_beta(body, COMPACTION_BETA)
    return body


def compaction_body(body: dict[str, Any], instructions: str | None) -> dict[str, Any]:
    """Turn a conversation body into an on-demand compaction body.

    Args:
        body: A body from :func:`build_body`.
        instructions: Summarization instructions replacing the API's own prompt.

    Returns:
        The compaction body, with ``extra_body`` fields inlined since InvokeModel takes the raw JSON body.
    """
    params = compaction_params(body, instructions)
    inlined = {key: value for key, value in params.items() if key != "extra_body"}
    return with_beta({**inlined, **params["extra_body"]}, COMPACTION_BETA)


def with_beta(body: dict[str, Any], beta: str) -> dict[str, Any]:
    """Return the body with ``beta`` in its ``anthropic_beta`` list."""
    betas = list(body.get("anthropic_beta") or [])
    if beta not in betas:
        betas.append(beta)
    return {**body, "anthropic_beta": betas}


def decode_chunk(event: dict[str, Any]) -> dict[str, Any] | None:
    """Decode one InvokeModel response stream event into the raw Messages API event it carries."""
    chunk = event.get("chunk")
    if not chunk or "bytes" not in chunk:
        return None
    decoded: dict[str, Any] = json.loads(chunk["bytes"])
    return decoded


def _format_messages(
    messages: Messages, cache_config: CacheConfig | None, dynamic_trailing_blocks: int
) -> list[dict[str, Any]]:
    """Format messages, keeping one managed cache point in the last user message when caching is on."""
    target = _cache_target(messages) if _caches_messages(cache_config) else None
    ttl = _messages_cache_ttl(cache_config)
    skipped: Counter[str] = Counter()
    formatted: list[dict[str, Any]] = []
    for index, message in enumerate(messages):
        content: list[dict[str, Any]] = []
        marked = False
        for block in message["content"]:
            if "cachePoint" in block:
                # With caching managed, only the target message keeps its cache point.
                if cache_config is None or index == target:
                    marked = attach_cache_control(content, block["cachePoint"].get("ttl") or ttl) or marked
                continue
            if _has_location_source(block):
                skipped["Location sources are not supported by Anthropic | skipping content block"] += 1
                continue
            native = format_native_block(block)
            sent = native if native is not None else format_content_block(block)
            if sent is not None:
                content.append(sent)
        if index == target and not marked:
            attach_cache_control(content, ttl, dynamic_trailing_blocks)
        if content:
            formatted.append({"role": message["role"], "content": content})
    _log_skipped_blocks(logger, skipped)
    return formatted


def _caches_messages(cache_config: CacheConfig | None) -> bool:
    return cache_config is not None and cache_config.messages_ttl is not False


def _cache_target(messages: Messages) -> int | None:
    """Index of the last user message with content other than cache points."""
    for index in reversed(range(len(messages))):
        message = messages[index]
        if message["role"] == "user" and any("cachePoint" not in block for block in message["content"]):
            return index
    return None


def _format_system(
    system_prompt_content: list[SystemContentBlock] | None, cache_ttl: tuple[bool, str | None]
) -> list[dict[str, Any]]:
    caches, ttl = cache_ttl
    formatted: list[dict[str, Any]] = []
    placed = False
    for block in system_prompt_content or []:
        if "cachePoint" in block:
            placed = attach_cache_control(formatted, block["cachePoint"].get("ttl") or ttl) or placed
        elif "text" in block:
            formatted.append({"type": "text", "text": block["text"]})
    if caches and not placed:
        attach_cache_control(formatted, ttl)
    return formatted


def _format_tools(
    tool_specs: list[ToolSpec] | None, cache_ttl: tuple[bool, str | None], strict: bool
) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    for spec in tool_specs or []:
        schema = spec["inputSchema"]["json"]
        tool: dict[str, Any] = {"name": spec["name"], "description": spec["description"]}
        tool["input_schema"] = ensure_strict_json_schema(schema) if strict else schema
        if strict:
            tool["strict"] = True
        tools.append(tool)
    caches, ttl = cache_ttl
    if tools and caches:
        # A cache_control on the final tool caches all of them.
        tools[-1]["cache_control"] = {"type": "ephemeral", **({"ttl": ttl} if ttl else {})}
    return tools
