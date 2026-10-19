"""Tests for the agentic token-usage middleware."""

from unittest.mock import Mock

import pytest

from strands import Agent
from strands._context_manager.modes.agentic.agentic_context import create_token_usage_middleware
from strands.middleware.stages import InvokeModelContext
from strands.types.content import Message
from tests.fixtures.mocked_model_provider import MockedModelProvider


def mock_model(context_window_limit=None):
    model = Mock()
    model.context_window_limit = context_window_limit
    return model


def make_context(**overrides) -> InvokeModelContext:
    defaults = dict(
        agent=Mock(),
        messages=[{"role": "user", "content": [{"text": "hello"}]}],
        system_prompt=None,
        tool_specs=[],
        tool_choice=None,
        invocation_state={},
        model=mock_model(200_000),
    )
    defaults.update(overrides)
    return InvokeModelContext(**defaults)


@pytest.mark.asyncio
class TestCreateTokenUsageMiddleware:
    async def test_returns_context_unchanged_when_projected_tokens_not_set(self):
        middleware = create_token_usage_middleware()
        context = make_context()

        result = await middleware(context)

        assert result is context

    async def test_returns_context_unchanged_when_messages_are_empty(self):
        middleware = create_token_usage_middleware()
        context = make_context(messages=[], projected_input_tokens=50_000)

        result = await middleware(context)

        assert result is context

    async def test_appends_context_status_to_last_message_content(self):
        middleware = create_token_usage_middleware()
        context = make_context(model=mock_model(200_000), projected_input_tokens=50_000)

        result = await middleware(context)

        assert len(result.messages) == 1
        last_msg = result.messages[0]
        assert len(last_msg["content"]) == 2
        status_text = last_msg["content"][1]["text"]
        assert "<context-status>" in status_text
        assert "25.0%" in status_text
        assert "<remaining>" in status_text
        assert "</context-status>" in status_text

    async def test_uses_the_effective_context_model_limit_not_a_captured_default(self):
        # guards against reporting the agent's default-model window for a redirected call
        middleware = create_token_usage_middleware()
        context = make_context(model=mock_model(10_000), projected_input_tokens=8_000)

        result = await middleware(context)

        status_text = result.messages[0]["content"][1]["text"]
        assert "8,000 / 10,000 tokens (80.0%)" in status_text
        assert "<remaining>~2,000 tokens</remaining>" in status_text

    async def test_does_not_mutate_the_original_messages(self):
        middleware = create_token_usage_middleware()
        original_message: Message = {"role": "user", "content": [{"text": "hello"}]}
        context = make_context(messages=[original_message], projected_input_tokens=50_000)

        result = await middleware(context)

        assert result.messages is not context.messages
        assert len(original_message["content"]) == 1

    async def test_uses_default_context_window_limit_when_model_has_no_limit(self):
        middleware = create_token_usage_middleware()
        context = make_context(model=mock_model(None), projected_input_tokens=100_000)

        result = await middleware(context)

        status_text = result.messages[0]["content"][1]["text"]
        assert "<context-status>" in status_text
        assert "50.0%" in status_text
        assert "200,000" in status_text

    async def test_preserves_message_metadata(self):
        middleware = create_token_usage_middleware()
        metadata = {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}
        context = make_context(
            messages=[{"role": "user", "content": [{"text": "hello"}], "metadata": metadata}],
            projected_input_tokens=50_000,
        )

        result = await middleware(context)

        assert result.messages[0]["metadata"] == metadata

    async def test_reports_correct_remaining_tokens(self):
        middleware = create_token_usage_middleware()
        context = make_context(model=mock_model(100_000), projected_input_tokens=80_000)

        result = await middleware(context)

        status_text = result.messages[0]["content"][1]["text"]
        assert "80.0%" in status_text
        assert "<remaining>~20,000 tokens</remaining>" in status_text


class _LimitedModelProvider(MockedModelProvider):
    """MockedModelProvider with a context window limit, for integration tests."""

    def __init__(self, agent_responses, usages=None, context_window_limit=100_000):
        super().__init__(agent_responses, usages)
        self._context_window_limit = context_window_limit

    @property
    def context_window_limit(self):
        return self._context_window_limit

    async def count_tokens(self, messages):
        return 1_000


@pytest.mark.asyncio
class TestTokenUsageMiddlewareIntegration:
    async def test_injects_context_status_into_messages_sent_to_model(self):
        model = _LimitedModelProvider(
            [
                {"role": "assistant", "content": [{"text": "First response"}]},
                {"role": "assistant", "content": [{"text": "Second response"}]},
            ],
            usages=[
                {"inputTokens": 1000, "outputTokens": 200, "totalTokens": 1200},
                {"inputTokens": 2000, "outputTokens": 300, "totalTokens": 2300},
            ],
        )

        seen_messages = []
        original_stream = model.stream

        def capturing_stream(messages, *args, **kwargs):
            seen_messages.append(messages)
            return original_stream(messages, *args, **kwargs)

        model.stream = capturing_stream

        agent = Agent(model=model, context_manager="agentic", callback_handler=None)
        await agent.invoke_async("First message")
        await agent.invoke_async("Second message")

        last_messages = seen_messages[-1]
        last_block = last_messages[-1]["content"][-1]
        assert "<context-status>" in last_block["text"]
        assert "100,000" in last_block["text"]
        assert "<remaining>" in last_block["text"]

    async def test_not_injected_when_context_manager_not_agentic(self):
        model = _LimitedModelProvider(
            [{"role": "assistant", "content": [{"text": "First response"}]}],
            usages=[{"inputTokens": 1000, "outputTokens": 200, "totalTokens": 1200}],
        )

        seen_messages = []
        original_stream = model.stream

        def capturing_stream(messages, *args, **kwargs):
            seen_messages.append(messages)
            return original_stream(messages, *args, **kwargs)

        model.stream = capturing_stream

        agent = Agent(model=model, callback_handler=None)
        await agent.invoke_async("First message")

        for messages in seen_messages:
            for block in messages[-1]["content"]:
                assert "<context-status>" not in block.get("text", "")


@pytest.mark.asyncio
async def test_status_line_is_reported_as_per_call_content():
    """The status line carries a live token count, so it is rebuilt on every call.

    Reporting it keeps a provider's cache point ahead of it; otherwise the cache point lands after
    a block that changes every turn and no request ever reads a cache entry.
    """
    middleware = create_token_usage_middleware()
    context = make_context(projected_input_tokens=50_000)

    result = await middleware(context)

    assert result.dynamic_trailing_blocks == 1


@pytest.mark.asyncio
async def test_reports_nothing_when_the_status_line_lands_in_an_assistant_message():
    """The status text is appended to the last message whatever its role, but only a boundary on the
    last user message is meaningful. On an assistant-terminated history the text is already outside the
    cached prefix, so reporting trailing blocks would move a provider's cache point off the end of the last user
    message and evict durable content. Reachable via ``agent()`` with no prompt and restored sessions.
    """
    middleware = create_token_usage_middleware()
    context = make_context(
        messages=[
            {"role": "user", "content": [{"text": "durable ask"}]},
            {"role": "assistant", "content": [{"text": "reply"}]},
        ],
        projected_input_tokens=50_000,
    )

    result = await middleware(context)

    assert result.messages[-1]["role"] == "assistant"
    assert "<context-status>" in result.messages[-1]["content"][-1]["text"]
    assert result.dynamic_trailing_blocks == 0


@pytest.mark.asyncio
async def test_reports_nothing_when_projection_is_unavailable():
    middleware = create_token_usage_middleware()
    context = make_context()

    result = await middleware(context)

    assert result.dynamic_trailing_blocks == 0
