"""Request-usage accounting tests for ``DecisionModel.ask``."""

from typing import Any

import pytest

from strands import Agent, tool
from strands.agent.invocation_context import (
    InvocationContext,
    _create_auxiliary_invocation_context,
    _create_invocation_context,
)
from strands.decisions import DecisionInput, DecisionMetadata, DecisionModel, DecisionResult, Question
from strands.types.content import Message
from strands.types.event_loop import Usage
from strands.types.tools import ToolContext
from tests.fixtures.mocked_model_provider import MockedModelProvider

QUESTIONS: dict[str, Question] = {"is_safe": {"question": "Is the command safe to run?", "choices": "boolean"}}
DECISION_USAGE = Usage(inputTokens=3, outputTokens=2, totalTokens=5)


class StubDecisionModel(DecisionModel):
    """Decision model whose ``_ask`` returns or raises a fixed outcome."""

    def __init__(self, outcome: DecisionResult | Exception) -> None:
        self.outcome = outcome
        self.calls = 0

    async def _ask(self, state: DecisionInput, questions: dict[str, Question], **kwargs: Any) -> DecisionResult:
        self.calls += 1
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def _result(*, usage: Usage | None = DECISION_USAGE) -> DecisionResult:
    return DecisionResult(
        answers={"is_safe": True},
        metadata=DecisionMetadata(latency_ms=1),
        usage=usage,
    )


def _usage(input_tokens: int, output_tokens: int) -> Usage:
    return Usage(
        inputTokens=input_tokens,
        outputTokens=output_tokens,
        totalTokens=input_tokens + output_tokens,
    )


def _tool_use_message(name: str) -> Message:
    return {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "tool-1", "name": name, "input": {}}}],
    }


@pytest.mark.asyncio
async def test_adds_reported_usage_to_the_invocation_context():
    decision = StubDecisionModel(_result())
    invocation_context = _create_invocation_context()

    await decision.ask("ls", QUESTIONS, invocation_context=invocation_context)

    assert invocation_context.usage == {"turns_taken": 0, **DECISION_USAGE}


@pytest.mark.asyncio
async def test_adds_reported_usage_through_to_the_parent_request():
    decision = StubDecisionModel(_result())
    parent = _create_invocation_context()
    invocation_context = _create_auxiliary_invocation_context(parent)

    await decision.ask("ls", QUESTIONS, invocation_context=invocation_context)

    assert parent.usage == {"turns_taken": 0, **DECISION_USAGE}


@pytest.mark.asyncio
async def test_runs_and_records_usage_when_the_request_has_reached_its_limit():
    decision = StubDecisionModel(_result())
    invocation_context = _create_invocation_context({"total_tokens": 1})
    invocation_context._record_usage(_usage(1, 1))

    result = await decision.ask("ls", QUESTIONS, invocation_context=invocation_context)

    assert result.answers == {"is_safe": True}
    assert decision.calls == 1
    assert invocation_context.usage == {
        "turns_taken": 0,
        "inputTokens": 4,
        "outputTokens": 3,
        "totalTokens": 7,
    }


@pytest.mark.asyncio
async def test_leaves_the_invocation_context_unchanged_when_no_usage_is_reported():
    decision = StubDecisionModel(_result(usage=None))
    invocation_context = _create_invocation_context()

    await decision.ask("ls", QUESTIONS, invocation_context=invocation_context)

    assert invocation_context.usage == {
        "turns_taken": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
    }


@pytest.mark.asyncio
async def test_leaves_the_invocation_context_unchanged_and_reraises_when_the_decision_fails():
    error = RuntimeError("provider down")
    decision = StubDecisionModel(error)
    invocation_context = _create_invocation_context()

    with pytest.raises(RuntimeError) as raised:
        await decision.ask("ls", QUESTIONS, invocation_context=invocation_context)

    assert raised.value is error
    assert invocation_context.usage == {
        "turns_taken": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
    }


@pytest.mark.asyncio
async def test_rejects_a_context_the_sdk_did_not_create_before_deciding():
    decision = StubDecisionModel(_result())

    with pytest.raises(TypeError, match="must be an InvocationContext"):
        await decision.ask("ls", QUESTIONS, invocation_context=object())  # type: ignore[arg-type]

    assert decision.calls == 0


@pytest.mark.asyncio
async def test_counts_a_tool_decisions_tokens_toward_the_requests_usage_and_limits():
    decision = StubDecisionModel(_result())

    @tool(context=True)
    async def check_command(tool_context: ToolContext) -> str:
        """Ask whether a command is safe."""
        result = await decision.ask("ls", QUESTIONS, invocation_context=tool_context.invocation_context)
        return str(result.answers["is_safe"])

    agent_model = MockedModelProvider([_tool_use_message("check_command")], [_usage(10, 2)])
    agent = Agent(model=agent_model, tools=[check_command], callback_handler=None)

    result = await agent.invoke_async("go", limits={"total_tokens": 15})

    assert result.stop_reason == "limit_total_tokens"
    assert agent_model.index == 1
    assert isinstance(result.invocation_context, InvocationContext)
    assert result.invocation_context.usage == {
        "turns_taken": 1,
        "inputTokens": 13,
        "outputTokens": 4,
        "totalTokens": 17,
    }
