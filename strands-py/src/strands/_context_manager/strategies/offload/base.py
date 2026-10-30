"""Base offload strategy and shared infrastructure."""

from __future__ import annotations

import asyncio
import logging
import math
import re
import warnings
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
from ...types import ContextState, is_text_block, is_tool_result_block, is_tool_use_block

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext

logger = logging.getLogger(__name__)

OffloadTarget = Literal["*", "tool_results", "tool_result_errors", "assistant_text", "user_text", "media"] | list[str]
"""Target for offload operations. ``"*"`` is whole messages, ``"media"`` is image, document, video, and
audio blocks outside tool results, and a list names tools to include (``["bash"]`` or ``["tool::bash"]``) and,
prefixed ``!``, tools to exclude. A list of only exclusions acts on every other tool."""

_MEDIA_KEYS = ("image", "document", "video", "audio")


class OffloadConditions(TypedDict, total=False):
    """Conditions that determine when and on what an offload strategy acts.

    A number is a count in the condition's unit, and a ``"N%"`` string is a share of the whole.
    Target ``"*"`` acts on whole messages, and ``block_threshold`` measures each message. Drop removes
    them, summarize merges each contiguous run, and truncate elides the middle or, with a
    ``block_threshold``, shortens each one. Any other target acts on individual blocks, and
    ``block_threshold`` measures each block.

    Attributes:
        context_utilization: When the strategy fires. ``"80%"`` fires at 80% of the context window; a
            whole number of 1,000 or more fires at that many conversation tokens, and raises if it exceeds
            the model's ``context_window_limit``. Unset, the strategy runs before every model
            call, or on each message as it arrives when the target isn't ``"*"`` and ``preserve_recent`` is unset.
        block_threshold: How large each block, or each message for target ``"*"``, must be to act on. A whole
            number selects content larger than that many tokens; ``"5%"`` selects content larger than 5% of the
            context window (10,000 tokens of a 200,000-token window). Media the token count can't measure
            always passes.
        preserve_recent: Matching messages the strategy never touches. A whole number keeps that
            many of the newest; ``"70%"`` keeps the newest 70% of them.
    """

    context_utilization: int | str
    block_threshold: int | str
    preserve_recent: int | str


@dataclass(frozen=True)
class _Measure:
    """A parsed condition value: an absolute count, or a share of a whole."""

    value: float
    is_share: bool

    def of(self, whole: float) -> float:
        """Resolve against ``whole``: a share scales it, a count stands on its own."""
        return self.value * whole if self.is_share else self.value


_PERCENT_PATTERN = re.compile(r"(\d+(?:\.\d+)?)%")
# Smaller whole numbers are almost always a percent written without "%", like context_utilization=80.
_MIN_UTILIZATION_TOKENS = 1000


@dataclass(frozen=True)
class _ConditionRule:
    """The values a condition accepts: a ``"N%"`` share and a whole-number count."""

    percent_in_range: Callable[[float], bool]
    min_count: int
    forms: str


_CONDITION_RULES = {
    "context_utilization": _ConditionRule(
        lambda percent: 0 < percent <= 100,
        _MIN_UTILIZATION_TOKENS,
        f'a "N%" string up to "100%" or a whole token count of at least {_MIN_UTILIZATION_TOKENS}',
    ),
    "block_threshold": _ConditionRule(
        lambda percent: 0 < percent < 100, 1, 'a "N%" string below "100%" or a whole token count above 0'
    ),
    "preserve_recent": _ConditionRule(
        lambda percent: 0 <= percent < 100, 0, 'a "N%" string below "100%" or a whole message count'
    ),
}


def _parse_condition(name: str, value: object) -> _Measure:
    """Parse a condition value: a ``"N%"`` string is a share, and a whole number is a count."""
    rule = _CONDITION_RULES[name]
    match = _PERCENT_PATTERN.fullmatch(value) if isinstance(value, str) else None
    if match and rule.percent_in_range(float(match.group(1))):
        return _Measure(float(match.group(1)) / 100, is_share=True)
    if isinstance(value, int) and not isinstance(value, bool) and value >= rule.min_count:
        return _Measure(float(value), is_share=False)
    raise ValueError(f"{name}={value!r} is invalid: expected {rule.forms}{_value_hint(value, rule)}")


def _value_hint(value: object, rule: _ConditionRule) -> str:
    """Suggest the spelling a rejected number probably meant: a count for ``4.0``, ``"N%"`` for ``0.85``."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return ""
    if isinstance(value, float) and value > 1 and value.is_integer() and value >= rule.min_count:
        return f"; for a count, write {int(value)}"
    percent = value * 100 if value <= 1 else value
    if not 0 < value <= 100 or not rule.percent_in_range(percent):
        return ""
    return f'; for {percent:g}%, write "{percent:g}%"'


def _build_conditions(
    *,
    context_utilization: int | str | None = None,
    block_threshold: int | str | None = None,
    preserve_recent: int | str = 0,
) -> OffloadConditions:
    """Build an OffloadConditions dict from explicit kwargs."""
    conditions = OffloadConditions()
    if context_utilization is not None:
        conditions["context_utilization"] = context_utilization
    if block_threshold is not None:
        conditions["block_threshold"] = block_threshold
    if preserve_recent:
        conditions["preserve_recent"] = preserve_recent
    return conditions


def _validate_target(target: OffloadTarget | None) -> None:
    if isinstance(target, list) and len(target) == 0:
        raise ValueError("Empty array target matches nothing — provide at least one target")
    include_filter, _ = _resolve_tool_filter(target)
    if include_filter is not None and not include_filter:
        raise ValueError(f"Tool target {target!r} excludes every tool it includes, so it matches nothing")


def _window_limit(agent: Agent) -> int:
    return agent.model.context_window_limit or DEFAULT_CONTEXT_WINDOW_LIMIT


def _media_kind(block: ContentBlock) -> str | None:
    return next((key for key in _MEDIA_KEYS if key in block), None)


def _format_marker(label: str, block: ContentBlock, tokens: int, refs: str) -> str:
    """Format a ``[Dropped]`` or ``[Offloaded]`` marker naming the media kind and leaving out an unmeasured size.

    A bare marker reads to the model as media that never arrived, so it doubts what it saw.
    """
    kind = _media_kind(block)
    parts = [part for part in (kind, f"~{tokens:,} tokens" if tokens else None) if part]
    if kind:
        parts.append("removed from context after it was received")
    body = f": {', '.join(parts)}" if parts else ""
    return f"[{label}{body}]{refs}"


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


def _is_media_block(block: ContentBlock) -> bool:
    return any(key in block for key in _MEDIA_KEYS)


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
    if target == "media":
        return any(_is_media_block(block) for block in message["content"])

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

    if includes:
        return set(includes) - set(excludes), None
    if excludes:
        return None, set(excludes)

    return None, None


class BaseOffloadStrategy(ABC):
    """Shared offload logic: target routing, conditions, eager hooks, and both granularities."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Strategy name."""
        ...

    _target: OffloadTarget | None
    _context_utilization: _Measure | None
    _block_threshold: _Measure | None
    _preserve_recent: _Measure
    _include_filter: set[str] | None
    _exclude_filter: set[str] | None
    _stash: Stash | None

    def __init__(self, target: OffloadTarget | None = None, conditions: OffloadConditions | None = None) -> None:
        """Initialize the strategy.

        Args:
            target: Content the strategy applies to.
            conditions: Conditions from ``.when()``. ``None`` leaves the strategy unconditioned and
                defers checking that it can run without conditions to ``init``, so ``.when()`` can still add them.

        Raises:
            ValueError: If ``target`` is an empty list or excludes every tool it includes, a condition
                value is invalid, or ``conditions`` are given and can't run (see ``init``).
        """
        _validate_target(target)
        self._target = target
        self._stash = None
        given = conditions or {}
        context_utilization = given.get("context_utilization")
        block_threshold = given.get("block_threshold")
        self._context_utilization = (
            _parse_condition("context_utilization", context_utilization) if context_utilization is not None else None
        )
        self._block_threshold = (
            _parse_condition("block_threshold", block_threshold) if block_threshold is not None else None
        )
        self._preserve_recent = _parse_condition("preserve_recent", given.get("preserve_recent", 0))
        self._include_filter, self._exclude_filter = _resolve_tool_filter(target)
        if conditions is not None:
            self._check_runnable()

    def when(
        self,
        *,
        context_utilization: int | str | None = None,
        block_threshold: int | str | None = None,
        preserve_recent: int | str = 0,
    ) -> BaseOffloadStrategy:
        """Return a copy of the strategy with these conditions in place of its current ones.

        Args:
            context_utilization: When the strategy fires. ``"80%"`` fires at 80% of the context window; a
                whole number of 1,000 or more fires at that many conversation tokens, and raises if it exceeds
                the model's ``context_window_limit``. Unset, the strategy runs before every model
                call, or on each message as it arrives when the target isn't ``"*"`` and ``preserve_recent`` is unset.
            block_threshold: How large each block, or each message for target ``"*"``, must be to act on. A whole
                number selects content larger than that many tokens; ``"5%"`` selects content larger than 5% of
                the context window (10,000 tokens of a 200,000-token window). Media the token count can't
                measure always passes.
            preserve_recent: Matching messages the strategy never touches. A whole number keeps that
                many of the newest; ``"70%"`` keeps the newest 70% of them.

        Returns:
            The strategy with these conditions. A strategy keeps per-agent state, so give each agent its own.

        Raises:
            ValueError: If a condition value is invalid, a target ``"*"`` strategy has none of
                ``context_utilization``, ``block_threshold``, or ``preserve_recent``, or a target ``"media"``
                strategy has neither ``context_utilization`` nor ``preserve_recent``.
        """
        return self._with_conditions(
            _build_conditions(
                context_utilization=context_utilization,
                block_threshold=block_threshold,
                preserve_recent=preserve_recent,
            )
        )

    @abstractmethod
    def _with_conditions(self, conditions: OffloadConditions) -> BaseOffloadStrategy:
        """Build a strategy like this one with ``conditions``."""
        ...

    def _check_runnable(self) -> None:
        """Raise if the strategy's conditions leave it acting on every message, or removing media unseen."""
        method = self.name.removeprefix("offload:")
        if self._acts_on_messages and self._is_unconditional:
            raise ValueError(
                f'Offload.{method}("*") would act on every message; use .when() to set context_utilization,'
                " block_threshold, or a preserve_recent above 0"
            )
        if self._target == "media" and self._runs_eagerly:
            raise ValueError(
                f'Offload.{method}("media") would remove media before the model sees it;'
                " use .when() to set context_utilization or a preserve_recent above 0"
            )

    def _warn_unconditional(self) -> None:
        if not self._is_unconditional:
            return
        method = self.name.removeprefix("offload:")
        # Caller depth varies, so stacklevel=1 pins dedup to this line: once per process for each strategy message.
        warnings.warn(
            f"Offload.{method}({self._target!r}) has no conditions, so it acts on every matching block as it arrives,"
            " before the model reads it; use .when() to set block_threshold, context_utilization, or preserve_recent",
            stacklevel=1,
        )

    @property
    def _acts_on_messages(self) -> bool:
        return self._target == "*"

    @property
    def _is_unconditional(self) -> bool:
        """Whether no condition narrows when or what the strategy acts on."""
        return self._context_utilization is None and self._block_threshold is None and not self._preserves_recent

    @property
    def _preserves_recent(self) -> bool:
        return self._preserve_recent.value > 0

    @property
    def _runs_eagerly(self) -> bool:
        """Whether the eager hook processes each message as it arrives."""
        return self._context_utilization is None and not self._preserves_recent and not self._acts_on_messages

    def _resolve_threshold(self, agent: Agent) -> int | None:
        """Resolve ``block_threshold`` to tokens, or None when unset so no size check applies."""
        if self._block_threshold is None:
            return None
        if not self._block_threshold.is_share:
            return int(self._block_threshold.value)
        return math.ceil(self._block_threshold.of(_window_limit(agent)))

    def _check_utilization_fits(self, agent: Agent) -> None:
        if self._context_utilization is None or self._context_utilization.is_share:
            return
        tokens = int(self._context_utilization.value)
        limit = agent.model.context_window_limit
        if not limit:
            # Caller depth varies, so stacklevel=1 pins dedup to this line (once per process).
            warnings.warn(
                f"context_utilization ({tokens}) can't be checked against the context window because"
                " context_window_limit is not set on the model; set context_window_limit in your model config",
                stacklevel=1,
            )
            return
        if tokens > limit:
            raise ValueError(
                f"context_utilization ({tokens}) is larger than the model's context window "
                f'({limit} tokens); use a smaller token count or a "N%" share'
            )

    def _utilization_reached(self, context: ContextState) -> bool:
        if self._context_utilization is None or context.overflow:
            return True
        if self._context_utilization.is_share:
            return context.utilization >= self._context_utilization.value
        return context.utilization >= self._context_utilization.value / _window_limit(context.agent)

    def init(self, agent: Agent, stash: Stash | None = None) -> None:
        """Check the conditions can run on this agent, then register the eager hook if this runs eagerly.

        Raises:
            ValueError: If the strategy has target ``"*"`` and none of ``context_utilization``,
                ``block_threshold``, or ``preserve_recent``, has target ``"media"`` and neither
                ``context_utilization`` nor ``preserve_recent``, or ``context_utilization`` is a token count
                larger than the model's ``context_window_limit``.
        """
        self._stash = stash
        self._check_runnable()
        self._check_utilization_fits(agent)
        from ....hooks.events import MessageAddedEvent

        if not self._runs_eagerly:
            return
        self._warn_unconditional()

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

        # Without the eager hook, message 0 is the task and the last message is one the model has not yet responded to.
        if not self._runs_eagerly and messages:
            eligible = [msg for msg in eligible if msg is not messages[0] and msg is not messages[-1]]

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

        eligible = await self._get_eligible_messages(context)
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
            return bool(block["text"].strip()) and _target_matches_message(self._target, message)
        if is_tool_result_block(block):
            if self._stash and tool_name_map.get(block["toolResult"]["toolUseId"]) == RETRIEVAL_TOOL_NAME:
                return False
            return self._target is None or _tool_matches_target(
                block, self._target, tool_name_map, self._include_filter, self._exclude_filter
            )
        if self._target is None or self._target == "*":
            return True
        return self._target == "media" and _is_media_block(block)

    async def _transform_blocks(
        self,
        message: Message,
        messages: Messages,
        tool_name_map: dict[str, str],
        agent: Agent,
        invocation_context: InvocationContext | None = None,
        threshold: int | None = None,
    ) -> bool:
        """Process eligible blocks in a message larger than ``threshold``, or the resolved threshold if unset."""
        effective_threshold = self._resolve_threshold(agent) if threshold is None else threshold
        acted = False
        content = message["content"]
        for block_index in range(len(content)):
            block = content[block_index]
            if not self._block_matches_target(block, message, tool_name_map):
                continue

            tokens = await agent.model.count_tokens([Message(role=message["role"], content=[block])])
            # The token heuristic counts media as 0, so unmeasured media is never treated as within the threshold.
            if (
                effective_threshold is not None
                and tokens <= effective_threshold
                and not (tokens == 0 and _is_media_block(block))
            ):
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

    async def _get_eligible_messages(self, context: ContextState) -> list[Message]:
        """Collect the messages a message-level strategy may act on, oldest first.

        Excludes message 0, pinned messages, the matches ``preserve_recent`` keeps, and messages at
        or under ``block_threshold``.
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
        eligible = [msg for msg in oldest if msg is not messages[0] and not is_pinned(messages, index_map[id(msg)])]
        threshold = self._resolve_threshold(context.agent)
        if threshold is None:
            return eligible
        sizes = await asyncio.gather(*(context.agent.model.count_tokens([msg]) for msg in eligible))
        return [msg for msg, size in zip(eligible, sizes, strict=True) if size > threshold]

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
