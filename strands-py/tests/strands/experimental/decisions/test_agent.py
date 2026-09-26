from typing import Annotated, Literal

import pytest
from pydantic import BaseModel

from strands import Agent
from strands.agent.agent_result import AgentResult
from strands.experimental.decisions import (
    Choice,
    DecisionAgent,
    LLMDecisionModel,
    YesNo,
    YesNoAnswer,
    when_below,
    when_choice,
    when_yes,
)
from strands.multiagent import GraphBuilder
from tests.fixtures.mocked_decision_model import MockedDecisionModel, choice, yes
from tests.fixtures.mocked_model_provider import MockedModelProvider


class Triage(BaseModel):
    department: Annotated[Literal["billing", "technical"] | None, Choice("Which team should handle this?")]
    urgent: Annotated[bool, YesNo("Is it urgent?")]


def _agent(text, name):
    return Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": text}]}]),
        name=name,
        callback_handler=None,
    )


def _dispatcher(decisions, **kwargs):
    kwargs.setdefault(
        "routes", {"billing": _agent("billing handled", "billing"), "technical": _agent("tech handled", "tech")}
    )
    return DecisionAgent(decisions, Triage, route_on="department", **kwargs)


@pytest.mark.asyncio
async def test_invoke_without_routes_returns_decision():
    decisions = MockedDecisionModel(
        {"department": choice("billing", {"billing": 0.9, "technical": 0.1, "none": 0.0}, 0.8), "urgent": yes(0.9)}
    )

    tru_result = await DecisionAgent(decisions, Triage).invoke_async("charged twice")

    assert tru_result.structured_output == Triage(department="billing", urgent=True)
    assert tru_result.state["decision"].answers["urgent"].probability == 0.9
    assert tru_result.message["content"][0]["text"] == "department: billing (confidence 0.80); urgent: p=0.90"
    assert decisions.requests[0][0] == "charged twice"


@pytest.mark.asyncio
async def test_invoke_routes_to_agent_and_attaches_decision():
    decisions = MockedDecisionModel({"department": choice("technical", confidence=0.9)})

    tru_result = await _dispatcher(decisions, min_confidence=0.6).invoke_async("site is down")

    assert str(tru_result).strip() == "tech handled"
    assert tru_result.state["decision"].output.department == "technical"


@pytest.mark.asyncio
async def test_invoke_routes_to_callable():
    async def refund(decision, prompt):
        return f"refund queued for {prompt}"

    decisions = MockedDecisionModel({"department": choice("billing")})
    agent = _dispatcher(decisions, routes={"billing": refund, "technical": lambda decision, prompt: "tech"})

    tru_result = await agent.invoke_async("order 42")

    assert str(tru_result).strip() == "refund queued for order 42"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "scripted",
    [
        {"department": choice("billing", {"billing": 0.55, "technical": 0.45, "none": 0.0}, 0.1)},
        {"department": choice("none", {"billing": 0.0, "technical": 0.0, "none": 1.0})},
        RuntimeError("decision service down"),
    ],
    ids=["low_confidence", "no_match", "decision_error"],
)
async def test_invoke_uses_fallback(scripted):
    agent = _dispatcher(
        MockedDecisionModel(scripted), min_confidence=0.6, fallback=_agent("general handled", "general")
    )

    tru_result = await agent.invoke_async("I was charged twice and cannot log in")

    assert str(tru_result).strip() == "general handled"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("scripted", "error", "message"),
    [
        ({"department": choice("billing", confidence=0.1)}, ValueError, "below min_confidence"),
        ({"department": choice("none")}, ValueError, "no option matched"),
        (RuntimeError("down"), RuntimeError, "down"),
    ],
    ids=["low_confidence", "no_match", "decision_error"],
)
async def test_invoke_raises_without_fallback(scripted, error, message):
    with pytest.raises(error, match=message):
        await _dispatcher(MockedDecisionModel(scripted), min_confidence=0.6).invoke_async("x")


def test_call_is_synchronous():
    result = DecisionAgent(MockedDecisionModel({"department": choice("billing")}), Triage)("hello")

    assert isinstance(result, AgentResult)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"route_on": "urgent", "routes": {}}, "must name a Choice field"),
        ({"route_on": "department", "routes": {"billing": lambda d, p: "x"}}, r"missing handlers .*\['technical'\]"),
        ({"route_on": "department", "routes": {"billing": 1, "technical": 1, "sales": 1}}, r"unknown .*\['sales'\]"),
        ({"routes": {"billing": 1}}, "need route_on"),
        ({"min_confidence": 0.5}, "need route_on"),
    ],
)
def test_init_validates_routes(kwargs, message):
    with pytest.raises(ValueError, match=message):
        DecisionAgent(MockedDecisionModel(), Triage, **kwargs)


def test_init_rejects_min_confidence_on_uncalibrated_model():
    llm = LLMDecisionModel(MockedModelProvider([]))

    with pytest.raises(ValueError, match="DecisionAgent\\(min_confidence=0.6\\) needs a calibrated"):
        _dispatcher(llm, min_confidence=0.6)


@pytest.mark.asyncio
async def test_prompt_content_blocks_become_text_state():
    decisions = MockedDecisionModel()

    await DecisionAgent(decisions, Triage).invoke_async([{"text": "line one"}, {"image": {}}, {"text": "line two"}])

    assert decisions.requests[0][0] == "line one\nline two"


@pytest.mark.asyncio
async def test_graph_routes_on_decision_node():
    router = DecisionAgent(
        MockedDecisionModel(
            {"department": choice("billing", {"billing": 0.9, "technical": 0.1, "none": 0.0}, 0.9), "urgent": yes(0.8)}
        ),
        Triage,
        name="router",
    )
    builder = GraphBuilder()
    builder.add_node(router, "router")
    builder.add_node(_agent("billing handled", "billing"), "billing")
    builder.add_node(_agent("tech handled", "tech"), "technical")
    builder.add_node(_agent("escalated", "human"), "human")
    builder.add_node(_agent("paged", "pager"), "pager")
    builder.add_edge("router", "billing", condition=when_choice("router", "department", "billing", min_confidence=0.5))
    builder.add_edge("router", "technical", condition=when_choice("router", "department", "technical"))
    builder.add_edge("router", "human", condition=when_below("router", "department", 0.5))
    builder.add_edge("router", "pager", condition=when_yes("router", "urgent", threshold=0.7))
    builder.set_entry_point("router")

    tru_result = await builder.build().invoke_async("charged twice, urgent")

    assert set(tru_result.results) == {"router", "billing", "pager"}


def test_edge_helpers_handle_missing_decision():
    class _State:
        results = {}

    assert when_choice("router", "department", "billing")(_State(), invocation_state={}) is False
    assert when_yes("router", "urgent")(_State(), invocation_state={}) is False
    assert when_below("router", "department", 0.5)(_State(), invocation_state={}) is True


@pytest.mark.asyncio
async def test_edge_helpers_send_low_confidence_to_when_below():
    router = DecisionAgent(
        MockedDecisionModel({"department": choice("billing", {"billing": 0.4, "technical": 0.35, "none": 0.25}, 0.3)}),
        Triage,
    )
    result = await router.invoke_async("charged twice or a bug?")

    class _State:
        results = {"router": type("NodeResult", (), {"result": result})()}

    assert when_choice("router", "department", "billing", min_confidence=0.5)(_State(), invocation_state={}) is False
    assert when_choice("router", "department", "billing")(_State(), invocation_state={}) is True
    assert when_below("router", "department", 0.5)(_State(), invocation_state={}) is True
    assert when_below("router", "department", 0.2)(_State(), invocation_state={}) is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        (YesNoAnswer(probability=0.55, confidence=0.1), True),
        (YesNoAnswer(probability=0.95, confidence=0.9), False),
        (YesNoAnswer(probability=0.95), True),  # uncalibrated: confidence unknown reads as unsure
    ],
)
async def test_when_below_reads_yes_no_confidence(answer, expected):
    router = DecisionAgent(
        MockedDecisionModel(
            {"department": choice("billing", {"billing": 1.0, "technical": 0.0, "none": 0.0}, 1.0), "urgent": answer}
        ),
        Triage,
    )
    result = await router.invoke_async("charged twice")

    class _State:
        results = {"router": type("NodeResult", (), {"result": result})()}

    assert when_below("router", "urgent", 0.5)(_State(), invocation_state={}) is expected
