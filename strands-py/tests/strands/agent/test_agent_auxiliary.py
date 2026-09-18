"""Tests for ``Agent.invoke_auxiliary`` / ``invoke_auxiliary_async``."""

import threading

import pytest
from opentelemetry import trace as trace_api
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic import BaseModel

from strands import Agent, tool
from strands.hooks import AfterAuxiliaryCallEvent, BeforeAuxiliaryCallEvent, BeforeModelCallEvent
from strands.telemetry.metrics import MAIN_USAGE_SOURCE
from strands.types.event_loop import Usage
from tests.fixtures.mocked_model_provider import MockedModelProvider

HOST_USAGE = Usage(inputTokens=10, outputTokens=1, totalTokens=11)
AUX_USAGE = Usage(inputTokens=100, outputTokens=10, totalTokens=110)


def _text(text: str) -> dict:
    return {"role": "assistant", "content": [{"text": text}]}


def _host(*responses: dict) -> Agent:
    model = MockedModelProvider(list(responses), usages=[HOST_USAGE] * len(responses))
    return Agent(name="host", model=model, callback_handler=None)


def _auxiliary(*responses: dict, name: str = "aux") -> Agent:
    model = MockedModelProvider(list(responses), usages=[AUX_USAGE] * len(responses))
    return Agent(name=name, model=model, callback_handler=None)


@pytest.fixture
def recorded_events():
    return []


@pytest.fixture
def recording_host(recorded_events):
    host = _host(_text("done"))
    host.hooks.add_callback(BeforeAuxiliaryCallEvent, lambda event: recorded_events.append(event))
    host.hooks.add_callback(AfterAuxiliaryCallEvent, lambda event: recorded_events.append(event))
    return host


@pytest.mark.asyncio
async def test_invoke_auxiliary_async_returns_result_and_fires_hook_pair(recording_host, recorded_events):
    auxiliary = _auxiliary(_text("summary"))

    result = await recording_host.invoke_auxiliary_async(auxiliary, "summarize", source="summarization")

    assert str(result).strip() == "summary"
    before, after = recorded_events
    assert isinstance(before, BeforeAuxiliaryCallEvent)
    assert (before.agent, before.source, before.auxiliary_agent, before.prompt) == (
        recording_host,
        "summarization",
        auxiliary,
        "summarize",
    )
    assert isinstance(after, AfterAuxiliaryCallEvent)
    assert (after.agent, after.source, after.auxiliary_agent, after.result, after.exception) == (
        recording_host,
        "summarization",
        auxiliary,
        result,
        None,
    )


@pytest.mark.asyncio
async def test_before_event_fires_before_the_auxiliary_model_call(recording_host):
    order = []
    auxiliary = _auxiliary(_text("summary"))
    recording_host.hooks.add_callback(BeforeAuxiliaryCallEvent, lambda _event: order.append("before"))
    auxiliary.hooks.add_callback(BeforeModelCallEvent, lambda _event: order.append("model"))

    await recording_host.invoke_auxiliary_async(auxiliary, "summarize", source="summarization")

    assert order == ["before", "model"]


@pytest.mark.asyncio
async def test_auxiliary_model_calls_do_not_fire_host_model_call_hooks(recording_host):
    host_model_calls = []
    recording_host.hooks.add_callback(BeforeModelCallEvent, lambda event: host_model_calls.append(event))

    await recording_host.invoke_auxiliary_async(_auxiliary(_text("summary")), "summarize", source="summarization")

    assert host_model_calls == []


@pytest.mark.asyncio
async def test_usage_rolls_up_into_host_metrics_by_source(recording_host):
    await recording_host.invoke_auxiliary_async(_auxiliary(_text("a")), "x", source="summarization")
    await recording_host.invoke_auxiliary_async(_auxiliary(_text("b")), "y", source="web_fetch")

    metrics = recording_host.event_loop_metrics
    assert metrics.accumulated_usage == Usage(inputTokens=200, outputTokens=20, totalTokens=220)
    assert metrics.accumulated_usage_by_source == {"summarization": AUX_USAGE, "web_fetch": AUX_USAGE}


@pytest.mark.asyncio
async def test_reused_auxiliary_agent_only_rolls_up_the_delta(recording_host):
    auxiliary = _auxiliary(_text("a"), _text("b"))

    await recording_host.invoke_auxiliary_async(auxiliary, "x", source="summarization")
    await recording_host.invoke_auxiliary_async(auxiliary, "y", source="summarization")

    assert recording_host.event_loop_metrics.accumulated_usage_by_source["summarization"] == Usage(
        inputTokens=200, outputTokens=20, totalTokens=220
    )


def test_usage_spent_inside_a_tool_lands_in_the_invocation_but_not_the_cycle():
    @tool(context=True)
    async def fetch(tool_context) -> str:  # noqa: ANN001
        result = await tool_context.agent.invoke_auxiliary_async(_auxiliary(_text("page")), "read", source="web_fetch")
        return str(result)

    tool_use = {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "fetch", "input": {}}}]}
    model = MockedModelProvider([tool_use, _text("done")], usages=[HOST_USAGE, HOST_USAGE])
    host = Agent(name="host", model=model, tools=[fetch], callback_handler=None)

    result = host("go")

    invocation = result.metrics.latest_agent_invocation
    assert result.metrics.accumulated_usage == Usage(inputTokens=120, outputTokens=12, totalTokens=132)
    assert result.metrics.accumulated_usage_by_source == {
        "main": Usage(inputTokens=20, outputTokens=2, totalTokens=22),
        "web_fetch": AUX_USAGE,
    }
    assert invocation.usage == Usage(inputTokens=120, outputTokens=12, totalTokens=132)
    assert [cycle.usage["totalTokens"] for cycle in invocation.cycles] == [11, 11]


@pytest.mark.asyncio
async def test_failure_still_rolls_up_usage_and_reports_the_exception(recording_host, recorded_events):
    auxiliary = _auxiliary(_text("first"))
    auxiliary.hooks.add_callback(BeforeModelCallEvent, lambda _event: None)

    class Boom(Exception):
        pass

    def explode(_event):
        raise Boom("model exploded")

    # Two-step auxiliary: the first model call succeeds, the failure hits on the way out.
    auxiliary.hooks.add_callback(AfterAuxiliaryCallEvent, lambda _event: None)
    auxiliary.hooks.add_callback(BeforeModelCallEvent, explode)

    with pytest.raises(Boom):
        await recording_host.invoke_auxiliary_async(auxiliary, "judge", source="goal_judge")

    after = recorded_events[-1]
    assert isinstance(after, AfterAuxiliaryCallEvent)
    assert isinstance(after.exception, Boom)
    assert after.result is None
    assert (
        recording_host.event_loop_metrics.accumulated_usage_by_source.get(
            "goal_judge", Usage(inputTokens=0, outputTokens=0, totalTokens=0)
        )
        == auxiliary.event_loop_metrics.accumulated_usage
    )


@pytest.mark.asyncio
async def test_host_cancellation_cancels_the_auxiliary_agent(recording_host):
    recording_host.cancel()

    result = await recording_host.invoke_auxiliary_async(_auxiliary(_text("never")), "go", source="steering")

    assert result.stop_reason == "cancelled"


@pytest.mark.asyncio
async def test_explicit_cancel_signal_wins_over_the_host_signal(recording_host):
    explicit = threading.Event()
    explicit.set()

    result = await recording_host.invoke_auxiliary_async(
        _auxiliary(_text("never")), "go", source="steering", cancel_signal=explicit
    )

    assert result.stop_reason == "cancelled"
    assert not recording_host.cancel_signal.is_set()


@pytest.mark.asyncio
async def test_kwargs_are_forwarded_to_the_auxiliary_invocation(recording_host):
    class Decision(BaseModel):
        approve: bool

    structured = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "s1", "name": "Decision", "input": {"approve": True}}}],
    }
    auxiliary = _auxiliary(structured)

    result = await recording_host.invoke_auxiliary_async(
        auxiliary, "classify", source="hitl_classifier", structured_output_model=Decision
    )

    assert result.structured_output == Decision(approve=True)


def test_auxiliary_usage_counts_toward_host_limits():
    @tool(context=True)
    async def fetch(tool_context) -> str:  # noqa: ANN001
        await tool_context.agent.invoke_auxiliary_async(_auxiliary(_text("page")), "read", source="web_fetch")
        return "ok"

    tool_use = {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "fetch", "input": {}}}]}
    model = MockedModelProvider([tool_use, tool_use, _text("done")], usages=[HOST_USAGE] * 3)
    host = Agent(name="host", model=model, tools=[fetch], callback_handler=None)

    # The host alone would spend 22 tokens over two cycles; the auxiliary's 110 trips the cap after the first tool.
    result = host("go", limits={"total_tokens": 100})

    assert result.stop_reason == "limit_total_tokens"
    assert result.metrics.accumulated_usage_by_source["web_fetch"] == AUX_USAGE
    assert model.index == 1


@pytest.mark.asyncio
async def test_rejects_self_and_the_main_source(recording_host, recorded_events):
    with pytest.raises(ValueError, match="own auxiliary"):
        await recording_host.invoke_auxiliary_async(recording_host, "x", source="summarization")
    with pytest.raises(ValueError, match="reserved"):
        await recording_host.invoke_auxiliary_async(_auxiliary(_text("a")), "x", source=MAIN_USAGE_SOURCE)

    assert recorded_events == []


@pytest.mark.asyncio
async def test_failing_after_hook_does_not_mask_the_auxiliary_failure(recording_host):
    def explode_model(_event):
        raise RuntimeError("model exploded")

    def explode_hook(_event):
        raise RuntimeError("hook exploded")

    auxiliary = _auxiliary(_text("never"))
    auxiliary.hooks.add_callback(BeforeModelCallEvent, explode_model)
    recording_host.hooks.add_callback(AfterAuxiliaryCallEvent, explode_hook)

    with pytest.raises(RuntimeError, match="model exploded"):
        await recording_host.invoke_auxiliary_async(auxiliary, "x", source="goal_judge")


@pytest.mark.asyncio
async def test_failing_after_hook_surfaces_when_the_call_succeeded(recording_host):
    def explode_hook(_event):
        raise RuntimeError("hook exploded")

    recording_host.hooks.add_callback(AfterAuxiliaryCallEvent, explode_hook)

    with pytest.raises(RuntimeError, match="hook exploded"):
        await recording_host.invoke_auxiliary_async(_auxiliary(_text("ok")), "x", source="goal_judge")


def test_invoke_auxiliary_sync_wrapper(recording_host, recorded_events):
    result = recording_host.invoke_auxiliary(_auxiliary(_text("summary")), "summarize", source="summarization")

    assert str(result).strip() == "summary"
    assert [type(event) for event in recorded_events] == [BeforeAuxiliaryCallEvent, AfterAuxiliaryCallEvent]


def test_auxiliary_span_nests_the_auxiliary_agent_under_the_host_tool_span():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    previous_provider = trace_api.get_tracer_provider()
    trace_api._TRACER_PROVIDER = None  # allow re-registering within the test process
    trace_api.set_tracer_provider(provider)
    try:

        @tool(context=True)
        async def fetch(tool_context) -> str:  # noqa: ANN001
            auxiliary = _auxiliary(_text("page"), name="analyst")
            return str(await tool_context.agent.invoke_auxiliary_async(auxiliary, "read", source="web_fetch"))

        tool_use = {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "fetch", "input": {}}}]}
        host = Agent(
            name="host", model=MockedModelProvider([tool_use, _text("done")]), tools=[fetch], callback_handler=None
        )
        host("go")
    finally:
        trace_api._TRACER_PROVIDER = None
        trace_api.set_tracer_provider(previous_provider)

    spans = {span.name: span for span in exporter.get_finished_spans()}
    by_id = {span.context.span_id: span for span in spans.values()}
    auxiliary_span = spans["invoke_auxiliary web_fetch"]
    assert auxiliary_span.attributes["strands.source"] == "web_fetch"
    assert auxiliary_span.attributes["gen_ai.agent.name"] == "analyst"
    assert by_id[auxiliary_span.parent.span_id].name == "execute_tool fetch"
    assert by_id[spans["invoke_agent analyst"].parent.span_id] is auxiliary_span
    assert len({span.context.trace_id for span in spans.values()}) == 1
