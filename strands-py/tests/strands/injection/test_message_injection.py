"""Tests for the injection delivery primitives."""

from typing import Any
from unittest.mock import MagicMock

import pytest

from strands.injection._message_injection import (
    _create_injection_middleware,
    _fold_into_last_user_message,
    _is_user_turn,
    _resolve_trigger,
)
from strands.middleware.stages import InvokeModelContext


def user(text: str) -> dict:
    return {"role": "user", "content": [{"text": text}]}


def assistant(text: str) -> dict:
    return {"role": "assistant", "content": [{"text": text}]}


def tool_result() -> dict:
    return {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": "t1", "status": "success", "content": [{"text": "done"}]}}],
    }


def injection_ctx(messages: list[dict]) -> Any:
    # _resolve_trigger predicates only read `messages`; a minimal stub suffices.
    ctx = MagicMock()
    ctx.messages = messages
    return ctx


def make_agent(state: Any = None) -> Any:
    agent = MagicMock()
    agent.state = state if state is not None else MagicMock()
    return agent


def invoke_ctx(messages: list[dict], agent: Any = None) -> InvokeModelContext:
    """Build an InvokeModelContext; the handler reads messages and agent.state/agent."""
    return InvokeModelContext(
        agent=agent or make_agent(),
        messages=messages,
        system_prompt=None,
        tool_specs=[],
        tool_choice=None,
        invocation_state={},
        model=MagicMock(),
    )


class TestFoldIntoLastUserMessage:
    def test_appends_text_after_user_content(self):
        messages = [user("original task"), assistant("prior step"), user("next ask")]
        result, dynamic_trailing_blocks = _fold_into_last_user_message(messages, "INJECTED")

        assert result == [
            {"role": "user", "content": [{"text": "original task"}]},
            {"role": "assistant", "content": [{"text": "prior step"}]},
            {"role": "user", "content": [{"text": "next ask"}, {"text": "\n\nINJECTED"}]},
        ]

    def test_returns_new_list_and_does_not_mutate_input(self):
        original = user("ask")
        messages = [assistant("prior"), original]
        result, dynamic_trailing_blocks = _fold_into_last_user_message(messages, "INJECTED")

        assert result is not messages
        assert messages[1] is original
        assert len(original["content"]) == 1  # untouched
        assert result[1] is not original

    def test_appends_after_tool_result_block(self):
        tr = tool_result()
        messages = [user("task"), assistant("thinking"), tr]
        result, dynamic_trailing_blocks = _fold_into_last_user_message(messages, "INJECTED")

        # Providers require the tool result to be the first block, so the text is appended.
        assert result == [
            {"role": "user", "content": [{"text": "task"}]},
            {"role": "assistant", "content": [{"text": "thinking"}]},
            {"role": "user", "content": [tr["content"][0], {"text": "INJECTED"}]},
        ]

    def test_appends_text_without_separator_when_the_message_has_no_text(self):
        image = {"image": {"format": "png", "source": {"bytes": b"png"}}}
        messages = [{"role": "user", "content": [image]}]
        result, dynamic_trailing_blocks = _fold_into_last_user_message(messages, "INJECTED")

        assert result == [{"role": "user", "content": [image, {"text": "INJECTED"}]}]

    def test_keeps_separator_when_a_cache_point_follows_the_user_text(self):
        cache_point = {"cachePoint": {"type": "default"}}
        messages = [{"role": "user", "content": [{"text": "ask"}, cache_point]}]
        result, dynamic_trailing_blocks = _fold_into_last_user_message(messages, "INJECTED")

        assert result == [{"role": "user", "content": [{"text": "ask"}, cache_point, {"text": "\n\nINJECTED"}]}]

    def test_targets_most_recent_user_message(self):
        messages = [user("first"), assistant("a"), user("second")]
        result, dynamic_trailing_blocks = _fold_into_last_user_message(messages, "INJECTED")

        assert result == [
            {"role": "user", "content": [{"text": "first"}]},
            {"role": "assistant", "content": [{"text": "a"}]},
            {"role": "user", "content": [{"text": "second"}, {"text": "\n\nINJECTED"}]},
        ]

    def test_preserves_message_metadata(self):
        tagged = {"role": "user", "content": [{"text": "ask"}], "metadata": {"custom": {"keep": "me"}}}
        result, dynamic_trailing_blocks = _fold_into_last_user_message([tagged], "INJECTED")
        assert result[0]["metadata"] == {"custom": {"keep": "me"}}

    def test_returns_input_unchanged_when_no_user_message(self):
        messages = [assistant("only assistant")]
        result, dynamic_trailing_blocks = _fold_into_last_user_message(messages, "INJECTED")
        assert result is messages


class TestIsUserTurn:
    def test_true_on_plain_user_ask(self):
        assert _is_user_turn([assistant("prior"), user("ask")]) is True

    def test_false_on_user_tool_result_turn(self):
        assert _is_user_turn([user("task"), assistant("a"), tool_result()]) is False

    def test_false_on_assistant_message(self):
        assert _is_user_turn([user("ask"), assistant("reply")]) is False

    def test_false_on_empty_conversation(self):
        assert _is_user_turn([]) is False


class TestResolveTrigger:
    def test_default_uses_user_turn(self):
        trigger = _resolve_trigger(None)
        assert trigger(injection_ctx([user("ask")])) is True
        assert trigger(injection_ctx([tool_result()])) is False

    def test_user_turn_uses_is_user_turn(self):
        trigger = _resolve_trigger("userTurn")
        assert trigger(injection_ctx([user("ask")])) is True
        assert trigger(injection_ctx([tool_result()])) is False

    def test_every_turn_always_fires(self):
        trigger = _resolve_trigger("everyTurn")
        assert trigger(injection_ctx([])) is True
        assert trigger(injection_ctx([tool_result()])) is True

    def test_custom_predicate_over_context(self):
        trigger = _resolve_trigger(lambda context: len(context.messages) >= 2)
        assert trigger(injection_ctx([user("a")])) is False
        assert trigger(injection_ctx([user("a"), assistant("b")])) is True

    def test_fails_open_when_custom_predicate_raises(self, caplog):
        def boom(context):
            raise ValueError("boom")

        trigger = _resolve_trigger(boom)
        assert trigger(injection_ctx([user("ask")])) is False
        assert "skipping injection" in caplog.text


@pytest.mark.asyncio
class TestCreateInjectionMiddleware:
    async def test_folds_text_into_latest_user_message(self):
        handler = _create_injection_middleware(lambda context: "INJECTED")
        result = await handler(invoke_ctx([assistant("prior"), user("ask")]))

        assert result.messages == [
            {"role": "assistant", "content": [{"text": "prior"}]},
            {"role": "user", "content": [{"text": "ask"}, {"text": "\n\nINJECTED"}]},
        ]

    async def test_passes_conversation_to_render_content(self):
        seen = []

        def render(context):
            seen.extend(message["role"] for message in context.messages)
            return "x"

        handler = _create_injection_middleware(render)
        await handler(invoke_ctx([assistant("prior"), user("ask")]))

        assert seen == ["assistant", "user"]

    async def test_exposes_state_and_agent_on_context(self):
        agent = make_agent(state="stashed")
        received = {}

        def render(context):
            received["state"] = context.state
            received["agent"] = context.agent
            return None

        handler = _create_injection_middleware(render)
        await handler(invoke_ctx([user("ask")], agent=agent))

        assert received == {"state": "stashed", "agent": agent}

    async def test_supports_async_render_content(self):
        async def render(context):
            return "INJECTED"

        handler = _create_injection_middleware(render)
        result = await handler(invoke_ctx([user("ask")]))

        assert result.messages == [{"role": "user", "content": [{"text": "ask"}, {"text": "\n\nINJECTED"}]}]

    async def test_returns_context_unchanged_when_trigger_does_not_fire(self):
        render = MagicMock(return_value="x")
        handler = _create_injection_middleware(render)  # default 'userTurn'
        ctx = invoke_ctx([user("task"), assistant("a"), tool_result()])
        result = await handler(ctx)

        assert result is ctx
        render.assert_not_called()

    async def test_every_turn_injects_on_tool_result_turn_keeping_tool_result_first(self):
        handler = _create_injection_middleware(lambda context: "INJECTED", trigger="everyTurn")
        tr = tool_result()
        result = await handler(invoke_ctx([user("task"), assistant("a"), tr]))

        assert result.messages == [
            {"role": "user", "content": [{"text": "task"}]},
            {"role": "assistant", "content": [{"text": "a"}]},
            {"role": "user", "content": [tr["content"][0], {"text": "INJECTED"}]},
        ]

    async def test_returns_context_unchanged_when_render_yields_empty(self):
        handler = _create_injection_middleware(lambda context: "   ")
        ctx = invoke_ctx([assistant("prior"), user("ask")])
        result = await handler(ctx)

        assert result is ctx

    async def test_fails_open_when_render_content_raises(self, caplog):
        def render(context):
            raise ValueError("boom")

        handler = _create_injection_middleware(render)
        ctx = invoke_ctx([assistant("prior"), user("ask")])
        result = await handler(ctx)

        assert result is ctx
        assert "skipping injection" in caplog.text

    async def test_does_not_mutate_original_context_messages(self):
        handler = _create_injection_middleware(lambda context: "INJECTED")
        ctx = invoke_ctx([assistant("prior"), user("ask")])
        before = ctx.messages[1]
        await handler(ctx)

        assert len(before["content"]) == 1  # original user message untouched


@pytest.mark.asyncio
class TestPerCallTrailingBlocksReporting:
    """The boundary a provider needs is reported on the context, not written into the messages."""

    async def test_reports_one_trailing_block_as_per_call(self):
        handler = _create_injection_middleware(lambda context: "INJECTED")
        result = await handler(invoke_ctx([user("ask")]))

        assert result.dynamic_trailing_blocks == 1

    async def test_accumulates_across_producers_on_one_call(self):
        first = _create_injection_middleware(lambda context: "ONE")
        second = _create_injection_middleware(lambda context: "TWO")

        result = await second(await first(invoke_ctx([user("ask")])))

        assert result.dynamic_trailing_blocks == 2

    async def test_reports_nothing_when_injection_is_skipped(self):
        handler = _create_injection_middleware(lambda context: None)
        result = await handler(invoke_ctx([user("ask")]))

        assert result.dynamic_trailing_blocks == 0

    async def test_reports_nothing_when_the_fold_target_is_not_the_last_message(self):
        handler = _create_injection_middleware(lambda context: "INJECTED", trigger="everyTurn")
        result = await handler(invoke_ctx([user("ask"), assistant("reply")]))

        assert result.dynamic_trailing_blocks == 0

    async def test_emits_no_cache_point_into_the_messages(self):
        # Most providers reject a cachePoint inside a message, so the framework never writes one.
        handler = _create_injection_middleware(lambda context: "INJECTED")
        result = await handler(invoke_ctx([user("ask")]))

        assert not any("cachePoint" in block for message in result.messages for block in message["content"])

    async def test_separates_injected_text_from_the_user_ask(self):
        handler = _create_injection_middleware(lambda context: "INJECTED")
        result = await handler(invoke_ctx([user("ask")]))

        assert result.messages[0]["content"][-1] == {"text": "\n\nINJECTED"}
