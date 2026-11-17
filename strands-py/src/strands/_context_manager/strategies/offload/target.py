"""Offload targets: which blocks and messages a strategy acts on."""

from __future__ import annotations

import json
from typing import Literal

from ....types.content import ContentBlock, Message, Messages
from ....types.tools import ToolResult, ToolResultContent
from ...types import is_text_block, is_tool_result_block

OffloadTarget = Literal["*", "tool_results", "tool_result_errors", "assistant_text", "user_text", "media"] | list[str]
"""What a strategy acts on.

- ``"*"`` — whole messages
- ``"tool_results"`` / ``"tool_result_errors"`` — successful / failed tool result blocks
- ``"assistant_text"`` / ``"user_text"`` — text blocks in assistant / user messages, never tool results
- ``"media"`` — image, document, video, and audio blocks outside tool results
- ``list[str]`` — tool results from these tools (``["bash"]`` or ``["tool::bash"]``), with ``!`` to exclude one; a
  list of only exclusions acts on every other tool
"""

_MEDIA_KINDS = ("image", "document", "video", "audio")
"""Media block keys, each of which is also the kind's name in a marker."""

_PROTOCOL_KEYS = ("toolUse", "cachePoint", "reasoningContent")

_TOOL_PREFIX = "tool::"


def media_kind(block: ContentBlock | ToolResultContent) -> str | None:
    """The block's media kind, such as ``"image"``, or None when it is not media."""
    return next((kind for kind in _MEDIA_KINDS if kind in block), None)


def is_media_block(block: ContentBlock | ToolResultContent) -> bool:
    """Whether a block is an image, document, video, or audio block."""
    return media_kind(block) is not None


def is_protocol_block(block: ContentBlock) -> bool:
    """Whether a block is protocol rather than content: a tool use, cache point, or reasoning, never offloaded."""
    return any(key in block for key in _PROTOCOL_KEYS)


def build_tool_name_map(messages: Messages) -> dict[str, str]:
    """A toolUseId -> toolName map for the whole conversation, built once per pass so naming a result is a lookup."""
    name_map: dict[str, str] = {}
    for message in messages:
        if message["role"] != "assistant":
            continue
        for block in message["content"]:
            if "toolUse" in block:
                name_map[block["toolUse"]["toolUseId"]] = block["toolUse"]["name"]
    return name_map


def _resolve_tool_filter(target: OffloadTarget) -> tuple[set[str] | None, set[str] | None]:
    """Parse a ``list[str]`` target into include/exclude tool-name sets.

    Entries may be prefixed with ``tool::`` (e.g. ``"tool::bash"``); an additional ``!`` prefix excludes
    (e.g. ``"!tool::bash"``). A list with includes keeps the includes minus the excludes.
    """
    if not isinstance(target, list):
        return None, None

    includes: list[str] = []
    excludes: set[str] = set()
    for entry in target:
        excluded = entry.startswith("!")
        tool_name = (entry[1:] if excluded else entry).removeprefix(_TOOL_PREFIX)
        if excluded:
            excludes.add(tool_name)
        else:
            includes.append(tool_name)

    if includes:
        return {name for name in includes if name not in excludes}, None
    if excludes:
        return None, excludes
    return None, None


class OffloadTargetMatcher:
    """Matches blocks and messages against an :data:`OffloadTarget`.

    A ``list[str]`` target's tool names are parsed once, here.
    """

    def __init__(self, target: OffloadTarget) -> None:
        """Parse the target.

        Args:
            target: The offload target.

        Raises:
            ValueError: When the target is an empty list or excludes every tool it includes.
        """
        if isinstance(target, list) and not target:
            raise ValueError("Empty array target matches nothing — provide at least one target")
        include, exclude = _resolve_tool_filter(target)
        if include is not None and not include:
            raise ValueError(f"Tool target {json.dumps(target)} excludes every tool it includes, so it matches nothing")

        self.target = target
        """The target as the strategy was built with it."""
        self._include = include
        self._exclude = exclude

    def matches_block(self, block: ContentBlock, message: Message, tool_name_map: dict[str, str]) -> bool:
        """Whether a block in ``message`` is one this target covers.

        A placeholder matches like the text block it is, so callers that must not re-offload one filter it out first.
        """
        if is_text_block(block):
            return self._matches_text(message)
        if is_tool_result_block(block):
            return self._matches_tool_result(block["toolResult"], tool_name_map)
        return self.target == "media" and is_media_block(block)

    def matches_message(self, message: Message, tool_name_map: dict[str, str]) -> bool:
        """Whether a message holds anything this target covers."""
        return self.target == "*" or any(
            self.matches_block(block, message, tool_name_map) for block in message["content"]
        )

    def _matches_text(self, message: Message) -> bool:
        if self.target == "assistant_text":
            return message["role"] == "assistant"
        if self.target == "user_text":
            return message["role"] == "user"
        return False

    def _matches_tool_result(self, tool_result: ToolResult, tool_name_map: dict[str, str]) -> bool:
        if self.target == "tool_results":
            return tool_result["status"] == "success"
        if self.target == "tool_result_errors":
            return tool_result["status"] == "error"

        tool_name = tool_name_map.get(tool_result["toolUseId"])
        if not tool_name:
            return False
        if self._include is not None:
            return tool_name in self._include
        if self._exclude is not None:
            return tool_name not in self._exclude
        return False
