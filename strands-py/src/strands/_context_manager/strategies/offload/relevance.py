"""Relevance strategy — replaces an oversized tool result with the parts the query asks about."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from typing_extensions import TypedDict

from ....types.content import ContentBlock, Message
from ....types.tools import ToolResult, ToolResultContent
from ...methods.relevance import RelevancePreview
from ...methods.reranker import BedrockReranker, Reranker, RerankerError
from ...methods.truncate import DEFAULT_PREVIEW_TOKENS
from ...stash import _format_stash_refs
from .base import BaseOffloadStrategy, OffloadConditions, OffloadTarget, _build_conditions

if TYPE_CHECKING:
    from ....agent.agent import Agent

logger = logging.getLogger(__name__)

_DEFAULT_RELEVANCE_THRESHOLD = 0.5
_DEFAULT_CHUNK_TOKENS = 2500
_MAX_QUERY_CHARS = 2000


class RelevanceConfig(TypedDict, total=False):
    """Configuration for the relevance method.

    Attributes:
        reranker: Scorer used to rank chunks. Defaults to a ``BedrockReranker``.
        relevance_threshold: Minimum score, in ``[0.0, 1.0]``, for a chunk to enter the preview.
        chunk_tokens: Approximate token size of each scored chunk.
        preview_tokens: Approximate token budget of the whole preview.
        summarize_overflow: Reserved; whether a truncated preview may be summarized.
    """

    reranker: Reranker
    relevance_threshold: float
    chunk_tokens: int
    preview_tokens: int
    summarize_overflow: bool


def _tool_result_text(tool_result: ToolResult) -> str:
    """Concatenate the text and JSON blocks of a tool result into one string."""
    parts: list[str] = []
    for item in tool_result["content"]:
        if item.get("text"):
            parts.append(item["text"])
        elif "json" in item:
            parts.append(json.dumps(item["json"], indent=2))
    return "\n".join(parts)


def _build_query(tool_result: ToolResult, agent: Agent) -> str:
    """Build the scoring query from the latest user question plus the tool call arguments.

    The block being replaced carries only ``toolUseId``, so both signals are recovered from
    ``agent.messages``: the newest user message with text, and the ``toolUse`` matching the id.
    """
    user_text = _latest_question(agent)

    try:
        serialized = json.dumps(_tool_input(agent, tool_result["toolUseId"]))
    except (TypeError, ValueError):
        return user_text[-_MAX_QUERY_CHARS:] or "{}"

    if len(serialized) >= _MAX_QUERY_CHARS:
        return serialized[:_MAX_QUERY_CHARS]

    query = f"{user_text}\n{serialized}" if user_text else serialized
    return query[-_MAX_QUERY_CHARS:]


def _latest_question(agent: Agent) -> str:
    """The newest user message carrying text, or ``""``. Tool-result-only turns are not questions."""
    for message in reversed(agent.messages):
        if message.get("role") != "user":
            continue
        texts = [block["text"] for block in message.get("content", []) if block.get("text")]
        if texts:
            return "\n".join(texts)
    return ""


def _tool_input(agent: Agent, tool_use_id: str) -> object:
    """The arguments of the ``toolUse`` matching ``tool_use_id``, or an empty mapping."""
    for message in agent.messages:
        if message.get("role") != "assistant":
            continue
        for block in message["content"]:
            if "toolUse" in block and block["toolUse"]["toolUseId"] == tool_use_id:
                return block["toolUse"].get("input", {})
    return {}


class RelevanceStrategy(BaseOffloadStrategy):
    """Relevance strategy — replaces an oversized tool result with a query-relevant preview."""

    @property
    def name(self) -> str:
        """Strategy name."""
        return "offload:relevance"

    def __init__(
        self,
        target: OffloadTarget | None = None,
        config: RelevanceConfig | None = None,
        conditions: OffloadConditions | None = None,
    ) -> None:
        super().__init__(target, conditions)
        self._config: RelevanceConfig = config or {}
        self._preview: RelevancePreview | None = None

    def _resolve_preview(self) -> RelevancePreview:
        """Build the preview builder lazily, so the reranker's AWS client is created only on first use."""
        if self._preview is None:
            self._preview = RelevancePreview(
                self._config.get("reranker") or BedrockReranker(),
                relevance_threshold=self._config.get("relevance_threshold", _DEFAULT_RELEVANCE_THRESHOLD),
                chunk_tokens=self._config.get("chunk_tokens", _DEFAULT_CHUNK_TOKENS),
                preview_tokens=self._config.get("preview_tokens", DEFAULT_PREVIEW_TOKENS),
                summarize_overflow=self._config.get("summarize_overflow", False),
            )
        return self._preview

    def when(
        self,
        *,
        threshold: int | None = None,
        utilization: float | None = None,
        preserve_recent: int | float = 0,
    ) -> RelevanceStrategy:
        """Return a new instance with the given conditions applied."""
        return RelevanceStrategy(
            self._target,
            self._config,
            _build_conditions(threshold=threshold, utilization=utilization, preserve_recent=preserve_recent),
        )

    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        stash_refs: list[str],
    ) -> ContentBlock | None:
        if "toolResult" not in block:
            return None

        tool_result = block["toolResult"]
        text = _tool_result_text(tool_result)
        if not text:
            return None

        try:
            preview = await self._resolve_preview().build(text, _build_query(tool_result, agent))
        except RerankerError:
            logger.debug("tool_use_id=<%s> | relevance scoring failed, leaving block", tool_result["toolUseId"])
            return None

        logger.debug("tool_use_id=<%s>, tokens=<%s> | relevance-filtered tool result", tool_result["toolUseId"], tokens)
        marker = f"[Relevance: tool result, ~{tokens:,} tokens]\n\n{preview}" + _format_stash_refs(stash_refs)
        relevant_content: list[ToolResultContent] = [{"text": marker}]
        return ContentBlock(
            toolResult=ToolResult(
                toolUseId=tool_result["toolUseId"],
                status=tool_result["status"],
                content=relevant_content,
            )
        )
