"""Base offload strategy and shared infrastructure."""

from __future__ import annotations

import logging
import math
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Literal

from typing_extensions import TypedDict

from ....types.content import ContentBlock, Message, Messages
from ....types.tools import ToolUse
from ...retrieval_tool import RETRIEVAL_TOOL_NAME
from ...stash import Stash
from ...types import ContextState, is_text_block, is_tool_result_block, is_tool_use_block

if TYPE_CHECKING:
    from ....agent.agent import Agent

logger = logging.getLogger(__name__)

OffloadTarget = Literal["*", "tool_results", "tool_result_errors", "assistant_text", "user_text"] | list[str]
"""Target for offload operations."""


class OffloadConditions(TypedDict, total=False):
    """Conditions that determine when an offload strategy fires.

    Attributes:
        threshold: Token threshold above which individual blocks are offloaded.
        utilization: Context utilization ratio (0-1+) above which the strategy fires.
        preserve_recent: Number of most recent matching messages to leave untouched.
    """

    threshold: int
    utilization: float
    preserve_recent: int


def _finite_or_none(value: int | float | None) -> int | float | None:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return max(0, value)
    return None


def _build_conditions(
    *,
    threshold: int | None = None,
    utilization: float | None = None,
    preserve_recent: int = 0,
) -> OffloadConditions:
    """Build an OffloadConditions dict from explicit kwargs."""
    conditions = OffloadConditions()
    if threshold is not None:
        conditions["threshold"] = threshold
    if utilization is not None:
        conditions["utilization"] = utilization
    if preserve_recent:
        conditions["preserve_recent"] = preserve_recent
    return conditions


def _build_tool_name_map(messages: Messages) -> dict[str, str]:
    """Build a toolUseId -> toolName map from all assistant messages."""
    name_map: dict[str, str] = {}
    for message in messages:
        if message["role"] != "assistant":
            continue
        for block in message["content"]:
            if "toolUse" in block:
                tool_use: ToolUse = block["toolUse"]
                name_map[tool_use["toolUseId"]] = tool_use["name"]
    return name_map


def _tool_matches_target(
    block: ContentBlock,
    target: OffloadTarget,
    tool_name_map: dict[str, str],
    tool_include_filter: set[str] | None,
    tool_exclude_filter: set[str] | None,
) -> bool:
    """Check if a tool result block matches the given target."""
    tool_result = block["toolResult"]
    if target == "*":
        return True
    if target == "tool_results":
        return tool_result["status"] == "success"
    if target == "tool_result_errors":
        return tool_result["status"] == "error"

    tool_name = tool_name_map.get(tool_result["toolUseId"])
    if not tool_name:
        return False

    if tool_exclude_filter:
        return tool_name not in tool_exclude_filter
    if tool_include_filter:
        return tool_name in tool_include_filter

    return False


def _target_matches_message(target: OffloadTarget | None, message: Message) -> bool:
    """Check if a message matches a text-level target."""
    if target is None or target == "*":
        return True
    if target == "assistant_text":
        return message["role"] == "assistant" and any(is_text_block(b) for b in message["content"])
    if target == "user_text":
        return message["role"] == "user" and any(is_text_block(b) for b in message["content"])
    return False


def _message_matches_target(
    message: Message,
    target: OffloadTarget | None,
    tool_name_map: dict[str, str],
    tool_include_filter: set[str] | None,
    tool_exclude_filter: set[str] | None,
) -> bool:
    """Check if a message matches the target (text-level or tool result)."""
    if _target_matches_message(target, message):
        return True
    if target is None:
        return False

    if message["role"] != "user":
        return False
    for block in message["content"]:
        if is_tool_result_block(block):
            if _tool_matches_target(block, target, tool_name_map, tool_include_filter, tool_exclude_filter):
                return True
    return False


def _get_oldest_matches(
    messages: Messages,
    target: OffloadTarget | None,
    count: int,
    tool_name_map: dict[str, str],
    tool_include_filter: set[str] | None,
    tool_exclude_filter: set[str] | None,
) -> list[Message]:
    """Return target-matching messages excluding the ``count`` most recent matches."""
    matching = [
        msg
        for msg in messages
        if _message_matches_target(msg, target, tool_name_map, tool_include_filter, tool_exclude_filter)
    ]
    if count <= 0:
        return matching
    if count >= len(matching):
        return []
    return matching[:-count]


def _collect_removable_with_pair(messages: Messages, index: int) -> list[Message]:
    """Collect a message and its tool-use/tool-result pair partner for safe removal."""
    if index <= 0 or index >= len(messages):
        return []

    message = messages[index]
    result: list[Message] = [message]

    has_tool_result = any(is_tool_result_block(b) for b in message["content"])
    if has_tool_result:
        prev = messages[index - 1]
        if any(is_tool_use_block(b) for b in prev["content"]):
            if index - 1 > 0:
                result.append(prev)
            else:
                return []

    has_tool_use = any(is_tool_use_block(b) for b in message["content"])
    if has_tool_use and index < len(messages) - 1:
        next_msg = messages[index + 1]
        if any(is_tool_result_block(b) for b in next_msg["content"]):
            result.append(next_msg)

    return result


def _splice_with_pairs(messages: Messages, to_remove: list[Message]) -> tuple[int, int]:
    """Remove messages in place, expanding to include tool-use/tool-result pairs."""
    identity_map = {id(msg): idx for idx, msg in enumerate(messages)}
    to_splice: set[int] = set()
    for message in to_remove:
        index = identity_map.get(id(message))
        if index is None:
            continue
        for removable in _collect_removable_with_pair(messages, index):
            removable_index = identity_map.get(id(removable))
            if removable_index is not None:
                to_splice.add(removable_index)

    if not to_splice:
        return 0, len(messages)

    for index in sorted(to_splice, reverse=True):
        messages.pop(index)

    return len(to_splice), min(to_splice)


def _repair_alternation(messages: Messages) -> None:
    """Merge consecutive same-role messages to restore user/assistant alternation."""
    write_index = 0
    for read_index in range(len(messages)):
        current = messages[read_index]
        if write_index > 0 and messages[write_index - 1]["role"] == current["role"]:
            prev = messages[write_index - 1]
            merged = Message(
                role=prev["role"],
                content=[*prev["content"], *current["content"]],
            )
            if "tracking_id" in prev:
                merged["tracking_id"] = prev["tracking_id"]
            messages[write_index - 1] = merged
        else:
            messages[write_index] = current
            write_index += 1
    del messages[write_index:]


def _resolve_tool_filter(target: OffloadTarget | None) -> tuple[set[str] | None, set[str] | None]:
    """Parse a ``tool::`` prefixed list target into include/exclude filter sets."""
    if not isinstance(target, list):
        return None, None

    includes: list[str] = []
    excludes: list[str] = []

    for entry in target:
        if entry.startswith("!"):
            excludes.append(entry[1:].removeprefix("tool::"))
        else:
            includes.append(entry.removeprefix("tool::"))

    if excludes and includes:
        logger.warning(
            "includes=<%s>, excludes=<%s> | tool filter contains both, excludes will be ignored",
            includes,
            excludes,
        )
        return set(includes), None
    if excludes:
        return None, set(excludes)
    if includes:
        return set(includes), None

    return None, None


class BaseOffloadStrategy(ABC):
    """Shared offload logic: target routing, eager hooks, preserveRecent."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Strategy name."""
        ...

    _target: OffloadTarget | None
    _threshold: int | None
    _utilization_threshold: float | None
    _preserve_recent: int
    _removal_ratio: float = 0.3
    _include_filter: set[str] | None
    _exclude_filter: set[str] | None
    _stash: Stash | None

    def __init__(self, target: OffloadTarget | None = None, conditions: OffloadConditions | None = None) -> None:
        if isinstance(target, list) and len(target) == 0:
            raise ValueError("Empty array target matches nothing — provide at least one target")

        self._target = target
        self._stash = None
        conditions = conditions or {}
        threshold = _finite_or_none(conditions.get("threshold"))
        self._threshold = int(threshold) if threshold is not None else None
        util = _finite_or_none(conditions.get("utilization"))
        self._utilization_threshold = float(util) if util is not None else None
        preserve = _finite_or_none(conditions.get("preserve_recent"))
        self._preserve_recent = int(preserve) if preserve is not None else 0

        self._include_filter, self._exclude_filter = _resolve_tool_filter(target)

    @property
    def _is_message_level(self) -> bool:
        return self._utilization_threshold is not None

    def init(self, agent: Agent, stash: Stash | None = None) -> None:
        """Register eager hooks if this is a per-block strategy without preserveRecent."""
        self._stash = stash
        from ....hooks.events import MessageAddedEvent

        if self._is_message_level:
            return
        if self._preserve_recent > 0:
            return

        async def _eager_hook(event: MessageAddedEvent) -> None:
            try:
                messages = event.agent.messages
                tool_name_map = _build_tool_name_map(messages)
                await self._transform_blocks(event.message, messages, tool_name_map, event.agent)
            except Exception:
                logger.warning("strategy=<%s> | eager hook failed, continuing", self.name, exc_info=True)

        agent.hooks.add_callback(MessageAddedEvent, _eager_hook)

    async def apply(self, context: ContextState) -> bool:
        """Apply the strategy to the context."""
        self._stash = context.stash
        if self._is_message_level:
            if context.utilization < self._utilization_threshold:  # type: ignore[operator]
                return False
            return await self._apply_per_message(context)

        return await self._apply_per_block(context)

    async def _apply_per_block(self, context: ContextState) -> bool:
        """Per-block execution: walk each message, transform individual blocks above threshold."""
        messages = context.messages
        agent = context.agent
        tool_name_map = _build_tool_name_map(messages)
        eligible = _get_oldest_matches(
            messages, self._target, self._preserve_recent, tool_name_map, self._include_filter, self._exclude_filter
        )

        acted = False
        for message in eligible:
            if await self._transform_blocks(message, messages, tool_name_map, agent):
                acted = True

        return acted

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Message-level execution: remove oldest 30% of eligible messages with pair safety."""
        messages = context.messages
        if len(messages) <= 1:
            return False

        eligible = await self._get_eligible_messages(context)
        if not eligible:
            return False

        # TODO: consider computing removal count from target utilization instead of a fixed ratio
        target_removal = max(1, int(len(eligible) * self._removal_ratio))
        to_remove = eligible[:target_removal]

        removed, lowest_index = _splice_with_pairs(messages, to_remove)
        if removed == 0:
            return False

        marker = self._make_removal_marker(removed)
        if marker:
            insert_index = max(1, min(lowest_index, len(messages)))
            messages.insert(insert_index, Message(role="user", content=[ContentBlock(text=marker)]))

        _repair_alternation(messages)
        return True

    def _make_removal_marker(self, count: int) -> str | None:
        """Override to insert a marker when messages are removed. Return None for no marker."""
        return None

    def _block_matches_target(self, block: ContentBlock, message: Message, tool_name_map: dict[str, str]) -> bool:
        """Check whether a block is eligible for offload given target and filters."""
        if is_tool_use_block(block):
            return False
        if "reasoningContent" in block or "cachePoint" in block:
            return False
        if is_text_block(block):
            return _target_matches_message(self._target, message)
        if is_tool_result_block(block):
            if self._stash and tool_name_map.get(block["toolResult"]["toolUseId"]) == RETRIEVAL_TOOL_NAME:
                return False
            return self._target is None or _tool_matches_target(
                block, self._target, tool_name_map, self._include_filter, self._exclude_filter
            )
        return self._target is None or self._target == "*"

    async def _transform_blocks(
        self,
        message: Message,
        messages: Messages,
        tool_name_map: dict[str, str],
        agent: Agent,
    ) -> bool:
        """Process eligible blocks in a message."""
        effective_threshold = self._threshold or 0
        acted = False
        content = message["content"]
        for block_index in range(len(content)):
            block = content[block_index]
            if not self._block_matches_target(block, message, tool_name_map):
                continue

            tokens = await agent.model.count_tokens([Message(role=message["role"], content=[block])])
            if tokens <= effective_threshold:
                continue

            stash_refs = self._stash.refs_for(block, message, block_index) if self._stash else []
            replacement = await self._replace_block(block, tokens, message, agent, stash_refs)
            if replacement is not None and replacement is not block:
                content[block_index] = replacement
                acted = True

        return acted

    async def _get_eligible_messages(self, context: ContextState) -> list[Message]:
        """Collect eligible messages for message-level operations."""
        messages = context.messages
        tool_name_map = _build_tool_name_map(messages)

        oldest = _get_oldest_matches(
            messages, self._target, self._preserve_recent, tool_name_map, self._include_filter, self._exclude_filter
        )
        head_id = id(messages[0])
        candidates = [msg for msg in oldest if id(msg) != head_id]

        if self._threshold is None:
            return candidates

        eligible: list[Message] = []
        for message in candidates:
            for block in message["content"]:
                if not self._block_matches_target(block, message, tool_name_map):
                    continue
                tokens = await context.agent.model.count_tokens([Message(role=message["role"], content=[block])])
                if tokens > self._threshold:
                    eligible.append(message)
                    break
        return eligible

    @abstractmethod
    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_refs: list[str],
    ) -> ContentBlock | None:
        """Transform a block. Return the replacement, or None to skip."""
        ...
