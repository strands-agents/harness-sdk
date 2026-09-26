from typing import Annotated

import pytest
from pydantic import BaseModel

from strands import Agent
from strands.experimental.decisions import YesNo, decision_tool
from tests.fixtures.mocked_decision_model import MockedDecisionModel, yes
from tests.fixtures.mocked_model_provider import MockedModelProvider


class CitationCheck(BaseModel):
    supported: Annotated[bool, YesNo("Does `source` support `claim`?")]


class CitationInput(BaseModel):
    claim: str
    source: str


def _tool(decisions):
    return decision_tool(
        decisions, CitationCheck, state_schema=CitationInput, name="check_citation", description="Check a quote."
    )


def test_tool_spec_uses_state_schema():
    spec = _tool(MockedDecisionModel()).tool_spec

    assert spec["name"] == "check_citation"
    assert spec["inputSchema"]["json"]["required"] == ["claim", "source"]


def _calling_agent(tool, tool_input):
    model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "t1", "name": "check_citation", "input": tool_input}}],
            },
            {"role": "assistant", "content": [{"text": "done"}]},
        ]
    )
    return Agent(model=model, tools=[tool], callback_handler=None)


def _tool_result(agent):
    return next(
        block["toolResult"] for message in agent.messages for block in message["content"] if "toolResult" in block
    )


@pytest.mark.asyncio
async def test_llm_calls_tool_and_sees_probabilities():
    decisions = MockedDecisionModel({"supported": yes(0.2)})
    agent = _calling_agent(_tool(decisions), {"claim": "X is 5", "source": "X is 7"})

    agent("check it")

    tru_result = _tool_result(agent)
    assert tru_result["status"] == "success"
    assert tru_result["content"][0]["json"] == {
        "output": {"supported": False},
        "answers": {"supported": {"probability": 0.2, "confidence": None}},
        "model_id": "mock-s1-1.0",
    }
    assert decisions.requests[0][0] == {"claim": "X is 5", "source": "X is 7"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("scripted", "tool_input", "message"),
    [
        ({}, {"claim": "only claim"}, "could not decide"),
        (RuntimeError("service down"), {"claim": "a", "source": "b"}, "RuntimeError: service down"),
    ],
    ids=["invalid_input", "decision_error"],
)
async def test_errors_become_error_tool_results(scripted, tool_input, message):
    agent = _calling_agent(_tool(MockedDecisionModel(scripted)), tool_input)

    agent("check it")

    tru_result = _tool_result(agent)
    assert tru_result["status"] == "error"
    assert message in tru_result["content"][0]["text"]
