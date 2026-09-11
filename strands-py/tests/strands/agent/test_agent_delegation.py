"""Tests for AgentDelegation plugin — verifies delegation semantics with agent-as-tool."""

import json as json_module
from datetime import datetime
from unittest.mock import MagicMock, PropertyMock

import pytest
from pydantic import BaseModel

from strands._middleware.stages import ExecuteToolContext
from strands.agent._agent_as_tool import DELEGATION_DESCRIPTION_SUFFIX, _AgentAsTool
from strands.agent._agent_delegation import AgentDelegation, _DelegationState, _to_content_blocks
from strands.agent.agent import Agent
from strands.agent.agent_result import AgentResult
from strands.hooks import (
    AfterToolCallEvent,
    AfterToolsEvent,
    BeforeToolsEvent,
    MessageAddedEvent,
)
from strands.interrupt import _InterruptState
from strands.session.repository_session_manager import RepositorySessionManager
from strands.telemetry.metrics import EventLoopMetrics
from strands.tools.structured_output.structured_output_tool import StructuredOutputTool
from strands.types._events import ToolResultEvent
from strands.vended_plugins.context_offloader import ContextOffloader, InMemoryStorage
from tests.fixtures.mock_session_repository import MockedSessionRepository
from tests.fixtures.mocked_model_provider import MockedModelProvider

# --- Helpers ---


def _mock_sub_agent(name="sub"):
    agent = MagicMock()
    agent.name = name
    agent._interrupt_state = _InterruptState()
    return agent


def _make_delegation_tool(name="sub", **kwargs):
    return _AgentAsTool(_mock_sub_agent(name), name=name, delegate=True, preserve_context=True, **kwargs)


def _get_plugin(agent):
    return agent._plugin_registry._plugins["strands:agent-delegation"]


def _fire_after_tool_call(parent, plugin, tool, tool_use_id, status, selected_tool=None):
    return AfterToolCallEvent(
        agent=parent,
        selected_tool=selected_tool or tool,
        tool_use={"toolUseId": tool_use_id, "name": "sub", "input": {}},
        invocation_state={"request_state": {}},
        result={"toolUseId": tool_use_id, "status": status, "content": [{"text": "x"}]},
    )


def _fire_after_tools(parent, plugin, status="success"):
    message = {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": "t1", "status": status, "content": [{"text": "x"}]}}],
    }
    event = AfterToolsEvent(agent=parent, message=message, invocation_state={"request_state": {}})
    plugin._on_after_tools(event)
    return event


# --- Delegation flag ---


def test_as_tool_delegate_defaults_false():
    tru_delegate = Agent(name="sub", callback_handler=None).as_tool().delegate
    assert tru_delegate is False


def test_as_tool_delegate_true_adds_suffix():
    tool = Agent(name="sub", description="Billing", callback_handler=None).as_tool(delegate=True)
    assert tool.delegate is True
    assert tool._description == "Billing" + DELEGATION_DESCRIPTION_SUFFIX


def test_as_tool_custom_description_with_delegate():
    tool = Agent(name="sub", callback_handler=None).as_tool(delegate=True, description="Custom")
    exp_description = "Custom" + DELEGATION_DESCRIPTION_SUFFIX
    assert tool._description == exp_description


# --- Tool does not own stop ---


@pytest.mark.asyncio
@pytest.mark.parametrize("delegate", [True, False])
async def test_tool_stream_never_sets_stop_event_loop(delegate):
    """_AgentAsTool defers all stop decisions to the plugin."""
    mock_agent = _mock_sub_agent()
    result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "ok"}]},
        metrics=EventLoopMetrics(),
        state={},
    )

    async def mock_stream(prompt):
        yield {"result": result}

    mock_agent.stream_async = mock_stream
    tool = _AgentAsTool(mock_agent, name="sub", delegate=delegate, preserve_context=True)

    invocation_state = {"request_state": {}}
    async for _ in tool.stream({"toolUseId": "t1", "name": "sub", "input": {"input": "hi"}}, invocation_state):
        pass

    assert "stop_event_loop" not in invocation_state["request_state"]


@pytest.mark.asyncio
async def test_tool_stream_error_does_not_set_stop():
    mock_agent = _mock_sub_agent()

    async def failing(prompt):
        raise RuntimeError("crash")
        yield  # noqa: RET503

    mock_agent.stream_async = failing
    tool = _AgentAsTool(mock_agent, name="sub", delegate=True, preserve_context=True)

    invocation_state = {"request_state": {}}
    async for _ in tool.stream({"toolUseId": "t1", "name": "sub", "input": {"input": "hi"}}, invocation_state):
        pass

    assert invocation_state["request_state"].get("stop_event_loop") is not True


# --- Single-call constraint (BeforeToolsEvent) ---


@pytest.mark.parametrize(
    "tool_names,expect_cancel",
    [
        (["specialist", "other_tool"], True),
        (["billing", "tech"], True),
        (["specialist"], False),
        (["tool_a", "tool_b"], False),
    ],
    ids=["delegate+other", "two-delegates", "single-delegate", "no-delegates"],
)
def test_on_before_tools_cancel_decision(tool_names, expect_cancel):
    sub = Agent(name="specialist", description="S", callback_handler=None)
    tools = [sub.as_tool(delegate=True)]
    if "tech" in tool_names or "billing" in tool_names:
        sub2 = Agent(name="billing" if "billing" in tool_names else "tech", callback_handler=None)
        tools.append(sub2.as_tool(delegate=True))

    parent = Agent(name="parent", tools=tools, callback_handler=None)
    message = {
        "role": "assistant",
        "content": [
            {"toolUse": {"toolUseId": f"t{i}", "name": name, "input": {}}} for i, name in enumerate(tool_names)
        ],
    }

    plugin = AgentDelegation()
    event = BeforeToolsEvent(agent=parent, message=message, invocation_state={})
    plugin._on_before_tools(event)

    assert bool(event.cancel) == expect_cancel


# --- AfterToolCallEvent state tracking ---


def test_on_after_tool_call_marks_on_success():
    tool = _make_delegation_tool()
    parent = Agent(name="p", tools=[tool], callback_handler=None)
    plugin = _get_plugin(parent)
    plugin._state[parent] = _DelegationState(tool_use_count=1)

    event = _fire_after_tool_call(parent, plugin, tool, "t1", "success")
    plugin._on_after_tool_call(event)
    assert plugin._state[parent].tool_use_id == "t1"


def test_on_after_tool_call_clears_on_error():
    tool = _make_delegation_tool()
    parent = Agent(name="p", tools=[tool], callback_handler=None)
    plugin = _get_plugin(parent)
    plugin._state[parent] = _DelegationState(tool_use_id="t1", tool_use_count=1)

    event = _fire_after_tool_call(parent, plugin, tool, "t1", "error")
    plugin._on_after_tool_call(event)
    assert plugin._state[parent].tool_use_id is None


def test_on_after_tool_call_retry_swap_clears_matching_id():
    tool = _make_delegation_tool()
    parent = Agent(name="p", tools=[tool], callback_handler=None)
    plugin = _get_plugin(parent)
    plugin._state[parent] = _DelegationState(tool_use_id="t1", tool_use_count=1)

    ordinary = MagicMock()
    ordinary.delegate = False
    event = _fire_after_tool_call(parent, plugin, tool, "t1", "success", selected_tool=ordinary)
    plugin._on_after_tool_call(event)
    assert plugin._state[parent].tool_use_id is None


def test_on_after_tool_call_retry_swap_preserves_different_id():
    tool = _make_delegation_tool()
    parent = Agent(name="p", tools=[tool], callback_handler=None)
    plugin = _get_plugin(parent)
    plugin._state[parent] = _DelegationState(tool_use_id="t1", tool_use_count=1)

    ordinary = MagicMock()
    ordinary.delegate = False
    event = _fire_after_tool_call(parent, plugin, tool, "t2", "success", selected_tool=ordinary)
    plugin._on_after_tool_call(event)
    assert plugin._state[parent].tool_use_id == "t1"


# --- AfterToolsEvent end_turn ---


def test_on_after_tools_sets_end_turn_on_success():
    tool = _make_delegation_tool()
    parent = Agent(name="p", tools=[tool], callback_handler=None)
    plugin = _get_plugin(parent)
    plugin._state[parent] = _DelegationState(tool_use_id="t1", tool_use_count=1)

    tru_event = _fire_after_tools(parent, plugin)
    assert isinstance(tru_event.end_turn, list)
    assert tru_event.end_turn == [{"text": "x"}]


def test_on_after_tools_suppressed_with_structured_output():

    class R(BaseModel):
        x: int

    tool = _make_delegation_tool()
    parent = Agent(name="p", tools=[tool], callback_handler=None)
    plugin = _get_plugin(parent)
    plugin._state[parent] = _DelegationState(tool_use_id="t1", tool_use_count=1)
    parent.tool_registry.register_dynamic_tool(StructuredOutputTool(R))

    tru_event = _fire_after_tools(parent, plugin)
    assert not tru_event.end_turn


@pytest.mark.parametrize(
    "content",
    [
        [{"toolResult": {"toolUseId": "t_other", "status": "success", "content": [{"text": "x"}]}}],
        [],
    ],
    ids=["mismatched-id", "empty-content"],
)
def test_on_after_tools_skips_when_result_absent(content):
    """When the message has no toolResult matching state.tool_use_id, end_turn is not set."""
    tool = _make_delegation_tool()
    parent = Agent(name="p", tools=[tool], callback_handler=None)
    plugin = _get_plugin(parent)
    plugin._state[parent] = _DelegationState(tool_use_id="t1", tool_use_count=1)

    message = {"role": "user", "content": content}
    event = AfterToolsEvent(agent=parent, message=message, invocation_state={"request_state": {}})
    plugin._on_after_tools(event)

    assert not event.end_turn
    assert plugin._state[parent].tool_use_id is None


# --- Stateful model rejection ---


def test_init_raises_with_delegation_on_stateful():
    tool = _make_delegation_tool()
    stateful = MagicMock()
    type(stateful).stateful = PropertyMock(return_value=True)

    with pytest.raises(ValueError, match="not supported with stateful models"):
        Agent(name="p", model=stateful, tools=[tool], callback_handler=None)


@pytest.mark.asyncio
async def test_runtime_stateful_delegate_passes_through():
    """A delegation tool on a stateful model silently behaves as a normal tool (TS parity)."""
    tool = _make_delegation_tool()
    parent = Agent(name="p", callback_handler=None)
    plugin = _get_plugin(parent)
    type(parent.model).stateful = PropertyMock(return_value=True)

    try:
        ctx = ExecuteToolContext(
            agent=parent,
            tool=tool,
            tool_use={"toolUseId": "t1", "name": "sub", "input": {"input": "hi"}},
            invocation_state={"request_state": {}},
            cancel_signal=parent.cancel_signal,
            _interrupt_state=parent._interrupt_state,
        )

        async def normal_execution(c):
            yield ToolResultEvent({"toolUseId": "t1", "status": "success", "content": [{"text": "normal result"}]})

        tru_events = [e async for e in plugin._handle_tool_execution(ctx, normal_execution)]
        assert len(tru_events) == 1
        assert tru_events[0].tool_result["status"] == "success"
        assert tru_events[0].tool_result["content"][0]["text"] == "normal result"
    finally:
        del type(parent.model).stateful


# --- Auto-registration ---


def test_auto_registered():
    assert "strands:agent-delegation" in Agent(name="t", callback_handler=None)._plugin_registry._plugins


def test_auto_registration_not_duplicated():
    p = AgentDelegation()
    agent = Agent(name="t", plugins=[p], callback_handler=None)
    assert agent._plugin_registry._plugins.get("strands:agent-delegation") is p


# --- Content conversion ---


def test_to_content_blocks_converts_text_json_and_passthrough():
    tru_blocks = _to_content_blocks(
        {
            "content": [
                {"text": "hi"},
                {"json": {"k": 1}},
                {"image": {"format": "png", "source": {"bytes": b"x"}}},
            ]
        }
    )
    assert tru_blocks[0] == {"text": "hi"}
    assert json_module.loads(tru_blocks[1]["text"]) == {"k": 1}
    assert tru_blocks[2] == {"image": {"format": "png", "source": {"bytes": b"x"}}}


# --- Child structured output serialization ---


@pytest.mark.asyncio
async def test_child_structured_output_datetime_serializes_cleanly():
    class S(BaseModel):
        at: datetime

    mock_agent = _mock_sub_agent("sched")
    result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "done"}]},
        metrics=EventLoopMetrics(),
        state={},
        structured_output=S(at=datetime(2025, 1, 15, 9, 0)),
    )

    async def stream(prompt, cancel_signal=None):
        yield {"result": result}

    mock_agent.stream_async = stream
    tool = _AgentAsTool(mock_agent, name="sched", delegate=True, preserve_context=True)

    tru_events = [e async for e in tool.stream({"toolUseId": "t1", "name": "sched", "input": {"input": "x"}}, {})]
    tru_results = [e for e in tru_events if isinstance(e, ToolResultEvent)]
    assert tru_results[0].tool_result["status"] == "success"
    assert "2025-01-15" in json_module.dumps(tru_results[0].tool_result["content"][0]["json"])


# --- Full delegation flow ---


@pytest.mark.asyncio
async def test_full_delegation_routes_to_specialist():
    sub = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "Balance: $42"}]}]),
        name="billing",
        callback_handler=None,
    )
    orch = Agent(
        model=MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": "c1", "name": "billing", "input": {"input": "check"}}}],
                }
            ]
        ),
        name="orch",
        tools=[sub.as_tool(delegate=True)],
        callback_handler=None,
    )

    tru_result = await orch.invoke_async("Check balance")
    assert tru_result.stop_reason == "end_turn"
    assert any("$42" in str(b.get("text", "")) for b in tru_result.message["content"])

    # The placeholder must not remain stranded in history
    for msg in orch.messages:
        for block in msg.get("content", []):
            if isinstance(block, dict) and "text" in block:
                assert "Turn ended early" not in block["text"]


@pytest.mark.asyncio
async def test_full_delegation_delegate_tool_stays_foreground_with_background_tasks():
    tech_support = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "Try rebooting your router."}]}]),
        name="TechSupport",
        callback_handler=None,
    )
    orchestrator = Agent(
        model=MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "toolUse": {
                                "toolUseId": "call-1",
                                "name": "TechSupport",
                                "input": {"input": "My wifi does not work", "_background_execution": True},
                            }
                        }
                    ],
                }
            ]
        ),
        name="Orchestrator",
        tools=[tech_support.as_tool(delegate=True)],
        background_tasks={},
        callback_handler=None,
    )

    result = await orchestrator.invoke_async("My wifi does not work")

    tru_stop_reason = result.stop_reason
    exp_stop_reason = "end_turn"
    assert tru_stop_reason == exp_stop_reason
    tru_text = [block["text"] for block in result.message["content"] if "text" in block]
    exp_text = ["Try rebooting your router."]
    assert tru_text == exp_text


@pytest.mark.asyncio
async def test_full_delegation_error_recovery():
    err = _mock_sub_agent("failing")

    async def fail(prompt):
        raise RuntimeError("crash")
        yield  # noqa: RET503

    err.stream_async = fail
    tool = _AgentAsTool(err, name="failing", delegate=True, preserve_context=True)

    orch = Agent(
        model=MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": "c1", "name": "failing", "input": {"input": "x"}}}],
                },
                {"role": "assistant", "content": [{"text": "I recovered."}]},
            ]
        ),
        name="orch",
        tools=[tool],
        callback_handler=None,
    )

    tru_result = await orch.invoke_async("Do it")
    assert tru_result.stop_reason == "end_turn"
    assert "recovered" in str(tru_result.message["content"]).lower()


@pytest.mark.asyncio
async def test_full_delegation_blank_content_skips_delegation():
    """When a delegate returns empty content, delegation is skipped and the loop continues to the model."""
    sub = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": []}]),
        name="empty_sub",
        callback_handler=None,
    )
    orch = Agent(
        model=MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": "c1", "name": "empty_sub", "input": {"input": "go"}}}],
                },
                # Delegation skipped — the loop continues and the model produces this response.
                {"role": "assistant", "content": [{"text": "I continued."}]},
            ]
        ),
        name="orch",
        tools=[sub.as_tool(delegate=True)],
        callback_handler=None,
    )

    tru_result = await orch.invoke_async("go")
    assert tru_result.stop_reason == "end_turn"
    assert "I continued." in str(tru_result.message["content"])


@pytest.mark.asyncio
@pytest.mark.parametrize("with_session_manager", [False, True])
async def test_delegation_emits_correct_history_and_single_assistant_event(with_session_manager):
    """A delegation turn produces a correct history and emits exactly one assistant MessageAddedEvent.

    Subscribers must see the delegated content exactly once, whether or not a session manager is attached (#3808).
    """
    session_manager = (
        RepositorySessionManager(session_id="s1", session_repository=MockedSessionRepository())
        if with_session_manager
        else None
    )

    sub = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "Balance: $42"}]}]),
        name="billing",
        callback_handler=None,
    )
    orch = Agent(
        model=MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": "c1", "name": "billing", "input": {"input": "check"}}}],
                }
            ]
        ),
        name="orch",
        tools=[sub.as_tool(delegate=True)],
        session_manager=session_manager,
        callback_handler=None,
    )

    tru_assistant_messages: list = []
    orch.add_hook(
        lambda event: (
            tru_assistant_messages.append(event.message)
            if event.message["role"] == "assistant" and any("text" in b for b in event.message.get("content", []))
            else None
        ),
        MessageAddedEvent,
    )

    await orch.invoke_async("Check balance")

    exp_content = [{"text": "Balance: $42"}]
    assert len(tru_assistant_messages) == 1
    assert tru_assistant_messages[0]["content"] == exp_content

    # Verify the full orchestrator history shape.
    assert len(orch.messages) == 4
    assert orch.messages[0]["role"] == "user"
    assert orch.messages[1]["role"] == "assistant"
    assert "toolUse" in orch.messages[1]["content"][0]
    assert orch.messages[2]["role"] == "user"
    assert "toolResult" in orch.messages[2]["content"][0]
    assert orch.messages[3]["role"] == "assistant"
    assert orch.messages[3]["content"] == exp_content


# --- Session persistence ---


@pytest.mark.asyncio
async def test_persisted_matches_in_memory_after_delegation():
    repo = MockedSessionRepository()
    session_mgr = RepositorySessionManager(session_id="s1", session_repository=repo)

    sub_model = MockedModelProvider([{"role": "assistant", "content": [{"text": "Balance: $42"}]}])
    sub = Agent(model=sub_model, name="billing", callback_handler=None)

    orch_model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "c1", "name": "billing", "input": {"input": "check"}}}],
            }
        ]
    )
    orch = Agent(
        model=orch_model,
        name="orchestrator",
        tools=[sub.as_tool(delegate=True)],
        session_manager=session_mgr,
        callback_handler=None,
    )

    await orch.invoke_async("Check balance")

    session_mgr_2 = RepositorySessionManager(session_id="s1", session_repository=repo)
    orch_2 = Agent(model=orch_model, name="orchestrator", session_manager=session_mgr_2, callback_handler=None)

    assert len(orch_2.messages) == len(orch.messages)
    for restored, live in zip(orch_2.messages, orch.messages, strict=True):
        assert restored["role"] == live["role"]
        assert restored["content"] == live["content"]

    assert orch_2.messages[-1]["role"] == "assistant"
    assert any("$42" in str(b.get("text", "")) for b in orch_2.messages[-1]["content"])


# --- Context offloader integration ---


@pytest.mark.asyncio
async def test_large_delegation_result_not_offloaded():
    """A delegation result exceeding the offloader threshold stays in context."""
    storage = InMemoryStorage()
    offloader = ContextOffloader(storage=storage, max_result_tokens=25, preview_tokens=10)

    large_answer = "x" * 500
    sub = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": large_answer}]}]),
        name="billing",
        callback_handler=None,
    )

    orch = Agent(
        model=MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": "c1", "name": "billing", "input": {"input": "check"}}}],
                }
            ]
        ),
        name="orch",
        tools=[sub.as_tool(delegate=True)],
        plugins=[offloader],
        callback_handler=None,
    )

    tru_result = await orch.invoke_async("Check balance")
    assert tru_result.stop_reason == "end_turn"
    tru_text = "".join(block.get("text", "") for block in tru_result.message["content"] if isinstance(block, dict))
    assert large_answer in tru_text
    assert len(storage._store) == 0


# --- AfterToolsEvent ordering guard ---


@pytest.mark.asyncio
async def test_ordering_guard_late_hook_flipping_result_prevents_end_turn():
    """A default-order AfterToolsEvent hook that flips the result to error prevents delegation end_turn.

    Order priority always wins: DEFAULT (0) runs before SDK_LAST (100). Reverse ordering only flips
    registration order *within* one order tier, so delegation's SDK_LAST hook runs last and reads the
    already-mutated committed message. Its own check in _on_after_tools is what declines to set
    end_turn here.
    """
    sub = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "answer"}]}]),
        name="specialist",
        callback_handler=None,
    )

    orch = Agent(
        model=MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": "c1", "name": "specialist", "input": {"input": "go"}}}],
                },
                {"role": "assistant", "content": [{"text": "I continued after flip."}]},
            ]
        ),
        name="orch",
        tools=[sub.as_tool(delegate=True)],
        callback_handler=None,
    )

    def flip_result_to_error(event: AfterToolsEvent):
        content = event.message.get("content", [])
        for block in content:
            if isinstance(block, dict) and "toolResult" in block:
                block["toolResult"]["status"] = "error"

    orch.add_hook(flip_result_to_error, AfterToolsEvent)

    tru_result = await orch.invoke_async("Do it")
    assert tru_result.stop_reason == "end_turn"
    assert "continued" in str(tru_result.message["content"]).lower()


# --- Middleware single-call guard ---


@pytest.mark.asyncio
async def test_middleware_rejects_delegation_when_batch_count_exceeds_one():
    tool = _make_delegation_tool()
    parent = Agent(name="p", tools=[tool], callback_handler=None)
    plugin = _get_plugin(parent)
    plugin._state[parent] = _DelegationState(tool_use_count=2)

    ctx = ExecuteToolContext(
        agent=parent,
        tool=tool,
        tool_use={"toolUseId": "t1", "name": "sub", "input": {"input": "hi"}},
        invocation_state={"request_state": {}},
        cancel_signal=parent.cancel_signal,
        _interrupt_state=parent._interrupt_state,
    )

    async def unreachable(c):
        yield ToolResultEvent({"toolUseId": "t1", "status": "success", "content": [{"text": "nope"}]})

    tru_events = [e async for e in plugin._handle_tool_execution(ctx, unreachable)]
    assert len(tru_events) == 1
    assert tru_events[0].tool_result["status"] == "error"
    assert "only tool" in tru_events[0].tool_result["content"][0]["text"].lower()


# --- Byte-verbatim fidelity ---


@pytest.mark.asyncio
async def test_delegation_preserves_content_verbatim_across_hops():
    """Delegated content must be byte-identical across a multi-level chain."""
    exact_payload = '{"name": "User", "roles": ["admin"]}'

    leaf = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": exact_payload}]}]),
        name="leaf",
        callback_handler=None,
    )
    mid = Agent(
        model=MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": "m1", "name": "leaf", "input": {"input": "go"}}}],
                }
            ]
        ),
        name="mid",
        tools=[leaf.as_tool(delegate=True)],
        callback_handler=None,
    )
    top = Agent(
        model=MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": "t1", "name": "mid", "input": {"input": "go"}}}],
                }
            ]
        ),
        name="top",
        tools=[mid.as_tool(delegate=True)],
        callback_handler=None,
    )

    tru_result = await top.invoke_async("run")

    assert len(tru_result.message["content"]) == 1
    delivered_text = tru_result.message["content"][0]["text"]
    assert delivered_text == exact_payload, f"Expected verbatim {exact_payload!r}, got {delivered_text!r}"


@pytest.mark.asyncio
async def test_delegation_preserves_json_block_verbatim():
    """A child returning a json content block has it copied verbatim into the tool result."""

    json_payload = {"status": "ok", "count": 3}

    # Unit-test the delegation branch directly: simulate a sub-agent result with a json block.
    sub = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "unused"}]}]),
        name="leaf",
        callback_handler=None,
    )
    tool = sub.as_tool(delegate=True)

    fake_result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"json": json_payload}]},
        metrics=EventLoopMetrics(),
        state={},
    )

    async def fake_stream(prompt, cancel_signal=None):
        yield {"result": fake_result}

    tool._agent.stream_async = fake_stream

    tool_use = {"toolUseId": "t1", "name": "leaf", "input": {"input": "go"}}
    events = [e async for e in tool.stream(tool_use, {})]
    result_events = [e for e in events if isinstance(e, ToolResultEvent)]

    assert len(result_events) == 1
    content = result_events[0]["tool_result"]["content"]
    assert len(content) == 1
    assert content[0]["json"] == json_payload


@pytest.mark.asyncio
async def test_delegation_preserves_citations_alongside_text():
    """Mixed text + citationsContent: both must appear in the tool result without trailing newlines."""
    plain_text = "Here is the answer."
    cited_text = "cited fact"

    sub = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "unused"}]}]),
        name="leaf",
        callback_handler=None,
    )
    tool = sub.as_tool(delegate=True)

    fake_result = AgentResult(
        stop_reason="end_turn",
        message={
            "role": "assistant",
            "content": [
                {"text": plain_text},
                {"citationsContent": {"content": [{"text": cited_text}]}},
            ],
        },
        metrics=EventLoopMetrics(),
        state={},
    )

    async def fake_stream(prompt, cancel_signal=None):
        yield {"result": fake_result}

    tool._agent.stream_async = fake_stream

    tool_use = {"toolUseId": "t1", "name": "leaf", "input": {"input": "go"}}
    events = [e async for e in tool.stream(tool_use, {})]
    result_events = [e for e in events if isinstance(e, ToolResultEvent)]

    assert len(result_events) == 1
    content = result_events[0]["tool_result"]["content"]
    assert len(content) == 2
    assert content[0]["text"] == plain_text
    assert content[1]["text"] == cited_text


@pytest.mark.asyncio
async def test_full_delegation_json_content_serialized_to_text():
    """JSON content blocks from a delegate are serialized to text in the parent's final assistant message.

    This guards the _to_content_blocks wiring at the _on_after_tools call site — without it a raw
    {"json": ...} block would leak into the assistant message verbatim.
    """
    json_payload = {"status": "ok", "count": 3}

    sub = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "unused"}]}]),
        name="leaf",
        callback_handler=None,
    )
    tool = sub.as_tool(delegate=True)

    fake_result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"json": json_payload}]},
        metrics=EventLoopMetrics(),
        state={},
    )

    async def fake_stream(prompt, cancel_signal=None):
        yield {"result": fake_result}

    tool._agent.stream_async = fake_stream

    orch = Agent(
        model=MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": "c1", "name": "leaf", "input": {"input": "go"}}}],
                }
            ]
        ),
        name="orch",
        tools=[tool],
        callback_handler=None,
    )

    tru_result = await orch.invoke_async("go")

    exp_content = [{"text": json_module.dumps(json_payload)}]
    assert tru_result.message["content"] == exp_content
    assert orch.messages[-1]["content"] == exp_content
