from typing import Annotated, Literal
from unittest import mock

import pytest
from pydantic import BaseModel

from strands.experimental.decisions import Choice, ChoiceAnswer, Decision, DecisionResponse, Score, YesNo
from strands.experimental.decisions._model import DecisionModel
from tests.fixtures.mocked_decision_model import MockedDecisionModel, choice, score, yes


class Triage(BaseModel):
    department: Annotated[Literal["billing", "technical"], Choice("Which team?")]
    urgent: Annotated[bool, YesNo("Urgent?")]


@pytest.mark.asyncio
async def test_decide_asks_all_fields_in_one_request_and_returns_typed_decision():
    model = MockedDecisionModel(
        {"department": choice("billing", {"billing": 0.8, "technical": 0.2}, 0.6), "urgent": yes(0.9)}
    )

    tru_decision = await model.decide(Triage, state={"ticket": "charged twice"})

    exp_decision = Decision(
        output=Triage(department="billing", urgent=True),
        answers={"department": choice("billing", {"billing": 0.8, "technical": 0.2}, 0.6), "urgent": yes(0.9)},
        model_id="mock-s1-1.0",
        usage={"inputTokens": 10, "outputTokens": 2, "totalTokens": 12},
    )
    assert tru_decision == exp_decision
    assert len(model.requests) == 1
    assert set(model.requests[0][1]) == {"department", "urgent"}


@pytest.mark.asyncio
async def test_ask_rejects_empty_questions_and_optionless_choice():
    model = MockedDecisionModel()

    with pytest.raises(ValueError, match="at least one question"):
        await model.ask("s", {})
    with pytest.raises(ValueError, match="have no options"):
        await model.ask("s", {"q": Choice("pick")})


class _BadProvider(MockedDecisionModel):
    def __init__(self, answers):
        super().__init__()
        self._answers = answers

    async def _ask(self, state, questions, **kwargs):
        return DecisionResponse(answers=self._answers)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("answers", "message"),
    [
        ({}, "no answer"),
        ({"q": yes(1.0)}, "expected ChoiceAnswer"),
        ({"q": ChoiceAnswer(choice="zzz", probabilities={"zzz": 1.0})}, "not one of the options"),
    ],
)
async def test_ask_validates_provider_answers(answers, message):
    with pytest.raises(ValueError, match=message):
        await _BadProvider(answers).ask("s", {"q": Choice("pick", options={"a": None})})


@pytest.mark.asyncio
async def test_ask_records_decision_span():
    model = MockedDecisionModel({"q": score(1.2)})
    span = mock.Mock()
    tracer = mock.Mock()
    tracer._start_span.return_value = span

    with mock.patch("strands.experimental.decisions._model.get_tracer", return_value=tracer):
        await model.ask("s", {"q": Score("how much", levels=["a", "b", "c"])})

    start_attributes = tracer._start_span.call_args.kwargs["attributes"]
    assert start_attributes["strands.source"] == "decision"
    assert start_attributes["gen_ai.request.model"] == "mock-s1"
    assert start_attributes["strands.decision.questions"] == ["q:score"]
    tracer._end_span.assert_called_once_with(
        span,
        attributes={
            "gen_ai.usage.input_tokens": 10,
            "gen_ai.usage.output_tokens": 2,
            "gen_ai.response.model": "mock-s1-1.0",
            "strands.decision.answers": ["q=1.200@0.900"],
        },
    )


@pytest.mark.asyncio
async def test_ask_ends_span_with_error_on_provider_failure():
    model = MockedDecisionModel(RuntimeError("boom"))
    tracer = mock.Mock()

    with mock.patch("strands.experimental.decisions._model.get_tracer", return_value=tracer):
        with pytest.raises(RuntimeError, match="boom"):
            await model.ask("s", {"q": YesNo("?")})

    tracer.end_span_with_error.assert_called_once()


def test_decision_model_defaults_to_uncalibrated():
    class Minimal(DecisionModel):
        def get_config(self):
            return {"model_id": "m"}

        def update_config(self, **config):
            pass

        async def _ask(self, state, questions, **kwargs):
            raise NotImplementedError

    assert Minimal().calibrated is False
    assert Minimal().model_id == "m"
