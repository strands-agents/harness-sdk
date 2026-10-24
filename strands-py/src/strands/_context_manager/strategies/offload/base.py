"""Base offload strategy and shared infrastructure."""

from __future__ import annotations

import logging
import math
import re
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from typing_extensions import TypedDict

from ....agent.conversation_manager.compression.pin_message import _has_pinned_flag, is_pinned
from ....agent.invocation_context import _invocation_context_kwargs
from ....models._defaults import DEFAULT_CONTEXT_WINDOW_LIMIT
from ....types.content import ContentBlock, Message, Messages
from ....types.tools import ToolUse
from ...retrieval_tool import RETRIEVAL_TOOL_NAME
from ...stash import Stash
from ...types import ContextState, ContextStrategy, is_text_block, is_tool_result_block, is_tool_use_block

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext

logger = logging.getLogger(__name__)

OffloadTarget = Literal["*", "tool_results", "tool_result_errors", "assistant_text", "user_text"] | list[str]
"""Target for offload operations."""


class OffloadConditions(TypedDict, total=False):
    """Conditions that determine when and on what an offload strategy acts.

    A number is a count in the condition's unit, and a ``"N%"`` string is a share of the whole.
    Target ``"*"`` without ``threshold`` acts on whole messages; any other target, or any
    ``threshold``, acts on individual blocks.

    Attributes:
        utilization: When the strategy fires. ``"80%"`` or ``0.8`` fires at 80% of the context
            window; a whole number above 1 fires at that many conversation tokens, up to the
            model's context window.
        threshold: Which blocks the strategy acts on. A whole number selects blocks over
            that many tokens; ``"5%"`` selects blocks over 5% of the context window.
        preserve_recent: Matching messages the strategy never touches. A whole number keeps that
            many of the newest; ``"70%"`` or ``0.7`` keeps the newest 70% of them.
    """

    utilization: float | str
    threshold: int | str
    preserve_recent: int | float | str


@dataclass(frozen=True)
class _Measure:
    """A parsed condition value: an absolute count, or a share of a whole."""

    value: float
    is_share: bool

    def of(self, whole: float) -> float:
        """Resolve against ``whole``: a share scales it, a count stands on its own."""
        return self.value * whole if self.is_share else self.value


_PERCENT_PATTERN = re.compile(r"(\d+(?:\.\d+)?)%")
_UTILIZATION_FORMS = 'a "N%" string up to "100%", a fraction in (0, 1], or a whole token count'
_THRESHOLD_FORMS = 'a whole token count or a "N%" string up to "100%"'
_PRESERVE_RECENT_FORMS = 'a whole message count, a "N%" string below "100%", or a fraction in [0, 1)'


def _invalid_condition(name: str, value: object, forms: str) -> ValueError:
    return ValueError(f"{name}={value!r} is invalid: expected {forms}")


def _percent_share(value: str) -> float | None:
    match = _PERCENT_PATTERN.fullmatch(value)
    return float(match.group(1)) / 100 if match else None


def _parse_utilization(value: int | float | str) -> _Measure:
    if isinstance(value, str):
        share = _percent_share(value)
        if share is None or not 0 < share <= 1:
            raise _invalid_condition("utilization", value, _UTILIZATION_FORMS)
        return _Measure(share, is_share=True)
    if isinstance(value, bool) or not math.isfinite(value) or value <= 0:
        raise _invalid_condition("utilization", value, _UTILIZATION_FORMS)
    if value <= 1:
        return _Measure(float(value), is_share=True)
    if isinstance(value, float):
        raise _invalid_condition("utilization", value, _UTILIZATION_FORMS)
    return _Measure(float(value), is_share=False)


def _parse_threshold(value: int | str) -> _Measure:
    if isinstance(value, str):
        share = _percent_share(value)
        if share is None or not 0 < share <= 1:
            raise _invalid_condition("threshold", value, _THRESHOLD_FORMS)
        return _Measure(share, is_share=True)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise _invalid_condition("threshold", value, _THRESHOLD_FORMS)
    return _Measure(float(value), is_share=False)


def _parse_preserve_recent(value: int | float | str) -> _Measure:
    if isinstance(value, str):
        share = _percent_share(value)
        if share is None or not 0 <= share < 1:
            raise _invalid_condition("preserve_recent", value, _PRESERVE_RECENT_FORMS)
        return _Measure(share, is_share=True)
    if isinstance(value, bool) or not math.isfinite(value) or value < 0:
        raise _invalid_condition("preserve_recent", value, _PRESERVE_RECENT_FORMS)
    if isinstance(value, float):
        if value >= 1:
            raise _invalid_condition("preserve_recent", value, _PRESERVE_RECENT_FORMS)
        return _Measure(value, is_share=True)
    return _Measure(float(value), is_share=False)


def _build_conditions(
    *,
    utilization: float | str | None = None,
    threshold: int | str | None = None,
    preserve_recent: int | float | str = 0,
) -> OffloadConditions:
    """Build an OffloadConditions dict from explicit kwargs."""
    conditions = OffloadConditions()
    if utilization is not None:
        conditions["utilization"] = utilization
    if threshold is not None:
        conditions["threshold"] = threshold
    if preserve_recent:
        conditions["preserve_recent"] = preserve_recent
    return conditions


def _validate_target(target: OffloadTarget | None) -> None:
    if isinstance(target, list) and len(target) == 0:
        raise ValueError("Empty array target matches nothing — provide at least one target")


def _window_limit(agent: Agent) -> int:
    return agent.model.context_window_limit or DEFAULT_CONTEXT_WINDOW_LIMIT


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
    preserve: _Measure,
    tool_name_map: dict[str, str],
    tool_include_filter: set[str] | None,
    tool_exclude_filter: set[str] | None,
) -> list[Message]:
    """Return target-matching messages excluding the most recent ones ``preserve`` keeps."""
    matching = [
        msg
        for msg in messages
        if _message_matches_target(msg, target, tool_name_map, tool_include_filter, tool_exclude_filter)
    ]
    resolved = math.ceil(preserve.of(len(matching)))
    if resolved <= 0:
        return matching
    if resolved >= len(matching):
        return []
    return matching[:-resolved]


def _collect_removable_with_pair(messages: Messages, index: int) -> list[Message]:
    """Collect a message and its tool-use/tool-result pair partner for safe removal.

    Never collects message 0 or the last message, which the next model call responds to.
    """
    if index <= 0 or index >= len(messages) - 1:
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
    if has_tool_use:
        next_msg = messages[index + 1]
        if any(is_tool_result_block(b) for b in next_msg["content"]):
            if index + 1 < len(messages) - 1:
                result.append(next_msg)
            else:
                return []

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


def _insert_marker(messages: Messages, index: int, text: str) -> None:
    """Add a removal marker as assistant content at the gap left by removed messages.

    The marker is appended to an assistant message beside the gap, which keeps that message's
    tracking id and block indices for stash refs, or becomes its own assistant message. It never
    joins message 0, and the last message is never removed, so a new marker never ends the history.
    """
    index = max(1, min(index, len(messages)))
    block = ContentBlock(text=text)
    for neighbor in (index - 1, index):
        if 0 < neighbor < len(messages) and messages[neighbor]["role"] == "assistant":
            carrier = messages[neighbor].copy()
            carrier["content"] = [*carrier["content"], block]
            messages[neighbor] = carrier
            return
    messages.insert(index, Message(role="assistant", content=[block]))


def _repair_alternation(messages: Messages) -> None:
    """Merge consecutive same-role messages to restore user/assistant alternation."""
    write_index = 0
    for read_index in range(len(messages)):
        current = messages[read_index]
        if write_index > 0 and messages[write_index - 1]["role"] == current["role"]:
            prev = messages[write_index - 1]
            prev_pinned = _has_pinned_flag(prev)
            current_pinned = _has_pinned_flag(current)
            merged = Message(
                role=prev["role"],
                content=[*prev["content"], *current["content"]],
            )
            if "tracking_id" in prev:
                merged["tracking_id"] = prev["tracking_id"]
            if prev_pinned or current_pinned:
                merged["metadata"] = {"custom": {"pinned": True}}
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
    """Shared offload logic: target routing, conditions, eager hooks, and both granularities."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Strategy name."""
        ...

    _target: OffloadTarget | None
    _utilization: _Measure | None
    _threshold: _Measure | None
    _preserve_recent: _Measure
    _include_filter: set[str] | None
    _exclude_filter: set[str] | None
    _stash: Stash | None

    def __init__(self, target: OffloadTarget | None = None, conditions: OffloadConditions | None = None) -> None:
        """Initialize the strategy.

        Args:
            target: Content the strategy applies to.
            conditions: Conditions from ``.when()``. ``None`` skips condition validation, for
                internal strategies that override ``apply``.

        Raises:
            ValueError: If ``target`` is an empty list, a condition value is invalid, or a
                message-level strategy has no ``utilization`` or ``preserve_recent``.
        """
        _validate_target(target)
        self._target = target
        self._stash = None
        conditions_given = conditions is not None
        conditions = conditions or {}
        utilization = conditions.get("utilization")
        threshold = conditions.get("threshold")
        self._utilization = _parse_utilization(utilization) if utilization is not None else None
        self._threshold = _parse_threshold(threshold) if threshold is not None else None
        self._preserve_recent = _parse_preserve_recent(conditions.get("preserve_recent", 0))
        self._include_filter, self._exclude_filter = _resolve_tool_filter(target)

        if conditions_given and self._acts_on_messages and self._utilization is None and not self._preserves_recent:
            method = self.name.removeprefix("offload:")
            raise ValueError(
                f'Offload.{method}("*") without threshold acts on whole messages; set utilization or preserve_recent'
            )

    @property
    def _acts_on_messages(self) -> bool:
        return self._target == "*" and self._threshold is None

    @property
    def _preserves_recent(self) -> bool:
        return self._preserve_recent.value > 0

    @property
    def _runs_eagerly(self) -> bool:
        """Whether the eager hook processes each message as it arrives."""
        return self._utilization is None and not self._preserves_recent and not self._acts_on_messages

    def _default_threshold(self) -> int:
        """Block size, in tokens, at or under which blocks are left alone when no threshold is set."""
        return 0

    def _resolve_threshold(self, agent: Agent) -> int:
        if self._threshold is None:
            return self._default_threshold()
        if not self._threshold.is_share:
            return int(self._threshold.value)
        return math.ceil(self._threshold.of(_window_limit(agent)))

    def _check_utilization_fits(self, agent: Agent) -> None:
        if self._utilization is None or self._utilization.is_share:
            return
        limit = agent.model.context_window_limit
        if limit and self._utilization.value > limit:
            raise ValueError(
                f"utilization ({int(self._utilization.value)}) is larger than the model's context window "
                f'({limit} tokens); use a smaller token count or a "N%" share'
            )

    def _utilization_reached(self, context: ContextState) -> bool:
        if self._utilization is None or context.overflow:
            return True
        if self._utilization.is_share:
            return context.utilization >= self._utilization.value
        return context.utilization >= self._utilization.value / _window_limit(context.agent)

    def init(self, agent: Agent, stash: Stash | None = None) -> None:
        """Check utilization against the model's context window, then register the eager hook if this runs eagerly.

        Raises:
            ValueError: If ``utilization`` is a token count larger than the model's context window.
        """
        self._stash = stash
        self._check_utilization_fits(agent)
        from ....hooks.events import MessageAddedEvent

        if not self._runs_eagerly:
            return

        async def _eager_hook(event: MessageAddedEvent) -> None:
            try:
                messages = event.agent.messages
                index_map = {id(msg): i for i, msg in enumerate(messages)}
                index = index_map.get(id(event.message), -1)
                if index >= 0 and is_pinned(messages, index):
                    return
                tool_name_map = _build_tool_name_map(messages)
                await self._transform_blocks(event.message, messages, tool_name_map, event.agent)
            except Exception:
                logger.warning("strategy=<%s> | eager hook failed, continuing", self.name, exc_info=True)

        agent.hooks.add_callback(MessageAddedEvent, _eager_hook)

    async def apply(self, context: ContextState) -> bool:
        """Apply the strategy to the context."""
        self._stash = context.stash
        if not self._utilization_reached(context):
            return False
        if self._acts_on_messages:
            return await self._apply_per_message(context)
        return await self._apply_per_block(context)

    async def _apply_per_block(self, context: ContextState) -> bool:
        """Per-block execution: walk each message, transform individual blocks above threshold."""
        messages = context.messages
        agent = context.agent
        invocation_context = context.invocation_context
        tool_name_map = _build_tool_name_map(messages)
        eligible = (
            _get_oldest_matches(
                messages, self._target, self._preserve_recent, tool_name_map, self._include_filter, self._exclude_filter
            )
            if self._preserves_recent
            else list(messages)
        )

        # Without the eager hook, the last message is one the model has not yet responded to.
        if not self._runs_eagerly and eligible and eligible[-1] is messages[-1]:
            eligible.pop()

        acted = False
        index_map = {id(msg): i for i, msg in enumerate(messages)}
        for message in eligible:
            index = index_map.get(id(message), -1)
            if index >= 0 and is_pinned(messages, index):
                continue
            if await self._transform_blocks(
                message, messages, tool_name_map, agent, invocation_context=invocation_context
            ):
                acted = True

        return acted

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Message-level execution: remove all eligible messages with pair safety."""
        messages = context.messages
        if len(messages) <= 1:
            return False

        eligible = self._get_eligible_messages(context)
        if not eligible:
            return False

        removed, lowest_index = _splice_with_pairs(messages, eligible)
        if removed == 0:
            return False

        marker = self._make_removal_marker(removed)
        if marker:
            _insert_marker(messages, lowest_index, marker)

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
        invocation_context: InvocationContext | None = None,
    ) -> bool:
        """Process eligible blocks in a message."""
        effective_threshold = self._resolve_threshold(agent)
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
            replacement = await self._replace_block(
                block,
                tokens,
                message,
                agent,
                stash_refs,
                **_invocation_context_kwargs(self._replace_block, invocation_context),
            )
            if replacement is not None and replacement is not block:
                content[block_index] = replacement
                acted = True

        return acted

    def _get_eligible_messages(self, context: ContextState) -> list[Message]:
        """Collect the messages a message-level strategy may act on, oldest first.

        Excludes message 0, pinned messages, and the matches ``preserve_recent`` keeps.
        """
        messages = context.messages
        tool_name_map = _build_tool_name_map(messages)
        oldest = _get_oldest_matches(
            messages,
            self._target,
            self._preserve_recent,
            tool_name_map,
            self._include_filter,
            self._exclude_filter,
        )
        index_map = {id(msg): i for i, msg in enumerate(messages)}
        return [msg for msg in oldest if msg is not messages[0] and not is_pinned(messages, index_map[id(msg)])]

    @abstractmethod
    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_refs: list[str],
        invocation_context: InvocationContext | None = None,
    ) -> ContentBlock | None:
        """Transform a block. Return the replacement, or None to skip."""
        ...


class OffloadStrategyBuilder:
    """An offload strategy waiting for its conditions. Call ``.when()`` to get the strategy."""

    def __init__(self, target: OffloadTarget, factory: Callable[[OffloadConditions], ContextStrategy]) -> None:
        """Initialize the builder.

        Args:
            target: Content the strategy applies to.
            factory: Builds the strategy from its conditions.

        Raises:
            ValueError: If ``target`` is an empty list.
        """
        _validate_target(target)
        self._factory = factory

    def when(
        self,
        *,
        utilization: float | str | None = None,
        threshold: int | str | None = None,
        preserve_recent: int | float | str = 0,
    ) -> ContextStrategy:
        """Return the strategy with these conditions.

        Call with no arguments to act on every new message as it arrives.

        Args:
            utilization: When the strategy fires. ``"80%"`` or ``0.8`` fires at 80% of the context
                window; a whole number above 1 fires at that many conversation tokens, up to the
                model's context window.
            threshold: Which blocks the strategy acts on. A whole number selects blocks over
                that many tokens; ``"5%"`` selects blocks over 5% of the context window.
            preserve_recent: Matching messages the strategy never touches. A whole number keeps that
                many of the newest; ``"70%"`` or ``0.7`` keeps the newest 70% of them.

        Returns:
            The configured strategy.

        Raises:
            ValueError: If a condition value is invalid, or a target ``"*"`` strategy without
                ``threshold`` has neither ``utilization`` nor ``preserve_recent``.
        """
        return self._factory(
            _build_conditions(utilization=utilization, threshold=threshold, preserve_recent=preserve_recent)
        )
