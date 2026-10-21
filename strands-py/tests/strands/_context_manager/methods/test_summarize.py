"""Tests for the summarize method module."""

import unittest.mock

import pytest

from strands._context_manager.methods.summarize import (
    SUMMARIZE_CONVERSATION_INSTRUCTION,
    _summarize_content,
    _summarize_conversation,
    _tool_result_to_content_blocks,
)
from strands.types.content import ContentBlock, Message


@pytest.fixture
def mock_model():
    model = unittest.mock.AsyncMock()
    model.stream = unittest.mock.AsyncMock()
    return model


def _make_stream_events(text: str):
    """Create async generator of stream events for a text response."""

    async def gen(*args, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": text}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}

    return gen


class TestToolResultToContentBlocks:
    """Tests for converting tool result content to content blocks."""

    def test_converts_text_content(self):
        content = [{"text": "hello"}]
        tru_result = _tool_result_to_content_blocks(content)
        assert tru_result == [ContentBlock(text="hello")]

    def test_passes_through_non_text_content(self):
        content = [{"image": {"format": "png", "source": {"bytes": b"data"}}}]
        tru_result = _tool_result_to_content_blocks(content)
        assert len(tru_result) == 1

    def test_handles_mixed_content(self):
        content = [
            {"text": "first"},
            {"image": {"format": "png", "source": {"bytes": b"data"}}},
            {"text": "second"},
        ]
        tru_result = _tool_result_to_content_blocks(content)
        assert len(tru_result) == 3
        assert tru_result[0] == ContentBlock(text="first")
        assert tru_result[2] == ContentBlock(text="second")


class TestSummarizeContent:
    """Tests for the summarize_content function."""

    @pytest.mark.asyncio
    async def test_returns_summary_text(self, mock_model):
        mock_model.stream = _make_stream_events("This is a summary.")
        content_blocks = [ContentBlock(text="Some long content to summarize.")]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result == "This is a summary."

    @pytest.mark.asyncio
    async def test_returns_none_on_empty_response(self, mock_model):
        mock_model.stream = _make_stream_events("")
        content_blocks = [ContentBlock(text="content")]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result is None or tru_result == ""

    @pytest.mark.asyncio
    async def test_uses_custom_system_prompt(self, mock_model):
        mock_model.stream = _make_stream_events("custom summary")
        content_blocks = [ContentBlock(text="content")]
        config = {"system_prompt": "Be very brief."}

        tru_result = await _summarize_content(content_blocks, mock_model, config)
        assert tru_result == "custom summary"

    @pytest.mark.asyncio
    async def test_text_only_fallback_on_exception(self, mock_model):
        """When the first call throws, retries with text-only blocks."""
        call_count = 0

        def stream_side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("model error")
            return _make_stream_events("Fallback summary.")(*args, **kwargs)

        mock_model.stream = stream_side_effect
        content_blocks = [
            ContentBlock(text="some text"),
            ContentBlock(toolResult={"toolUseId": "t1", "status": "success", "content": [{"text": "result"}]}),
        ]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result == "Fallback summary."
        assert call_count == 2

    @pytest.mark.asyncio
    async def test_text_only_fallback_skipped_when_all_text(self, mock_model):
        """When all blocks are already text-only, no fallback retry happens."""

        def stream_side_effect(*args, **kwargs):
            raise RuntimeError("model error")

        mock_model.stream = stream_side_effect
        content_blocks = [ContentBlock(text="only text")]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result is None

    @pytest.mark.asyncio
    async def test_text_only_fallback_skipped_when_no_text_blocks(self, mock_model):
        """When there are no text blocks at all, no fallback retry happens."""

        def stream_side_effect(*args, **kwargs):
            raise RuntimeError("model error")

        mock_model.stream = stream_side_effect
        content_blocks = [
            ContentBlock(toolResult={"toolUseId": "t1", "status": "success", "content": [{"text": "result"}]}),
        ]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result is None

    @pytest.mark.asyncio
    async def test_call_summarizer_no_text_in_response(self, mock_model):
        """When model returns a response with no text blocks, result is None."""

        async def no_text_stream(*args, **kwargs):
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
            yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 0, "totalTokens": 10}}}

        mock_model.stream = no_text_stream
        content_blocks = [ContentBlock(text="content to summarize")]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result is None

    def test_format_summarized_uses_expected_prefix(self):
        from strands._context_manager.methods.summarize import _format_summarized

        assert _format_summarized("test", 100).startswith("[Summarized:")


class TestToolResultToContentBlocksJson:
    """Tests for JSON content in tool_result_to_content_blocks."""

    def test_converts_json_content_to_text(self):
        content = [{"json": {"key": "value", "count": 42}}]
        tru_result = _tool_result_to_content_blocks(content)
        assert len(tru_result) == 1
        assert tru_result[0]["text"] == '{\n  "key": "value",\n  "count": 42\n}'

    def test_handles_mixed_json_and_text(self):
        content = [
            {"text": "plain text"},
            {"json": {"nested": True}},
        ]
        tru_result = _tool_result_to_content_blocks(content)
        assert len(tru_result) == 2
        assert tru_result[0] == ContentBlock(text="plain text")
        assert tru_result[1]["text"] == '{\n  "nested": true\n}'


@pytest.fixture
def mock_agent():
    agent = unittest.mock.MagicMock()
    agent.system_prompt_content = [{"text": "You are the agent."}]
    agent._cancel_signal = None
    agent.tool_registry.get_all_tool_specs.return_value = [{"name": "calc", "description": "d", "inputSchema": {}}]
    return agent


class TestSummarizeConversation:
    """Tests for replaying the agent's request with a trailing summarize instruction."""

    @pytest.mark.asyncio
    async def test_replays_agent_request_plus_instruction(self, mock_model, mock_agent):
        seen: list = []

        def stream(messages, tool_specs, system_prompt, **kwargs):
            seen.append((messages, tool_specs, system_prompt, kwargs))
            return _make_stream_events("summary")()

        mock_model.stream = stream
        history = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[ContentBlock(text="working")]),
        ]
        tru_result = await _summarize_conversation(history, mock_agent, mock_model, {})
        assert tru_result == "summary"
        messages, tool_specs, system_prompt, kwargs = seen[0]
        assert messages == [
            *history,
            Message(role="user", content=[ContentBlock(text=SUMMARIZE_CONVERSATION_INSTRUCTION)]),
        ]
        assert tool_specs == mock_agent.tool_registry.get_all_tool_specs.return_value
        assert system_prompt == "You are the agent."
        assert kwargs["system_prompt_content"] == [{"text": "You are the agent."}]
        assert history[-1]["content"] == [ContentBlock(text="working")]

    @pytest.mark.asyncio
    async def test_appends_instruction_to_trailing_user_message(self, mock_model, mock_agent):
        seen: list = []

        def stream(messages, *args, **kwargs):
            seen.append(messages)
            return _make_stream_events("summary")()

        mock_model.stream = stream
        tool_result = ContentBlock(toolResult={"toolUseId": "t1", "status": "success", "content": [{"text": "42"}]})
        history = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[ContentBlock(toolUse={"toolUseId": "t1", "name": "calc", "input": {}})]),
            Message(role="user", content=[tool_result]),
        ]
        await _summarize_conversation(history, mock_agent, mock_model, {})
        assert seen[0][-1] == Message(
            role="user", content=[tool_result, ContentBlock(text=SUMMARIZE_CONVERSATION_INSTRUCTION)]
        )
        assert len(seen[0]) == 3
        assert history[-1]["content"] == [tool_result]

    @pytest.mark.asyncio
    async def test_uses_agent_system_prompt_content_blocks_when_present(self, mock_model, mock_agent):
        seen: list = []

        def stream(messages, tool_specs, system_prompt, **kwargs):
            seen.append((system_prompt, kwargs["system_prompt_content"]))
            return _make_stream_events("summary")()

        mock_model.stream = stream
        mock_agent.system_prompt_content = [{"text": "Blocks."}, {"cachePoint": {"type": "default"}}]
        history = [Message(role="user", content=[ContentBlock(text="task")])]
        await _summarize_conversation(history, mock_agent, mock_model, {})
        assert seen[0] == ("Blocks.", mock_agent.system_prompt_content)

    @pytest.mark.asyncio
    async def test_custom_system_prompt_replaces_agent_prompt(self, mock_model, mock_agent):
        seen: list = []

        def stream(messages, tool_specs, system_prompt, **kwargs):
            seen.append((system_prompt, kwargs["system_prompt_content"]))
            return _make_stream_events("summary")()

        mock_model.stream = stream
        history = [Message(role="user", content=[ContentBlock(text="task")])]
        await _summarize_conversation(history, mock_agent, mock_model, {"system_prompt": "Be brief."})
        assert seen[0] == ("Be brief.", None)

    @pytest.mark.asyncio
    async def test_forwards_agent_metadata_and_cancel_signal(self, mock_model, mock_agent):
        seen: list = []

        def stream(messages, tool_specs, system_prompt, **kwargs):
            seen.append(kwargs)
            return _make_stream_events("summary")()

        mock_model.stream = stream
        history = [Message(role="user", content=[ContentBlock(text="task")])]
        await _summarize_conversation(history, mock_agent, mock_model, {})
        assert seen[0]["agent_metadata"] is mock_agent._metadata
        assert seen[0]["cancel_signal"] is mock_agent._cancel_signal

    @pytest.mark.asyncio
    async def test_tool_use_reply_falls_back_to_self_contained_request(self, mock_model, mock_agent):
        seen: list = []

        async def tool_use_reply(*args, **kwargs):
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t9", "name": "calc"}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}

        def stream(messages, tool_specs, system_prompt, **kwargs):
            seen.append((messages, tool_specs, system_prompt))
            if len(seen) == 1:
                return tool_use_reply()
            return _make_stream_events("fallback summary")()

        mock_model.stream = stream
        history = [
            Message(role="user", content=[ContentBlock(text="task")]),
            Message(role="assistant", content=[ContentBlock(text="done")]),
            Message(role="user", content=[ContentBlock(text="now look up ORD-2")]),
        ]
        assert await _summarize_conversation(history, mock_agent, mock_model, {}) == "fallback summary"
        messages, tool_specs, system_prompt = seen[1]
        assert tool_specs is None
        assert system_prompt.startswith("You are a summarization assistant")
        assert messages[0]["content"][0] == ContentBlock(text="<content>")
        assert messages[0]["content"][-1] == ContentBlock(text="</content>")
        assert ContentBlock(text="now look up ORD-2") in messages[0]["content"]

    @pytest.mark.asyncio
    async def test_returns_none_when_both_requests_fail(self, mock_model, mock_agent):
        calls = 0

        def stream(*args, **kwargs):
            nonlocal calls
            calls += 1
            raise RuntimeError("boom")

        mock_model.stream = stream
        history = [Message(role="user", content=[ContentBlock(text="task")])]
        assert await _summarize_conversation(history, mock_agent, mock_model, {}) is None
        assert calls == 2
