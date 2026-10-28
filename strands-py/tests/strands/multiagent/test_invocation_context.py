"""Tests for request-wide invocation context accounting across Graph and Swarm nodes."""

from collections import Counter
from dataclasses import replace

import pytest

from strands import Agent
from strands.agent.invocation_context import _create_invocation_context
from strands.hooks import (
    AfterInvocationEvent,
    AfterMultiAgentInvocationEvent,
    AfterNodeCallEvent,
    BeforeMultiAgentInvocationEvent,
    BeforeNodeCallEvent,
)
from strands.multiagent.base import Status
from strands.multiagent.graph import GraphBuilder
from strands.multiagent.swarm import Swarm
from strands.types.event_loop import _limit_stop_message
from tests.fixtures.mocked_model_provider import MockedModelProvider


def _usage(input_tokens, output_tokens):
    return {"inputTokens": input_tokens, "outputTokens": output_tokens, "totalTokens": input_tokens + output_tokens}


def _text_agent(name, text, usage):
    return Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": text}]}], [usage]),
        name=name,
        callback_handler=None,
    )


@pytest.mark.asyncio
async def test_graph_folds_every_node_usage_and_turn_into_one_shared_request_total():
    agent_a = _text_agent("a", "A done", _usage(10, 25))
    agent_b = _text_agent("b", "B done", _usage(20, 35))
    shared = []
    agent_b.hooks.add_callback(AfterInvocationEvent, lambda event: shared.append(event.invocation_context))
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_edge("a", "b")
    graph = builder.build()

    result = await graph.invoke_async("hello")

    assert shared[0].usage == {"turns_taken": 2, "inputTokens": 30, "outputTokens": 60, "totalTokens": 90}
    assert result.invocation_context is shared[0]


@pytest.mark.asyncio
async def test_graph_adds_its_usage_to_the_request_when_it_runs_inside_a_nested_call_own_limits():
    builder = GraphBuilder()
    builder.add_node(_text_agent("analyst", "done", _usage(2, 3)), "analyst")
    graph = builder.build()
    request = _create_invocation_context()
    request._record_usage(_usage(100, 100))
    nested = _create_invocation_context({"turns": 5}, request)

    result = await graph.invoke_async("analyze", invocation_context=nested)

    assert result.invocation_context is nested
    assert nested.usage == {"turns_taken": 1, "inputTokens": 2, "outputTokens": 3, "totalTokens": 5}
    assert request.usage == {"turns_taken": 1, "inputTokens": 102, "outputTokens": 103, "totalTokens": 205}


@pytest.mark.asyncio
async def test_graph_fails_a_node_whose_agent_stops_on_the_forwarded_request_limit():
    builder = GraphBuilder()
    builder.add_node(_text_agent("analyst", "never reached", _usage(0, 0)), "analyst")
    graph = builder.build()
    spent_request = _create_invocation_context({"turns": 1})
    spent_request._usage["turns_taken"] = 1

    result = await graph.invoke_async("analyze", invocation_context=spent_request)

    node_result = result.results["analyst"]
    assert node_result.status == Status.FAILED
    assert isinstance(node_result.result, Exception)
    assert str(node_result.result) == _limit_stop_message("analyst", "limit_turns")
    assert result.status == Status.FAILED


def _handoff_agent(name, next_agent, usage):
    """Agent that hands off to ``next_agent`` via the handoff tool, or finishes when it is ``None``."""
    if next_agent is None:
        responses = [{"role": "assistant", "content": [{"text": f"{name} done"}]}]
        usages = [usage]
    else:
        responses = [
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": f"tool-{name}",
                            "name": "handoff_to_agent",
                            "input": {"agent_name": next_agent, "message": f"from {name}"},
                        }
                    }
                ],
            },
            # The Python handoff tool is a regular tool, so the agent takes one more turn after it.
            {"role": "assistant", "content": [{"text": f"{name} handed off"}]},
        ]
        usages = [usage, _usage(0, 0)]
    return Agent(model=MockedModelProvider(responses, usages), name=name, callback_handler=None)


@pytest.mark.asyncio
async def test_swarm_folds_every_node_usage_into_one_shared_request_total():
    agent_a = _handoff_agent("a", "b", _usage(10, 25))
    agent_b = _handoff_agent("b", None, _usage(20, 35))
    shared = []
    agent_b.hooks.add_callback(AfterInvocationEvent, lambda event: shared.append(event.invocation_context))
    swarm = Swarm([agent_a, agent_b])

    result = await swarm.invoke_async("hello")

    assert shared[0].usage == {"turns_taken": 3, "inputTokens": 30, "outputTokens": 60, "totalTokens": 90}
    assert result.invocation_context is shared[0]


@pytest.mark.asyncio
async def test_swarm_fails_a_node_whose_agent_stops_on_the_forwarded_request_limit():
    swarm = Swarm([_text_agent("analyst", "never reached", _usage(0, 0))])
    spent_request = _create_invocation_context({"turns": 1})
    spent_request._usage["turns_taken"] = 1

    result = await swarm.invoke_async("analyze", invocation_context=spent_request)

    node_result = result.results["analyst"]
    assert node_result.status == Status.FAILED
    assert str(node_result.result) == _limit_stop_message("analyst", "limit_turns")
    assert result.status == Status.FAILED


@pytest.mark.asyncio
async def test_swarm_stops_without_handing_off_when_a_node_stops_on_the_request_limit():
    swarm = Swarm([_handoff_agent("a", "b", _usage(10, 25)), _handoff_agent("b", None, _usage(20, 35))])

    result = await swarm.invoke_async("hello", invocation_context=_create_invocation_context({"turns": 1}))

    assert (result.status, result.results["a"].status, "b" in result.results) == (Status.FAILED, Status.FAILED, False)


@pytest.mark.asyncio
async def test_graph_fails_the_middle_node_that_trips_the_request_limit_and_skips_the_rest():
    builder = GraphBuilder()
    builder.add_node(_text_agent("a", "A done", _usage(1, 1)), "a")
    builder.add_node(_text_agent("b", "never reached", _usage(0, 0)), "b")
    builder.add_node(_text_agent("c", "never reached", _usage(0, 0)), "c")
    builder.add_edge("a", "b")
    builder.add_edge("b", "c")
    graph = builder.build()

    result = await graph.invoke_async("go", invocation_context=_create_invocation_context({"turns": 1}))

    assert result.status == Status.FAILED
    assert result.results["a"].status == Status.COMPLETED
    assert result.results["b"].status == Status.FAILED
    assert str(result.results["b"].result) == _limit_stop_message("b", "limit_turns")
    assert "c" not in result.results
    assert result.invocation_context.usage == {"turns_taken": 1, "inputTokens": 1, "outputTokens": 1, "totalTokens": 2}


def _chain_graph(node_ids, condition=None):
    """Graph that runs ``node_ids`` one after another, each edge gated by ``condition`` when given."""
    builder = GraphBuilder()
    for node_id in node_ids:
        builder.add_node(_text_agent(node_id, f"{node_id} done", _usage(1, 1)), node_id)
    for source, target in zip(node_ids, node_ids[1:], strict=False):
        builder.add_edge(source, target, condition)
    return builder.build()


def _node_statuses(result):
    return {node_id: node_result.status for node_id, node_result in result.results.items()}


def _hook_events(orchestrator):
    """Record every multi-agent hook event the orchestrator emits during a run."""
    events = []
    orchestrator.hooks.add_callback(BeforeMultiAgentInvocationEvent, events.append)
    orchestrator.hooks.add_callback(BeforeNodeCallEvent, events.append)
    orchestrator.hooks.add_callback(AfterNodeCallEvent, events.append)
    orchestrator.hooks.add_callback(AfterMultiAgentInvocationEvent, events.append)
    return events


def _interrupt_first_node(event):
    event.interrupt("approval", reason="approve?")


def _interrupt_response(result):
    return [{"interruptResponse": {"interruptId": result.interrupts[0].id, "response": "yes"}}]


@pytest.mark.asyncio
async def test_graph_fails_the_node_that_reaches_the_limits_a_root_graph_starts_with_and_runs_none_after_it():
    result = await _chain_graph(["a", "b", "c"]).invoke_async("go", limits={"turns": 1})

    assert result.status == Status.FAILED
    assert _node_statuses(result) == {"a": Status.COMPLETED, "b": Status.FAILED}
    assert str(result.results["b"].result) == _limit_stop_message("b", "limit_turns")
    assert result.invocation_context.usage == {"turns_taken": 1, "inputTokens": 1, "outputTokens": 1, "totalTokens": 2}


@pytest.mark.asyncio
async def test_graph_fails_a_node_on_an_independent_branch_on_its_first_turn_check_without_calling_its_model():
    builder = GraphBuilder()
    builder.add_node(_text_agent("a", "a done", _usage(1, 1)), "a")
    builder.add_node(_text_agent("b", "b done", _usage(1, 1)), "b")
    graph = builder.build()

    result = await graph.invoke_async("go", limits={"turns": 1})

    # Entry nodes run concurrently, so either may take the single turn; the other fails before its model call.
    statuses = _node_statuses(result)
    assert Counter(statuses.values()) == Counter([Status.COMPLETED, Status.FAILED])
    failed = next(node_id for node_id, status in statuses.items() if status == Status.FAILED)
    assert str(result.results[failed].result) == _limit_stop_message(failed, "limit_turns")
    assert result.invocation_context.usage == {"turns_taken": 1, "inputTokens": 1, "outputTokens": 1, "totalTokens": 2}


@pytest.mark.parametrize(
    ("request_limits", "own_limits"),
    [
        pytest.param({"turns": 5}, {"turns": 1}, id="its own limits are stricter"),
        pytest.param({"turns": 1}, {"turns": 5}, id="the request's limits are stricter"),
    ],
)
@pytest.mark.asyncio
async def test_graph_stops_a_nested_graph_with_its_own_limits(request_limits, own_limits):
    request = _create_invocation_context(request_limits)

    result = await _chain_graph(["a", "b"]).invoke_async("go", invocation_context=request, limits=own_limits)

    assert str(result.results["b"].result) == _limit_stop_message("b", "limit_turns")
    assert result.invocation_context.usage == {"turns_taken": 1, "inputTokens": 1, "outputTokens": 1, "totalTokens": 2}
    assert request.usage == {"turns_taken": 1, "inputTokens": 1, "outputTokens": 1, "totalTokens": 2}
    assert result.invocation_context is not request


@pytest.mark.parametrize(
    ("limits", "message"),
    [
        pytest.param({"turns": 0}, "limits\\['turns'\\] must be a positive int", id="a non-positive limit"),
        pytest.param({"turn": 3}, "are not recognized limits", id="an unrecognized key"),
    ],
)
@pytest.mark.asyncio
async def test_graph_rejects_invalid_limits(limits, message):
    with pytest.raises(TypeError, match=message):
        await _chain_graph(["a", "b"]).invoke_async("go", limits=limits)


@pytest.mark.asyncio
async def test_graph_attaches_the_request_to_every_multi_agent_hook_event():
    graph = _chain_graph(["a", "b"])
    events = _hook_events(graph)

    result = await graph.invoke_async("go", limits={"turns": 5})

    assert {type(event) for event in events} == {
        BeforeMultiAgentInvocationEvent,
        BeforeNodeCallEvent,
        AfterNodeCallEvent,
        AfterMultiAgentInvocationEvent,
    }
    assert [event for event in events if event.invocation_context is not result.invocation_context] == []


@pytest.mark.asyncio
async def test_graph_lets_an_edge_condition_read_the_request_usage_from_the_state():
    usage_seen_by_edge = []

    def condition(state):
        usage_seen_by_edge.append(dict(state.invocation_context.usage))
        return True

    await _chain_graph(["a", "b"], condition).invoke_async("go")

    # The graph evaluates the condition more than once per edge; every evaluation sees the same usage.
    assert usage_seen_by_edge
    assert set(map(frozenset, map(dict.items, usage_seen_by_edge))) == {
        frozenset({"turns_taken": 1, "inputTokens": 1, "outputTokens": 1, "totalTokens": 2}.items())
    }


@pytest.mark.asyncio
async def test_graph_binds_a_resumed_run_to_its_own_request():
    graph = _chain_graph(["a", "b"])
    graph.hooks.add_callback(
        BeforeNodeCallEvent, lambda event: _interrupt_first_node(event) if event.node_id == "a" else None
    )
    interrupted = await graph.invoke_async("go")
    events = _hook_events(graph)

    result = await graph.invoke_async(_interrupt_response(interrupted))

    assert interrupted.status == Status.INTERRUPTED
    assert result.invocation_context is not interrupted.invocation_context
    assert graph.state.invocation_context is result.invocation_context
    assert [event for event in events if event.invocation_context is not result.invocation_context] == []


def test_graph_state_keeps_the_request_out_of_the_persisted_state():
    graph = _chain_graph(["a"])
    graph.state.invocation_context = _create_invocation_context()

    assert "invocation_context" not in graph.serialize_state()
    assert graph.state == replace(graph.state, invocation_context=None)


def _two_node_swarm():
    return Swarm([_handoff_agent("a", "b", _usage(1, 1)), _handoff_agent("b", None, _usage(1, 1))])


@pytest.mark.asyncio
async def test_swarm_fails_the_node_that_reaches_the_limits_a_root_swarm_starts_with():
    result = await _two_node_swarm().invoke_async("hello", limits={"turns": 2})

    assert result.status == Status.FAILED
    assert _node_statuses(result) == {"a": Status.COMPLETED, "b": Status.FAILED}
    assert str(result.results["b"].result) == _limit_stop_message("b", "limit_turns")
    # The Python handoff tool is a regular tool, so "a" takes two turns before "b" is checked.
    assert result.invocation_context.usage == {"turns_taken": 2, "inputTokens": 1, "outputTokens": 1, "totalTokens": 2}


@pytest.mark.parametrize(
    ("request_limits", "own_limits"),
    [
        pytest.param({"turns": 5}, {"turns": 2}, id="its own limits are stricter"),
        pytest.param({"turns": 2}, {"turns": 5}, id="the request's limits are stricter"),
    ],
)
@pytest.mark.asyncio
async def test_swarm_stops_a_nested_swarm_with_its_own_limits(request_limits, own_limits):
    request = _create_invocation_context(request_limits)

    result = await _two_node_swarm().invoke_async("hello", invocation_context=request, limits=own_limits)

    assert str(result.results["b"].result) == _limit_stop_message("b", "limit_turns")
    assert result.invocation_context.usage == {"turns_taken": 2, "inputTokens": 1, "outputTokens": 1, "totalTokens": 2}
    assert request.usage == {"turns_taken": 2, "inputTokens": 1, "outputTokens": 1, "totalTokens": 2}
    assert result.invocation_context is not request


@pytest.mark.parametrize(
    ("limits", "message"),
    [
        pytest.param({"turns": 0}, "limits\\['turns'\\] must be a positive int", id="a non-positive limit"),
        pytest.param({"turn": 3}, "are not recognized limits", id="an unrecognized key"),
    ],
)
@pytest.mark.asyncio
async def test_swarm_rejects_invalid_limits(limits, message):
    with pytest.raises(TypeError, match=message):
        await Swarm([_text_agent("a", "a done", _usage(1, 1))]).invoke_async("hello", limits=limits)


@pytest.mark.asyncio
async def test_swarm_attaches_the_request_to_every_multi_agent_hook_event():
    swarm = _two_node_swarm()
    events = _hook_events(swarm)

    result = await swarm.invoke_async("hello", limits={"turns": 5})

    assert {type(event) for event in events} == {
        BeforeMultiAgentInvocationEvent,
        BeforeNodeCallEvent,
        AfterNodeCallEvent,
        AfterMultiAgentInvocationEvent,
    }
    assert [event for event in events if event.invocation_context is not result.invocation_context] == []


@pytest.mark.asyncio
async def test_swarm_binds_a_resumed_run_to_its_own_request():
    swarm = Swarm([_text_agent("a", "a done", _usage(1, 1))])
    swarm.hooks.add_callback(BeforeNodeCallEvent, _interrupt_first_node)
    interrupted = await swarm.invoke_async("hello")
    events = _hook_events(swarm)

    result = await swarm.invoke_async(_interrupt_response(interrupted))

    assert interrupted.status == Status.INTERRUPTED
    assert result.invocation_context is not interrupted.invocation_context
    assert swarm.state.invocation_context is result.invocation_context
    assert [event for event in events if event.invocation_context is not result.invocation_context] == []


def test_swarm_state_keeps_the_request_out_of_the_persisted_state():
    swarm = Swarm([_text_agent("a", "a done", _usage(1, 1))])
    swarm.state.invocation_context = _create_invocation_context()

    assert "invocation_context" not in swarm.serialize_state()
    assert swarm.state == replace(swarm.state, invocation_context=None)
