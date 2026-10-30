"""Tests for request-wide limits and usage accounting via ``InvocationContext``."""

import pytest
from pydantic import BaseModel

from strands import Agent, tool
from strands.agent.conversation_manager import NullConversationManager
from strands.agent.invocation_context import (
    InvocationContext,
    _create_auxiliary_invocation_context,
    _create_invocation_context,
)
from strands.hooks import AfterInvocationEvent, BeforeInvocationEvent, BeforeModelCallEvent, MessageAddedEvent
from strands.tools.executors import SequentialToolExecutor
from strands.types.tools import ToolContext
from tests.fixtures.mocked_model_provider import MockedModelProvider


def _usage(input_tokens, output_tokens):
    return {"inputTokens": input_tokens, "outputTokens": output_tokens, "totalTokens": input_tokens + output_tokens}


def _text(text):
    return {"role": "assistant", "content": [{"text": text}]}


def _tool_use(name, tool_use_id, **tool_input):
    return {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": tool_use_id, "name": name, "input": tool_input}}],
    }


@tool
def loop() -> str:
    """Loops."""
    return "again"


@pytest.mark.asyncio
async def test_invoke_async_leaves_parent_limit_intact_when_tool_forwards_invocation_state():
    sub = Agent(model=MockedModelProvider([_text("sub done")], [_usage(1, 1)] * 1), callback_handler=None)
    sub_runs = []

    @tool(context=True)
    async def relay(tool_context: ToolContext) -> str:
        """Runs the sub-agent."""
        result = await sub.invoke_async("go", invocation_state=tool_context.invocation_state)
        assert result.stop_reason == "end_turn"
        sub_runs.append(result)
        return "ok"

    sub.model.agent_responses = [_text("sub done")] * 3
    sub.model.usages = [_usage(1, 1)] * 3
    parent_model = MockedModelProvider(
        [_tool_use("relay", "tu-1"), _tool_use("relay", "tu-2"), _tool_use("relay", "tu-3")], [_usage(1, 1)] * 3
    )
    parent = Agent(model=parent_model, tools=[relay], callback_handler=None)

    result = await parent.invoke_async("start", limits={"turns": 2})

    assert result.stop_reason == "limit_turns"
    assert parent_model.index == 2
    assert len(sub_runs) == 2


@pytest.mark.asyncio
async def test_invoke_async_produces_well_formed_result_when_inherited_limit_exhausted_on_entry():
    agent = Agent(
        model=MockedModelProvider([_text("should not run")], [_usage(1, 1)]),
        messages=[
            {"role": "user", "content": [{"text": "earlier question"}]},
            {"role": "assistant", "content": [{"text": "earlier answer"}]},
        ],
        callback_handler=None,
    )
    inherited = _create_invocation_context({"turns": 1})
    inherited._usage["turns_taken"] = 5

    result = await agent.invoke_async("go", invocation_context=inherited)

    assert result.stop_reason == "limit_turns"
    assert result.message == {"role": "assistant", "content": []}
    assert str(result) == ""
    assert len(agent.messages) == 2


@pytest.mark.asyncio
async def test_invoke_async_rejects_invalid_limits_before_any_invocation_hook_runs():
    agent = Agent(model=MockedModelProvider([_text("done")]), callback_handler=None)
    before_invocation = []
    agent.hooks.add_callback(BeforeInvocationEvent, before_invocation.append)

    with pytest.raises(TypeError):
        await agent.invoke_async("go", limits={"turns": 0})

    assert before_invocation == []


@pytest.mark.asyncio
async def test_invoke_async_reports_whole_request_usage_on_result_while_metrics_cover_this_agent_only():
    inner = Agent(
        model=MockedModelProvider([_text("inner done")], [_usage(5, 7)]),
        name="inner",
        description="inner agent",
        callback_handler=None,
    )
    outer = Agent(
        model=MockedModelProvider(
            [_tool_use("inner", "tu-1", input="hi"), _text("outer done")], [_usage(1, 2), _usage(1, 1)]
        ),
        tools=[inner.as_tool()],
        callback_handler=None,
    )

    result = await outer.invoke_async("go")

    assert result.invocation_context.usage == {
        "turns_taken": 3,
        "inputTokens": 7,
        "outputTokens": 10,
        "totalTokens": 17,
    }
    assert result.metrics.accumulated_usage == {"inputTokens": 2, "outputTokens": 3, "totalTokens": 5}


@pytest.mark.asyncio
async def test_invoke_async_continues_previous_call_limits_and_usage_when_passed_its_invocation_context():
    model = MockedModelProvider(
        [_text("first"), _text("second"), _text("never reached")], [_usage(1, 1), _usage(1, 1), _usage(0, 0)]
    )
    agent = Agent(model=model, callback_handler=None)

    first = await agent.invoke_async("one", limits={"turns": 2})
    second = await agent.invoke_async("two", invocation_context=first.invocation_context)
    third = await agent.invoke_async("three", invocation_context=second.invocation_context)

    assert [first.stop_reason, second.stop_reason, third.stop_reason] == ["end_turn", "end_turn", "limit_turns"]
    assert second.invocation_context is first.invocation_context
    assert third.invocation_context.usage == {"turns_taken": 2, "inputTokens": 2, "outputTokens": 2, "totalTokens": 4}
    assert model.index == 2


@pytest.mark.asyncio
async def test_invoke_async_counts_only_nested_invoke_own_tokens_against_its_own_token_limits():
    agent = Agent(model=MockedModelProvider([_text("done")], [_usage(10, 10)]), callback_handler=None)
    enclosing = _create_invocation_context()
    enclosing._record_usage(_usage(4000, 4000))

    result = await agent.invoke_async("go", invocation_context=enclosing, limits={"total_tokens": 5000})

    assert result.stop_reason == "end_turn"
    assert result.invocation_context.usage == {
        "turns_taken": 1,
        "inputTokens": 10,
        "outputTokens": 10,
        "totalTokens": 20,
    }
    assert enclosing.usage == {"turns_taken": 1, "inputTokens": 4010, "outputTokens": 4010, "totalTokens": 8020}


@pytest.mark.asyncio
async def test_invoke_async_stops_nested_invoke_on_request_limit_even_when_its_own_limit_is_looser():
    model = MockedModelProvider([_tool_use("loop", "tu-1"), _tool_use("loop", "tu-2")])
    agent = Agent(model=model, tools=[loop], callback_handler=None)
    request = _create_invocation_context({"turns": 2})
    request._usage["turns_taken"] = 1

    result = await agent.invoke_async("go", invocation_context=request, limits={"turns": 5})

    assert result.stop_reason == "limit_turns"
    assert model.index == 1
    assert request.usage["turns_taken"] == 2


@pytest.mark.asyncio
async def test_invoke_async_stops_nested_invoke_on_its_own_tighter_limit_and_counts_turns_toward_request():
    model = MockedModelProvider([_tool_use("loop", "tu-1"), _text("never reached")], [_usage(1, 2), _usage(0, 0)])
    agent = Agent(model=model, tools=[loop], callback_handler=None)
    enclosing = _create_invocation_context({"turns": 10})

    result = await agent.invoke_async("go", invocation_context=enclosing, limits={"turns": 1})

    assert result.stop_reason == "limit_turns"
    assert model.index == 1
    assert enclosing.usage == {"turns_taken": 1, "inputTokens": 1, "outputTokens": 2, "totalTokens": 3}


@pytest.mark.asyncio
async def test_invoke_async_counts_nested_invoke_structured_output_failures_toward_request():
    class Answer(BaseModel):
        value: int

    model = MockedModelProvider([_tool_use(Answer.__name__, "tu-1"), _tool_use(Answer.__name__, "tu-2")])
    agent = Agent(model=model, callback_handler=None)
    request = _create_invocation_context({"structured_output_attempts": 1})

    result = await agent.invoke_async(
        "go",
        structured_output_model=Answer,
        invocation_context=request,
        limits={"structured_output_attempts": 5},
    )

    assert result.stop_reason == "limit_structured_output_attempts"
    assert model.index == 1
    assert request._structured_output_failures == 1


@pytest.mark.asyncio
async def test_invoke_async_folds_auxiliary_call_into_request_total_without_limiting_it():
    parent_context = _create_invocation_context({"turns": 1})
    parent_context._record_usage(_usage(1, 2))
    parent_context._usage["turns_taken"] = 5
    aux = Agent(model=MockedModelProvider([_text("aux done")], [_usage(4, 5)]), callback_handler=None)

    result = await aux.invoke_async("go", invocation_context=_create_auxiliary_invocation_context(parent_context))

    assert result.stop_reason == "end_turn"
    assert parent_context.usage == {"turns_taken": 5, "inputTokens": 5, "outputTokens": 7, "totalTokens": 12}


@pytest.mark.asyncio
async def test_invoke_async_joins_request_when_tool_forwards_tool_context_invocation_context():
    sub = Agent(model=MockedModelProvider([_text("sub done")] * 2, [_usage(1, 1)] * 2), callback_handler=None)

    @tool(context=True)
    async def relay(tool_context: ToolContext) -> str:
        """Runs the sub-agent."""
        result = await sub.invoke_async("go", invocation_context=tool_context.invocation_context)
        return result.stop_reason

    parent_model = MockedModelProvider([_tool_use("relay", "tu-1"), _tool_use("relay", "tu-2")])
    parent = Agent(model=parent_model, tools=[relay], callback_handler=None)

    result = await parent.invoke_async("start", limits={"turns": 2})

    assert result.stop_reason == "limit_turns"
    assert parent_model.index == 1


@pytest.mark.asyncio
async def test_invoke_async_attaches_one_request_handle_to_events_and_tool_context():
    probe_contexts = []

    @tool(context=True)
    def probe(tool_context: ToolContext) -> str:
        """Captures its tool context."""
        probe_contexts.append(tool_context)
        return "ok"

    agent = Agent(
        model=MockedModelProvider([_tool_use("probe", "tu-1"), _text("done")]), tools=[probe], callback_handler=None
    )
    model_call_events = []
    message_added_events = []
    agent.hooks.add_callback(BeforeModelCallEvent, model_call_events.append)
    agent.hooks.add_callback(MessageAddedEvent, message_added_events.append)

    result = await agent.invoke_async("go")

    invocation_context = model_call_events[0].invocation_context
    assert isinstance(invocation_context, InvocationContext)
    assert model_call_events[1].invocation_context is invocation_context
    assert probe_contexts[0].invocation_context is invocation_context
    assert [event.invocation_context for event in message_added_events] == [invocation_context] * 4
    assert result.invocation_context is invocation_context


@pytest.mark.asyncio
async def test_invoke_async_rejects_invocation_context_the_sdk_did_not_create():
    agent = Agent(model=MockedModelProvider([_text("done")]), callback_handler=None)

    with pytest.raises(TypeError, match="must be an InvocationContext"):
        await agent.invoke_async("hi", invocation_context=object())


@pytest.mark.asyncio
async def test_invoke_async_starts_fresh_request_state_on_each_root_invoke_of_reused_agent():
    agent = Agent(model=MockedModelProvider([_text("first"), _text("second")]), callback_handler=None)
    model_call_events = []
    agent.hooks.add_callback(BeforeModelCallEvent, model_call_events.append)

    await agent.invoke_async("one")
    await agent.invoke_async("two")

    first, second = (event.invocation_context for event in model_call_events)
    assert second is not None
    assert second is not first
    assert second.usage["turns_taken"] == 1


@pytest.mark.asyncio
async def test_invoke_async_ends_on_limit_stop_even_when_hook_asks_to_resume():
    agent = Agent(model=MockedModelProvider([_tool_use("loop", "tu-1")]), tools=[loop], callback_handler=None)
    passes = []
    model_calls = []
    agent.hooks.add_callback(BeforeInvocationEvent, passes.append)
    agent.hooks.add_callback(BeforeModelCallEvent, model_calls.append)

    def resume(event: AfterInvocationEvent) -> None:
        # Bounded so a regression fails on the pass count instead of looping forever.
        if len(passes) < 5:
            event.resume = "try again"

    agent.hooks.add_callback(AfterInvocationEvent, resume)

    result = await agent.invoke_async("go", limits={"turns": 1})

    assert result.stop_reason == "limit_turns"
    assert len(passes) == 1
    assert len(model_calls) == 1


@pytest.mark.asyncio
async def test_invoke_async_records_nothing_when_model_call_raises():
    class Boom(Exception):
        pass

    class RaisingModel(MockedModelProvider):
        async def stream(self, *args, **kwargs):
            raise Boom()
            yield

    agent = Agent(model=RaisingModel([_text("never")]), callback_handler=None)
    before_invocation = []
    agent.hooks.add_callback(BeforeInvocationEvent, before_invocation.append)

    with pytest.raises(Boom):
        await agent.invoke_async("go", limits={"total_tokens": 100})

    context = before_invocation[0].invocation_context
    assert context.usage == {"turns_taken": 1, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0}


@pytest.mark.asyncio
async def test_hook_event_equality_ignores_invocation_context():
    agent = Agent(model=MockedModelProvider([_text("done")]), callback_handler=None)
    events = []
    agent.hooks.add_callback(BeforeInvocationEvent, events.append)

    await agent.invoke_async("go")

    assert events[0].invocation_context is not None
    assert events[0] == BeforeInvocationEvent(
        agent=agent, invocation_state=events[0].invocation_state, messages=events[0].messages
    )


@pytest.mark.asyncio
async def test_invoke_async_runs_overrides_that_take_no_invocation_context():
    class LegacyConversationManager(NullConversationManager):
        def __init__(self):
            super().__init__()
            self.managed = 0

        def apply_management(self, agent):
            self.managed += 1

    class LegacyToolExecutor(SequentialToolExecutor):
        async def _execute(
            self, agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
        ):
            async for event in super()._execute(
                agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
            ):
                yield event

    conversation_manager = LegacyConversationManager()
    agent = Agent(
        model=MockedModelProvider([_tool_use("loop", "tu-1"), _text("done")]),
        tools=[loop],
        conversation_manager=conversation_manager,
        tool_executor=LegacyToolExecutor(),
        callback_handler=None,
    )

    result = await agent.invoke_async("go", limits={"turns": 5})

    assert (result.stop_reason, result.invocation_context.usage["turns_taken"], conversation_manager.managed) == (
        "end_turn",
        2,
        1,
    )


@pytest.mark.asyncio
async def test_invoke_async_with_invocation_context_and_limits_runs_as_a_child_of_that_request():
    model = MockedModelProvider([_text("first"), _text("second")], [_usage(1, 1), _usage(2, 2)])
    agent = Agent(model=model, callback_handler=None)
    seen = []
    agent.hooks.add_callback(BeforeModelCallEvent, lambda event: seen.append(event.invocation_context))

    first = await agent.invoke_async("one", limits={"turns": 10})
    second = await agent.invoke_async("two", invocation_context=first.invocation_context, limits={"turns": 1})

    assert second.stop_reason == "end_turn"
    assert second.invocation_context is not first.invocation_context
    assert second.invocation_context._limits == {"turns": 1}
    assert seen[1] is second.invocation_context
    assert second.invocation_context.usage == {"turns_taken": 1, "inputTokens": 2, "outputTokens": 2, "totalTokens": 4}
    assert first.invocation_context.usage == {"turns_taken": 2, "inputTokens": 3, "outputTokens": 3, "totalTokens": 6}
