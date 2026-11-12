"""Shared helpers for context-manager tests: messages, a character-based token count, and a context over an agent."""

from __future__ import annotations

import json
import math
import threading
import unittest.mock
from typing import Any

from strands._context_manager.placeholder import is_offloaded
from strands._context_manager.stash import Stash
from strands._context_manager.types import ContextState
from strands.models._defaults import DEFAULT_CONTEXT_WINDOW_LIMIT
from strands.types.content import ContentBlock, Message, Messages
from strands.types.offload import OffloadedBlock
from strands.types.tools import ToolResult, ToolResultContent


def make_tool_result_message(text: str, tool_use_id: str = "tool-123") -> Message:
    """A user message holding one successful tool result with the given text."""
    tool_result = ToolResult(toolUseId=tool_use_id, status="success", content=[{"text": text}])
    return Message(role="user", content=[ContentBlock(toolResult=tool_result)])


def offloaded_by(block: ContentBlock | ToolResultContent) -> str | None:
    """The offload method that left ``block`` as a placeholder, or None when it is not one."""
    return block["offloaded"]["method"] if is_offloaded(block) else None


def placeholders_in(messages: Messages) -> list[OffloadedBlock]:
    """What every placeholder in ``messages`` stands in for, including those inside tool results, in history order.

    Leaves out the placeholder text so an assertion names only the provenance it cares about.
    """
    return [item["offloaded"] for item in _measured_items(messages) if is_offloaded(item)]


def heuristic_count_tokens(messages: Messages) -> int:
    """Count text at four characters per token and everything else at two characters per token of its JSON."""
    return sum(_item_tokens(item) for item in _measured_items(messages))


def _measured_items(messages: Messages) -> list[Any]:
    """The blocks of ``messages``, with a tool result's own items in its place."""
    return [
        item
        for message in messages
        for block in message["content"]
        for item in (block["toolResult"]["content"] if "toolResult" in block else [block])
    ]


def _item_tokens(item: Any) -> int:
    if "text" in item:
        return math.ceil(len(item["text"]) / 4)
    return math.ceil(len(json.dumps(item, default=str)) / 2)


def heuristic_model(**members: Any) -> unittest.mock.MagicMock:
    """A model counting tokens with :func:`heuristic_count_tokens`, with ``members`` set over it."""
    model = unittest.mock.MagicMock()
    model.count_tokens = unittest.mock.AsyncMock(side_effect=heuristic_count_tokens)
    model.context_window_limit = DEFAULT_CONTEXT_WINDOW_LIMIT
    model.estimate_utilization = lambda tokens: tokens / DEFAULT_CONTEXT_WINDOW_LIMIT
    model.model_info.capabilities.server_side_summary = False
    for name, value in members.items():
        setattr(model, name, value)
    return model


def make_agent(messages: Messages | None = None, model: Any = None) -> unittest.mock.MagicMock:
    """A mock agent over ``messages``, whose model defaults to :func:`heuristic_model`."""
    agent = unittest.mock.MagicMock()
    agent.agent_id = "test-agent"
    agent.session_id = "test-session"
    agent.messages = messages if messages is not None else []
    agent.model = model if model is not None else heuristic_model()
    agent.aux_model = agent.model
    agent._cancel_signal = threading.Event()
    return agent


def make_context(
    messages: Messages,
    *,
    stash: Stash | None = None,
    utilization: float = 0.5,
    overflow: bool = False,
    model: Any = None,
) -> ContextState:
    """A :class:`ContextState` over a mock agent whose model counts tokens with :func:`heuristic_count_tokens`."""
    return ContextState(
        messages=messages,
        agent=make_agent(messages, model),
        utilization=utilization,
        overflow=overflow,
        stash=stash,
    )
