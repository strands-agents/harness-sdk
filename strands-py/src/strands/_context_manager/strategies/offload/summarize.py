"""Summarize strategy — replaces oversized content with LLM-generated summaries."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ....types.content import ContentBlock, Message, Messages
from ....types.tools import ToolResult, ToolResultContent
from ...methods.summarize import (
    SummarizeConfig,
    _flatten_messages_to_content,
    _format_summarized,
    _summarize_content,
    _tool_result_to_content_blocks,
)
from ...stash import _format_stash_refs
from ...types import ContextState
from .base import (
    BaseOffloadStrategy,
    OffloadConditions,
    OffloadTarget,
    _collect_removable_with_pair,
    _format_marker,
    _insert_marker,
    _repair_alternation,
)

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext
    from ....models.model import Model

logger = logging.getLogger(__name__)


class SummarizeStrategy(BaseOffloadStrategy):
    """Summarize strategy — replaces oversized content with LLM-generated summaries."""

    @property
    def name(self) -> str:
        """Strategy name."""
        return "offload:summarize"

    def __init__(
        self,
        target: OffloadTarget | None = None,
        config: SummarizeConfig | None = None,
        conditions: OffloadConditions | None = None,
    ) -> None:
        super().__init__(target, conditions)
        self._config: SummarizeConfig = config or {}

    def _with_conditions(self, conditions: OffloadConditions) -> SummarizeStrategy:
        return SummarizeStrategy(self._target, self._config, conditions)

    async def apply(self, context: ContextState) -> bool:
        """Apply summarization. Returns False if no model is available."""
        if not self._resolve_model(context.agent):
            logger.warning("strategy=<%s> | no model available for summarization", self.name)
            return False
        return await super().apply(context)

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Summarize each contiguous run of eligible messages into its own summary message."""
        model = self._resolve_model(context.agent)
        if not model:
            return False

        messages = context.messages
        if len(messages) <= 1:
            return False

        runs = _contiguous_runs(_removable_indices(messages, await self._get_eligible_messages(context)))
        summarized = False
        # Last run first so earlier indices stay valid as runs collapse.
        for run in reversed(runs):
            summarized = await self._summarize_run(messages, run, model, context.invocation_context) or summarized
        if summarized:
            _repair_alternation(messages)
        return summarized

    async def _summarize_run(
        self,
        messages: Messages,
        run: list[int],
        model: Model,
        invocation_context: InvocationContext | None = None,
    ) -> bool:
        """Replace one run with its summary; a failure is logged and leaves the run intact so the pass continues."""
        safe = [messages[index] for index in run]
        try:
            summary = await _summarize_content(
                _flatten_messages_to_content(safe), model, self._config, invocation_context
            )
        except Exception as error:
            logger.warning("run_length=<%s>, error=<%s> | run summarization failed", len(run), error)
            return False
        if not summary:
            return False

        total_tokens = await model.count_tokens(safe)
        del messages[run[0] : run[-1] + 1]
        _insert_marker(messages, run[0], _format_summarized(f"{len(run)} messages", total_tokens, summary))
        logger.debug("summarized=<%s>, tokens=<%s> | run summarization complete", len(run), total_tokens)
        return True

    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_refs: list[str],
        invocation_context: InvocationContext | None = None,
    ) -> ContentBlock | None:
        model = self._resolve_model(agent)
        if not model:
            return None

        refs = _format_stash_refs(stash_refs)

        if "toolResult" in block:
            tool_result = block["toolResult"]
            content_blocks = _tool_result_to_content_blocks(tool_result["content"])
            summary = await self._try_summarize(content_blocks, model, message, invocation_context)
            if not summary:
                return None

            logger.debug("tool_use_id=<%s>, tokens=<%s> | summarized tool result", tool_result["toolUseId"], tokens)
            marker = _format_summarized("tool result", tokens, summary) + refs
            summarized_content: list[ToolResultContent] = [{"text": marker}]
            return ContentBlock(
                toolResult=ToolResult(
                    toolUseId=tool_result["toolUseId"],
                    status=tool_result["status"],
                    content=summarized_content,
                )
            )

        if "text" in block:
            summary = await self._try_summarize([ContentBlock(text=block["text"])], model, message, invocation_context)
            if not summary:
                return None

            logger.debug("tracking_id=<%s>, tokens=<%s> | summarized text block", message.get("tracking_id"), tokens)
            marker = _format_summarized("text block", tokens, summary) + refs
            return ContentBlock(text=marker)

        if "image" in block or "document" in block:
            summary = await self._try_summarize([block], model, message, invocation_context)
            if summary:
                logger.debug(
                    "tracking_id=<%s>, tokens=<%s> | summarized media block", message.get("tracking_id"), tokens
                )
                marker = _format_summarized("media block", tokens, summary) + refs
                return ContentBlock(text=marker)

        logger.debug("tracking_id=<%s>, tokens=<%s> | offloaded media block", message.get("tracking_id"), tokens)
        return ContentBlock(text=_format_marker("Offloaded", block, tokens, refs))

    async def _try_summarize(
        self,
        content: list[ContentBlock],
        model: Model,
        message: Message,
        invocation_context: InvocationContext | None = None,
    ) -> str | None:
        """Summarize one block; a failure is logged and leaves the block unsummarized so the pass continues."""
        try:
            return await _summarize_content(content, model, self._config, invocation_context)
        except Exception as error:
            logger.warning(
                "tracking_id=<%s>, error=<%s> | block summarization failed", message.get("tracking_id"), error
            )
            return None

    def _resolve_model(self, agent: Agent) -> Model | None:
        return self._config.get("model") or agent.aux_model


def _removable_indices(messages: Messages, eligible: list[Message]) -> list[int]:
    """Indices of the eligible messages plus their tool-use pairs, in order."""
    identity_map = {id(msg): index for index, msg in enumerate(messages)}
    removable_ids: set[int] = set()
    for message in eligible:
        index = identity_map.get(id(message))
        if index is None:
            continue
        removable_ids.update(id(removable) for removable in _collect_removable_with_pair(messages, index))
    return [index for index, msg in enumerate(messages) if id(msg) in removable_ids]


def _contiguous_runs(indices: list[int]) -> list[list[int]]:
    runs: list[list[int]] = []
    for index in indices:
        if runs and runs[-1][-1] == index - 1:
            runs[-1].append(index)
        else:
            runs.append([index])
    return runs
