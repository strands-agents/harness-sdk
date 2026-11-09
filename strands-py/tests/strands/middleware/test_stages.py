"""Tests for the public middleware stage contexts."""

import threading

import pytest

import strands.middleware
from strands import Agent
from strands.interrupt import _InterruptState
from strands.middleware import ExecuteToolContext, InvokeModelContext
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture
def agent():
    return Agent(model=MockedModelProvider([]), callback_handler=None)


@pytest.fixture
def invoke_context(agent):
    return InvokeModelContext(
        agent=agent,
        messages=[{"role": "user", "content": [{"text": "hi"}]}],
        system_prompt="original",
        tool_specs=[],
        tool_choice=None,
        invocation_state={},
        model=agent.model,
    )


@pytest.fixture
def tool_context(agent):
    return ExecuteToolContext(
        agent=agent,
        tool=None,
        tool_use={"toolUseId": "t1", "name": "calc", "input": {"x": 1}},
        invocation_state={},
        cancel_signal=threading.Event(),
        _interrupt_state=_InterruptState(),
    )


def test_agent_stream_stage_is_not_exported():
    assert "AgentStreamStage" not in strands.middleware.__all__
    assert "AgentStreamContext" not in strands.middleware.__all__


def test_invoke_model_context_replace_changes_only_named_fields(invoke_context):
    tru_context = invoke_context.replace(system_prompt="new", projected_input_tokens=10)

    exp_context = InvokeModelContext(
        agent=invoke_context.agent,
        messages=invoke_context.messages,
        system_prompt="new",
        tool_specs=invoke_context.tool_specs,
        tool_choice=None,
        invocation_state=invoke_context.invocation_state,
        model=invoke_context.model,
        projected_input_tokens=10,
    )
    assert tru_context == exp_context
    assert tru_context is not invoke_context
    assert tru_context.messages is invoke_context.messages
    assert invoke_context.system_prompt == "original"


def test_invoke_model_context_replace_honors_explicit_none(invoke_context):
    tru_context = invoke_context.replace(system_prompt=None)

    assert tru_context.system_prompt is None


def test_invoke_model_context_replace_without_arguments_copies(invoke_context):
    tru_context = invoke_context.replace()

    assert tru_context == invoke_context
    assert tru_context is not invoke_context


def test_execute_tool_context_replace_changes_tool_use(tool_context):
    tool_use = {"toolUseId": "t1", "name": "calc", "input": {"x": 2}}

    tru_context = tool_context.replace(tool_use=tool_use)

    assert tru_context.tool_use == tool_use
    assert tool_context.tool_use["input"] == {"x": 1}


def test_execute_tool_context_replace_carries_executor_owned_fields(tool_context):
    tru_context = tool_context.replace(tool_use={"toolUseId": "t1", "name": "calc", "input": {}})

    assert tru_context.agent is tool_context.agent
    assert tru_context.cancel_signal is tool_context.cancel_signal
    assert tru_context._interrupt_state is tool_context._interrupt_state
