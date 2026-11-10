"""Tests for the RelevanceStrategy."""

import unittest.mock

import pytest

from strands._context_manager.methods.reranker import RerankerError
from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.relevance import RelevanceStrategy, _build_query
from strands._context_manager.types import ContextState
from strands.hooks.events import MessageAddedEvent
from strands.hooks.registry import HookRegistry
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse


class _KeywordReranker:
    """Deterministic reranker: 1.0 for chunks containing the query, else 0.0. No AWS."""

    max_sources_per_query = 100

    def __init__(self):
        self.calls: list[tuple[str, int]] = []

    async def score(self, query: str, chunks: list[str]) -> list[float]:
        if not query.strip():
            raise RerankerError("query must not be empty")
        self.calls.append((query, len(chunks)))
        return [1.0 if any(word in chunk for word in query.split()) else 0.0 for chunk in chunks]


class _RaisingReranker:
    max_sources_per_query = 100

    async def score(self, query: str, chunks: list[str]) -> list[float]:
        raise RerankerError("boom")


@pytest.fixture
def mock_agent():
    agent = unittest.mock.MagicMock()
    agent.model = unittest.mock.AsyncMock()
    agent.model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
    agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.4)
    agent.hooks = HookRegistry()
    agent.messages = []
    return agent


def _turn(result_text: str, tool_use_id: str = "t1") -> Messages:
    return [
        Message(role="user", content=[ContentBlock(text="find the ERROR line")]),
        Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId=tool_use_id, name="read_log", input={"path": "app.log"}))],
        ),
        Message(
            role="user",
            content=[
                ContentBlock(
                    toolResult=ToolResult(toolUseId=tool_use_id, status="success", content=[{"text": result_text}])
                )
            ],
        ),
    ]


def _relevance(reranker, **kwargs) -> RelevanceStrategy:
    # Small-but-realistic budget: one line per chunk, room for a few lines of preview.
    config = {"reranker": reranker, "chunk_tokens": 8, "preview_tokens": 40, **kwargs}
    return Offload.relevance("tool_results", config).when(threshold=100)


class TestRelevanceStrategyPerBlock:
    @pytest.mark.asyncio
    async def test_keeps_relevant_chunk_of_tool_result(self, mock_agent):
        reranker = _KeywordReranker()
        # Many lines; only one carries the query word "ERROR".
        result = "\n".join(["noise"] * 40 + ["the ERROR line here"] + ["noise"] * 40)
        messages = _turn(result)
        mock_agent.messages = messages
        strategy = _relevance(reranker)
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.4)

        assert await strategy.apply(context) is True
        new_text = messages[2]["content"][0]["toolResult"]["content"][0]["text"]
        assert "[Relevance:" in new_text
        assert "ERROR" in new_text
        # The query walk recovered the question and the tool arguments.
        assert reranker.calls, "reranker was never called"
        query = reranker.calls[0][0]
        assert "ERROR" in query and "app.log" in query

    @pytest.mark.asyncio
    async def test_reranker_error_leaves_block_untouched(self, mock_agent):
        result = "\n".join(["line"] * 200)
        messages = _turn(result)
        mock_agent.messages = messages
        strategy = _relevance(_RaisingReranker())
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.4)

        assert await strategy.apply(context) is False
        assert messages[2]["content"][0]["toolResult"]["content"][0]["text"] == result

    @pytest.mark.asyncio
    async def test_empty_tool_result_is_skipped(self, mock_agent):
        messages = _turn("")
        mock_agent.messages = messages
        strategy = _relevance(_KeywordReranker())
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.4)
        assert await strategy.apply(context) is False


class TestRelevanceStrategyEager:
    """The threshold config registers the eager hook — proactive cleanup at MessageAddedEvent."""

    def test_threshold_registers_eager_hook(self, mock_agent):
        strategy = _relevance(_KeywordReranker())
        strategy.init(mock_agent)
        assert len(mock_agent.hooks._registered_callbacks.get(MessageAddedEvent, [])) == 1

    def test_utilization_does_not_register_eager_hook(self, mock_agent):
        strategy = Offload.relevance("tool_results", {"reranker": _KeywordReranker()}).when(utilization=0.85)
        strategy.init(mock_agent)
        assert len(mock_agent.hooks._registered_callbacks.get(MessageAddedEvent, [])) == 0

    @pytest.mark.asyncio
    async def test_eager_hook_cleans_tool_result_in_place(self, mock_agent):
        reranker = _KeywordReranker()
        strategy = _relevance(reranker)
        strategy.init(mock_agent)
        callbacks = mock_agent.hooks._registered_callbacks[MessageAddedEvent]

        result = "\n".join(["noise"] * 40 + ["the ERROR line"] + ["noise"] * 40)
        for message in _turn(result):
            mock_agent.messages.append(message)
            for callback in callbacks:
                await callback.callback(MessageAddedEvent(agent=mock_agent, message=message))

        cleaned = mock_agent.messages[2]["content"][0]["toolResult"]["content"][0]["text"]
        assert "[Relevance:" in cleaned
        assert len(cleaned) < len(result)


class TestBuildQuery:
    def test_recovers_question_and_tool_arguments(self):
        agent = unittest.mock.MagicMock()
        agent.messages = _turn("body")
        query = _build_query(agent.messages[2]["content"][0]["toolResult"], agent)
        assert "ERROR" in query  # the user question
        assert "app.log" in query  # the tool arguments

    def test_no_question_uses_arguments_only(self):
        agent = unittest.mock.MagicMock()
        agent.messages = [
            Message(
                role="assistant",
                content=[ContentBlock(toolUse=ToolUse(toolUseId="t1", name="read_log", input={"path": "x.log"}))],
            ),
            Message(
                role="user",
                content=[
                    ContentBlock(toolResult=ToolResult(toolUseId="t1", status="success", content=[{"text": "b"}]))
                ],
            ),
        ]
        query = _build_query(agent.messages[1]["content"][0]["toolResult"], agent)
        assert "x.log" in query
