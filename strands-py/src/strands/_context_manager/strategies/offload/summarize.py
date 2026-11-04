"""Summarize strategy — replaces oversized content with LLM-generated summaries."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from typing_extensions import TypedDict

from ....agent.conversation_manager.compression.pin_message import _get_tool_use_ids, _has_pinned_flag
from ....event_loop.streaming import _record_usage
from ....models._summarize import SummarizeResult, _summarize_with_stream
from ....types.content import ContentBlock, Message, Messages, ProviderData
from ....types.tools import ToolResult, ToolResultContent
from ...stash import MERGED_MESSAGES_KEY, _format_stash_refs
from ...types import ContextState
from .base import (
    BaseOffloadStrategy,
    OffloadConditions,
    OffloadTarget,
    _build_conditions,
    _collect_removable_with_pair,
    _insert_marker,
    _repair_alternation,
)

if TYPE_CHECKING:
    from ....agent.agent import Agent
    from ....agent.invocation_context import InvocationContext
    from ....models.model import Model
    from ...types import ContextStrategy

logger = logging.getLogger(__name__)

_SUMMARIZED_PREFIX = "[Summarized:"


class SummarizeConfig(TypedDict, total=False):
    """Configuration for the summarize method.

    Attributes:
        model: Model used for summarization. Resolution order: this ``model`` > ``agent.aux_model``
            > ``agent.model``.
        system_prompt: Custom system prompt for the summarization model.
    """

    model: Model
    system_prompt: str


def _format_summarized(description: str, tokens: int, summary: str | None = None) -> str:
    """Format a ``[Summarized: ...]`` marker with an optional summary body."""
    header = f"{_SUMMARIZED_PREFIX} {description}, ~{tokens:,} tokens]"
    return f"{header}\n\n{summary}" if summary else header


def _compacts_server_side(model: Model) -> bool:
    """Whether ``model`` declares server-side compaction, so its ``summarize()`` may cover the opening messages."""
    return model.model_info.capabilities.server_side_compaction is True


_LIMIT_STATEMENTS = {
    "pinned messages": "pinned messages are compacted like any other message with server-side compaction",
    "per-block summarization": "per-block summarization with preserve_recent rewrites blocks the model has already seen"
    " | thinking from earlier turns will be dropped on the next turns",
}


def _server_side_compaction_limits(agent: Agent, strategies: Sequence[ContextStrategy]) -> list[str]:
    """Return the features in use that server-side compaction doesn't support, for an agent whose model has it.

    Per-block summarization with ``preserve_recent`` rewrites blocks the model has already seen, and pinned messages are
    compacted like any other message. Without ``preserve_recent``, a block is rewritten before the model sees it.
    """
    if not _compacts_server_side(agent.model):
        return []
    summarizers = [strategy for strategy in strategies if isinstance(strategy, SummarizeStrategy)]
    features = []
    if any(strategy._compacts(agent) for strategy in summarizers) and any(
        _has_pinned_flag(message) for message in agent.messages
    ):
        features.append("pinned messages")
    if any(not strategy._is_message_level and strategy._preserve_recent > 0 for strategy in summarizers):
        features.append("per-block summarization")
    return features


def _warn_on_server_side_compaction_limits(agent: Agent, strategies: Sequence[ContextStrategy]) -> None:
    """Log a warning describing how server-side compaction treats the features in use, if any."""
    features = _server_side_compaction_limits(agent, strategies)
    if not features:
        return
    config: Any = agent.model.get_config()
    model_id = config.get("model_id") if isinstance(config, dict) else None
    statements = [_LIMIT_STATEMENTS[feature] for feature in features]
    logger.warning("model_id=<%s> | %s", model_id, " | ".join(statements))


def _runs(messages: Messages, selected: list[Message]) -> list[list[Message]]:
    """Split ``selected`` and their tool pairs into runs of messages adjacent in ``messages``, in history order."""
    index_of = {id(message): index for index, message in enumerate(messages)}
    indices = sorted(
        {
            index_of[id(removable)]
            for message in selected
            if id(message) in index_of
            for removable in _collect_removable_with_pair(messages, index_of[id(message)])
        }
    )
    runs: list[list[Message]] = []
    for position, index in enumerate(indices):
        if position == 0 or index != indices[position - 1] + 1:
            runs.append([])
        runs[-1].append(messages[index])
    return runs


def _opening_run(messages: Messages, runs: list[list[Message]]) -> list[Message] | None:
    """Return the run right after message 0 that server-side compaction may cover together with message 0.

    The covered messages start with a user message and alternate roles.
    """
    if not runs or runs[0][0] is not messages[1]:
        return None
    roles = [message["role"] for message in messages[: len(runs[0]) + 1]]
    alternates = roles == ["user" if index % 2 == 0 else "assistant" for index in range(len(roles))]
    return runs[0] if alternates else None


def _pieces(message: Message) -> list[Message]:
    """Split ``message`` into the messages merged into it when one of those is pinned, or return it whole."""
    parts = message.get("metadata", {}).get("custom", {}).get(MERGED_MESSAGES_KEY)
    if not parts or not any(_has_pinned_flag(part) for part in parts):
        return [message]
    content = message["content"]
    ends = [part["offset"] for part in parts[1:]] + [len(content)]
    pieces: list[Message] = []
    for part, end in zip(parts, ends, strict=True):
        piece = Message(role=message["role"], content=content[part["offset"] : end])
        if "tracking_id" in part:
            piece["tracking_id"] = part["tracking_id"]
        if part.get("metadata"):
            piece["metadata"] = part["metadata"]
        pieces.append(piece)
    return pieces


def _split_pinned(run: list[Message]) -> tuple[list[Message], list[Message]]:
    """Split ``run`` into its pinned messages, with their tool-pair partners, and the rest, both in history order.

    A merged message is split into the messages it combines, so only its pinned ones are kept.
    """
    pieces = [piece for message in run for piece in _pieces(message) if piece["content"]]
    pinned_ids = {tool_id for piece in pieces if _has_pinned_flag(piece) for tool_id in _get_tool_use_ids(piece)}
    kept = [piece for piece in pieces if _has_pinned_flag(piece) or pinned_ids & _get_tool_use_ids(piece)]
    kept_ids = {id(piece) for piece in kept}
    return kept, [piece for piece in pieces if id(piece) not in kept_ids]


def _holds_only_summaries(run: list[Message]) -> bool:
    """Whether every block of ``run`` is an earlier summary, so summarizing it would only restate that summary."""
    return all(
        "text" in block and block["text"].startswith(_SUMMARIZED_PREFIX)
        for message in run
        for block in message["content"]
    )


def _summary_text(result: SummarizeResult | None) -> str:
    """Return the summary's text blocks, one per line, or ``""`` without a result."""
    if result is None:
        return ""
    return "\n".join(block["text"] for block in result.content if "text" in block).strip()


def _provider_data_of(content: list[ContentBlock]) -> ProviderData | None:
    """Return the provider data of the first text block in ``content`` that carries any."""
    for block in content:
        provider_data = block.get("metadata", {}).get("providerData") if "text" in block else None
        if provider_data:
            return provider_data
    return None


def _block_request(block: ContentBlock, message: Message, messages: Messages) -> Messages:
    """Return the ``Model.summarize()`` input for one block of ``message``.

    The block goes in a message of ``message``'s role. A tool result follows the tool use it answers, when the
    history holds it, so the summarizer sees which tool produced it.
    """
    request = [Message(role=message["role"], content=[block])]
    if "toolResult" not in block:
        return request
    tool_use_id = block["toolResult"]["toolUseId"]
    uses = (candidate for turn in messages for candidate in turn["content"] if "toolUse" in candidate)
    tool_use = next((use for use in uses if use["toolUse"]["toolUseId"] == tool_use_id), None)
    return [Message(role="assistant", content=[tool_use]), *request] if tool_use else request


class SummarizeStrategy(BaseOffloadStrategy):
    """Summarize strategy — replaces oversized content with LLM-generated summaries."""

    # Pinned messages join a run and are kept after its summary, so the opening run still starts at message 1.
    _skips_pinned = False

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

    def when(
        self,
        *,
        threshold: int | None = None,
        utilization: float | None = None,
        preserve_recent: int | float = 0,
    ) -> SummarizeStrategy:
        """Return a new instance with the given conditions applied."""
        return SummarizeStrategy(
            self._target,
            self._config,
            _build_conditions(threshold=threshold, utilization=utilization, preserve_recent=preserve_recent),
        )

    async def apply(self, context: ContextState) -> bool:
        """Apply summarization. Returns False if no model is available."""
        if not self._resolve_model(context.agent):
            logger.warning("strategy=<%s> | no model available for summarization", self.name)
            return False
        return await super().apply(context)

    async def _apply_per_message(self, context: ContextState) -> bool:
        """Summarize each contiguous run of eligible messages into its own summary.

        When both the summarizer and the agent's model have server-side compaction, the run right after message 0 is
        compacted together with message 0 into a message of its own.
        """
        model = self._resolve_model(context.agent)
        if not model:
            return False
        messages = context.messages
        runs = _runs(messages, await self._get_eligible_messages(context))
        # The agent's model sends the stored block natively only when it declares the capability too.
        opening = _opening_run(messages, runs) if self._compacts(context.agent) else None
        acted = False
        # Last run first, so replacing a run leaves the earlier runs' positions unchanged.
        for run in reversed(runs):
            summarize = self._summarize_opening if run is opening else self._summarize_run
            acted = await summarize(context, model, run) or acted
        if acted:
            _repair_alternation(messages)
        return acted

    async def _summarize_run(self, context: ContextState, model: Model, run: list[Message]) -> bool:
        """Replace ``run`` with a summary marker; a failure is logged and keeps the run.

        The marker joins the assistant message before the gap, or leads the run's pinned messages and any assistant
        message after it.
        """
        kept, summarized = _split_pinned(run)
        if not summarized or _holds_only_summaries(summarized):
            return False
        summary = _summary_text(await self._try_summarize(run, model, context.agent, context.invocation_context))
        if not summary:
            return False
        messages = context.messages
        total_tokens = await model.count_tokens(summarized)
        start = next(index for index, message in enumerate(messages) if message is run[0])
        marker = _format_summarized(f"{len(summarized)} messages", total_tokens, summary)
        messages[start : start + len(run)] = kept
        if not kept and start > 1 and messages[start - 1]["role"] == "assistant":
            _insert_marker(messages, start, marker)
        else:
            # Its own message, so it leads any assistant content after the gap once alternation is repaired.
            messages.insert(start, Message(role="assistant", content=[ContentBlock(text=marker)]))
        logger.debug("summarized=<%s>, tokens=<%s> | summarized message run", len(summarized), total_tokens)
        return True

    async def _summarize_opening(self, context: ContextState, model: Model, run: list[Message]) -> bool:
        """Compact the opening run server-side, pinned messages included; without a summary it gets the base one.

        A message the compaction covers can't be kept after its block without breaking the thinking bound to the
        messages after it, so pins don't keep messages out of the compaction.
        """
        return await self._compact_opening(context, model, run) or await self._summarize_run(context, model, run)

    async def _compact_opening(self, context: ContextState, model: Model, run: list[Message]) -> bool:
        """Compact message 0 and ``run`` server-side, keeping message 0 in place.

        The summary takes the run's place as an assistant message, ahead of any assistant content that follows, and
        the provider sends its block, which covers message 0, in place of the text.
        """
        if _holds_only_summaries(run):
            return False
        messages = context.messages
        request = [messages[0], *run]
        result = await self._try_summarize(request, model, context.agent, context.invocation_context, opening=True)
        summary = _summary_text(result)
        if not result or not summary:
            return False
        total_tokens = await model.count_tokens(run)
        marker = ContentBlock(text=_format_summarized(f"{len(run)} messages", total_tokens, summary))
        provider_data = _provider_data_of(result.content)
        if provider_data:
            marker["metadata"] = {"providerData": provider_data}
        messages[1 : 1 + len(run)] = [Message(role="assistant", content=[marker])]
        logger.debug("summarized=<%s>, tokens=<%s> | compacted opening messages", len(run), total_tokens)
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
        summarizable = "toolResult" in block or "text" in block or "image" in block or "document" in block
        request = _block_request(block, message, agent.messages) if summarizable else None
        summary = _summary_text(await self._try_summarize(request, model, agent, invocation_context)) if request else ""

        if "toolResult" in block:
            if not summary:
                return None
            tool_result = block["toolResult"]
            logger.debug("tool_use_id=<%s>, tokens=<%s> | summarized tool result", tool_result["toolUseId"], tokens)
            summarized_content: list[ToolResultContent] = [
                {"text": _format_summarized("tool result", tokens, summary) + refs}
            ]
            return ContentBlock(
                toolResult=ToolResult(
                    toolUseId=tool_result["toolUseId"], status=tool_result["status"], content=summarized_content
                )
            )

        if "text" in block:
            if not summary:
                return None
            logger.debug("tracking_id=<%s>, tokens=<%s> | summarized text block", message.get("tracking_id"), tokens)
            return ContentBlock(text=_format_summarized("text block", tokens, summary) + refs)

        if summary:
            logger.debug("tracking_id=<%s>, tokens=<%s> | summarized media block", message.get("tracking_id"), tokens)
            return ContentBlock(text=_format_summarized("media block", tokens, summary) + refs)

        logger.debug("tracking_id=<%s>, tokens=<%s> | offloaded media block", message.get("tracking_id"), tokens)
        return ContentBlock(text=f"[Offloaded: ~{tokens} tokens]{refs}")

    async def _try_summarize(
        self,
        messages: Messages,
        model: Model,
        agent: Agent,
        invocation_context: InvocationContext | None,
        *,
        opening: bool = False,
    ) -> SummarizeResult | None:
        """Summarize ``messages`` and record the call's usage; a failure is logged and returns ``None``.

        A model with server-side compaction is called through its ``summarize()`` only for ``opening`` messages; its
        other summaries use the base implementation.
        """
        instructions = self._config.get("system_prompt")
        try:
            if opening or not _compacts_server_side(model):
                result = await model.summarize(
                    messages,
                    tool_specs=agent.tool_registry.get_all_tool_specs(),
                    system_prompt=agent.system_prompt,
                    system_prompt_content=agent.system_prompt_content,
                    instructions=instructions,
                    cancel_signal=agent.cancel_signal,
                )
            else:
                result = await _summarize_with_stream(
                    model, messages, instructions=instructions, cancel_signal=agent.cancel_signal
                )
        except Exception as error:
            logger.warning("messages=<%s>, error=<%s> | summarization failed", len(messages), error)
            return None
        if result.usage:
            _record_usage(invocation_context, result.usage)
        return result

    def _resolve_model(self, agent: Agent) -> Model | None:
        return self._config.get("model") or agent.aux_model

    def _compacts(self, agent: Agent) -> bool:
        """Whether this strategy summarizes message runs and its summarizer and the agent's model compact natively."""
        model = self._resolve_model(agent)
        return (
            self._is_message_level
            and model is not None
            and _compacts_server_side(model)
            and _compacts_server_side(agent.model)
        )
