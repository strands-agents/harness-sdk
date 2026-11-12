"""Base offload strategy: conditions, target routing, eager hooks, and the shared execution paths.

Reading order: ``apply`` checks ``reached``, then a block target runs ``_transform_blocks``, which calls each
strategy's ``_replace_block``, and target ``"*"`` runs ``_apply_per_message`` on ``_removable_messages``, which hands
them to ``remove_messages`` in message_trimming.py before ``repair_alternation`` restores alternation.
"""

from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from ....agent.conversation_manager.compression.pin_message import is_pinned
from ....models._model_proxy import ModelProxy
from ....types.content import ContentBlock, Message, Messages
from ....types.offload import OffloadMethod
from ....types.tools import ToolResult
from ...message_trimming import collect_removable_with_pair, placeholder_for, remove_messages, repair_alternation
from ...placeholder import carried_tokens, format_elided, is_offloaded, offload_placeholder
from ...retrieval_tool import RETRIEVAL_TOOL_NAME
from ...types import ContextState, ContextStrategy, is_text_block, is_tool_result_block
from .conditions import OffloadConditions, ResolvedConditions, build_conditions
from .target import OffloadTarget, OffloadTargetMatcher, build_tool_name_map, is_media_block, is_protocol_block

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext
    from ...stash import Stash

logger = logging.getLogger(__name__)


@runtime_checkable
class OffloadStrategy(ContextStrategy, Protocol):
    """Strategy returned by ``Offload.drop``, ``Offload.truncate``, and ``Offload.summarize``.

    Without conditions it acts on each matching block as it arrives, including the one the model answers next;
    targets ``"*"`` and ``"media"`` need conditions from :meth:`when`. A strategy keeps per-agent state, so give
    each agent its own.
    """

    def when(
        self,
        *,
        context_utilization: int | str | None = None,
        block_threshold: int | str | None = None,
        preserve_recent: int | str | None = None,
    ) -> OffloadStrategy:
        """Return a copy of this strategy with these conditions in place of its current ones."""
        ...


class BaseOffloadStrategy(ABC):
    """Shared offload logic: conditions, firing, granularity, eager hooks, and ``preserve_recent``."""

    def __init__(
        self, method: OffloadMethod, target: OffloadTarget, conditions: OffloadConditions | None = None
    ) -> None:
        """Build the strategy under these conditions.

        Args:
            method: Offload method; the strategy is named ``offload:<method>``.
            target: Content the strategy acts on.
            conditions: When and how the strategy fires; omitted, it acts on each matching block as it arrives.

        Raises:
            ValueError: When the target is empty or excludes every tool it includes, a condition value is invalid, or
                conditions are given that leave the strategy unable to run (see :meth:`init`).
        """
        self.name = f"offload:{method}"
        """Stable identifier for logging and observability."""
        self._method = method
        self._target = target
        self._matcher = OffloadTargetMatcher(target)
        self._conditions = ResolvedConditions(conditions)
        self._stash: Stash | None = None
        # Whether the eager hook processes each message as it arrives.
        self._runs_eagerly = target != "*" and not self._conditions.defers_arrival
        self._warned_eager = False
        # Conditions that were set, even to nothing, are the caller's to fix now rather than at init.
        if conditions is not None:
            self._check_runnable()

    def when(
        self,
        *,
        context_utilization: int | str | None = None,
        block_threshold: int | str | None = None,
        preserve_recent: int | str | None = None,
    ) -> BaseOffloadStrategy:
        """Return a copy of this strategy, with the same target and config, under these conditions.

        Args:
            context_utilization: Context usage at or above which the strategy fires.
            block_threshold: Size above which a message (target ``"*"``) or block is offloaded.
            preserve_recent: Newest matching messages never touched.

        Returns:
            The strategy with these conditions. A strategy keeps per-agent state, so give each agent its own.

        Raises:
            ValueError: When a condition value is invalid, or the conditions leave the strategy unable to run.
        """
        return self._with_conditions(
            build_conditions(
                context_utilization=context_utilization,
                block_threshold=block_threshold,
                preserve_recent=preserve_recent,
            )
        )

    @abstractmethod
    def _with_conditions(self, conditions: OffloadConditions) -> BaseOffloadStrategy:
        """Return a copy of this strategy, with the same target and config, under ``conditions``."""
        ...

    def _check_runnable(self) -> None:
        """Check the conditions leave the strategy something to run on.

        Raises:
            ValueError: When they leave it acting on every message, or removing media before the model sees it.
        """
        if self._target == "*" and self._conditions.is_empty:
            raise ValueError(
                f'Offload.{self._method}("*") would act on every message; use .when() to set context_utilization,'
                " block_threshold, or a preserve_recent above 0"
            )
        if self._target == "media" and self._runs_eagerly:
            raise ValueError(
                f'Offload.{self._method}("media") would remove media before the model sees it; use .when() to set'
                " context_utilization or a preserve_recent above 0"
            )

    def init(self, agent: Agent, stash: Stash | None = None) -> None:
        """Check the conditions can run on this agent, then register the eager hook if this runs eagerly.

        Args:
            agent: The agent this strategy is attached to.
            stash: The stash offloaded content is stored in.

        Raises:
            ValueError: When a whole-message strategy has none of ``context_utilization``, ``block_threshold``, or
                ``preserve_recent``, a ``"media"`` strategy has neither ``context_utilization`` nor
                ``preserve_recent``, or ``context_utilization`` is a token count larger than the model's context
                window.
        """
        from ....hooks.events import MessageAddedEvent

        self._stash = stash
        self._check_runnable()
        self._conditions.check_fits(agent)
        if not self._runs_eagerly:
            return
        self._warn_eager()

        async def eager_hook(event: MessageAddedEvent) -> None:
            try:
                messages = event.agent.messages
                if id(event.message) in _pinned_ids(messages):
                    return
                threshold = self._conditions.threshold_tokens(event.agent)
                await self._transform_blocks(event.message, build_tool_name_map(messages), threshold, event.agent)
            except Exception:
                logger.warning("strategy=<%s> | eager hook failed, continuing", self.name, exc_info=True)

        agent.hooks.add_callback(MessageAddedEvent, eager_hook)

    def _warn_eager(self) -> None:
        """Warn, once, that a strategy without conditions acts on content the model has not read yet."""
        if self._warned_eager or not self._conditions.is_empty:
            return
        self._warned_eager = True
        logger.warning(
            "strategy=<%s>, target=<%s> | strategy has no conditions, so it acts on every matching block as it"
            " arrives, before the model reads it | use .when() to set block_threshold, context_utilization,"
            " or preserve_recent",
            self.name,
            json.dumps(self._target),
        )

    async def apply(self, context: ContextState) -> bool:
        """Offload content once the conditions are reached: whole messages for target ``"*"``, blocks otherwise.

        Args:
            context: The context the strategy runs on.

        Returns:
            Whether anything changed.
        """
        if context.stash is not None:
            self._stash = context.stash
        if not self._conditions.reached(context):
            return False
        if self._target != "*":
            return await self._apply_per_block(context)
        acted = await self._apply_per_message(context)
        if acted:
            repair_alternation(context.messages)
        return acted

    @abstractmethod
    async def _apply_per_message(self, context: ContextState) -> bool:
        """Act on the messages :meth:`_removable_messages` returns, for target ``"*"``.

        :meth:`apply` restores alternation afterwards.
        """
        ...

    async def _apply_per_block(self, context: ContextState) -> bool:
        """Walk each matching message, replacing the individual blocks above the threshold."""
        messages = context.messages
        tool_name_map = build_tool_name_map(messages)
        threshold = self._conditions.threshold_tokens(context.agent)
        acted = False
        for message in self._unprotected_matches(messages, tool_name_map):
            # Without the eager hook, message 0 is the task and the last message is one the model has not answered.
            if not self._runs_eagerly and (message is messages[0] or message is messages[-1]):
                continue
            if await self._transform_blocks(
                message, tool_name_map, threshold, context.agent, context.invocation_context
            ):
                acted = True
        return acted

    def _unprotected_matches(self, messages: Messages, tool_name_map: dict[str, str]) -> list[Message]:
        """Matching messages outside ``preserve_recent``, without pinned ones, in history order."""
        matching = [message for message in messages if self._matcher.matches_message(message, tool_name_map)]
        pinned = _pinned_ids(messages)
        return [message for message in self._conditions.without_preserved(matching) if id(message) not in pinned]

    async def _removable_messages(self, context: ContextState) -> list[Message]:
        """Messages outside ``preserve_recent`` and larger than ``block_threshold``.

        Message 0, pinned messages, and messages whose tool partner is protected are left out, since removing a
        message removes its partner too.
        """
        messages = context.messages
        unprotected = self._unprotected_matches(messages, build_tool_name_map(messages))
        removable = _without_protected_pairs(messages, unprotected)
        threshold = self._conditions.threshold_tokens(context.agent)
        if threshold is None:
            return removable
        sizes = [await context.agent.model.count_tokens([message]) for message in removable]
        return [message for message, size in zip(removable, sizes, strict=True) if size > threshold]

    def _placeholder(self, preview: str, stash_ref: str | None, tokens: int) -> ContentBlock:
        """The placeholder this strategy leaves for a block it replaced, recording the tokens it stands for."""
        return offload_placeholder(self._method, preview, stash_ref, tokens)

    def _is_offloadable(self, block: ContentBlock, message: Message, tool_name_map: dict[str, str]) -> bool:
        """Whether a block in ``message`` is content this strategy may replace."""
        if is_protocol_block(block) or is_offloaded(block):
            return False
        if is_text_block(block) and not block["text"].strip():
            return False
        # Injected text is written after its message was stashed, so a ref to it would point at nothing.
        if "injected" in block:
            return False
        if is_tool_result_block(block) and self._is_protected_result(block["toolResult"], tool_name_map):
            return False
        return self._matcher.matches_block(block, message, tool_name_map)

    def _is_protected_result(self, tool_result: ToolResult, tool_name_map: dict[str, str]) -> bool:
        """Whether a tool result is the retrieval tool's output, or already holds a placeholder to leave alone.

        Only drop goes further, since truncate and summarize would read the placeholder as the content.
        """
        if self._stash and tool_name_map.get(tool_result["toolUseId"]) == RETRIEVAL_TOOL_NAME:
            return True
        placeholder = next((item for item in tool_result["content"] if is_offloaded(item)), None)
        return placeholder is not None and (self._method != "drop" or placeholder["offloaded"]["method"] == "drop")

    async def _transform_blocks(
        self,
        message: Message,
        tool_name_map: dict[str, str],
        threshold: int | None,
        agent: Agent,
        invocation_context: InvocationContext | None = None,
    ) -> bool:
        """Replace the eligible blocks of a message larger than ``threshold`` tokens, or every one when it is unset."""
        acted = False
        content = message["content"]
        for block_index, block in enumerate(content):
            if not self._is_offloadable(block, message, tool_name_map):
                continue
            tokens = await self._offload_tokens(block, message, threshold, agent)
            if tokens is None:
                continue

            stash_ref = await self._stash.ensure_stashed(block, message, block_index) if self._stash else None
            tool_name = tool_name_map.get(block["toolResult"]["toolUseId"]) if is_tool_result_block(block) else None
            replacement = await self._replace_block(
                block, tokens, message, agent, stash_ref, tool_name, invocation_context
            )
            if replacement is not None and replacement is not block:
                content[block_index] = replacement
                acted = True
        return acted

    async def _offload_tokens(
        self, block: ContentBlock, message: Message, threshold: int | None, agent: Agent
    ) -> int | None:
        """The size a replacement for ``block`` stands for, or None when the block is within ``threshold``.

        The threshold measures what the block occupies now; the replacement stands for what is behind it as well, so
        a placeholder it holds adds what that already stood for.
        """
        measured = await agent.model.count_tokens([Message(role=message["role"], content=[block])])
        # The token heuristic counts media as 0, so unmeasured media is never treated as within the threshold.
        if threshold is not None and measured <= threshold and not (measured == 0 and _holds_media(block)):
            return None
        return measured + carried_tokens([block])

    @abstractmethod
    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_ref: str | None,
        tool_name: str | None,
        invocation_context: InvocationContext | None = None,
    ) -> ContentBlock | None:
        """Transform a block. Return the replacement, or None to skip.

        Args:
            block: The block to replace.
            message: The message holding the block.
            tokens: Size the replacement stands for: the block's own tokens plus what a placeholder it holds already
                stood for, so a replacement records it rather than losing it.
            agent: The agent the strategy is attached to.
            stash_ref: Reference the original is retrievable under, or None when there is no stash.
            tool_name: Name of the tool that produced a tool result, when its tool use is in the conversation.
            invocation_context: The request this reduction runs for, if any.
        """
        ...


_EMERGENCY_REMOVAL_RATIO = 0.2


class EmergencyTruncateStrategy:
    """Last-resort strategy that drops the oldest 20% of messages when the context window is still overflowing.

    It recomputes utilization once every user-configured strategy has run, and is appended internally by the
    ContextManager rather than being part of the public API. Pins are ignored so an all-pinned overflow is still
    recoverable.
    """

    name = "offload:emergency-truncate"
    """Stable identifier for logging and observability."""

    async def apply(self, context: ContextState) -> bool:
        """Elide the oldest fifth of the messages when the context window is still full.

        Args:
            context: The context the strategy runs on.

        Returns:
            Whether anything was removed.
        """
        messages = context.messages
        if len(messages) <= 3:
            return False
        if not context.overflow:
            tokens = await ModelProxy(context.agent.model).count_tokens(messages)
            if context.agent.model.estimate_utilization(tokens) < 1.0:
                return False

        removable = messages[1:]
        remove_count = max(1, int(len(removable) * _EMERGENCY_REMOVAL_RATIO))
        # Cut just before an assistant message, which holds no tool result to orphan and never merges into message 0.
        if removable[remove_count]["role"] != "assistant":
            remove_count += 1
        text_for = placeholder_for(context.agent.model, format_elided)
        if not await remove_messages(messages, removable[:remove_count], text_for, "truncate", context.stash):
            return False
        repair_alternation(messages)
        return True


def _pinned_ids(messages: Messages) -> set[int]:
    """The identities of the pinned messages, since equal messages are not the same message."""
    return {id(message) for index, message in enumerate(messages) if is_pinned(messages, index)}


def _without_protected_pairs(messages: Messages, unprotected: list[Message]) -> list[Message]:
    """``unprotected`` without message 0 and without the messages whose tool partner is protected."""
    unprotected_ids = {id(message) for message in unprotected}
    return [
        message
        for index, message in enumerate(messages)
        if index > 0
        and id(message) in unprotected_ids
        and all(id(partner) in unprotected_ids for partner in collect_removable_with_pair(messages, index))
    ]


def _holds_media(block: ContentBlock) -> bool:
    """Whether a block is media, or a tool result holding media."""
    if is_tool_result_block(block):
        return any(is_media_block(item) for item in block["toolResult"]["content"])
    return is_media_block(block)
