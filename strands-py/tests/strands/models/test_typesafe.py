import asyncio
import json
from typing import Annotated, Literal

import httpx2
import pytest
import typesafe_sdk
from pydantic import BaseModel

from strands.experimental.decisions import (
    Choice,
    ChoiceAnswer,
    DecisionResponse,
    Score,
    ScoreAnswer,
    YesNo,
    YesNoAnswer,
)
from strands.models import TypeSafeDecisionModel
from strands.models.typesafe import KEV_MAX_STATE_PLUS_QUESTION_TOKENS
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException


def _response(answers, model="jev-1.13.0", usage=None):
    body = {"model": model, "usage": usage or {"input_tokens": 300, "output_tokens": 20}, "answers": answers}
    return typesafe_sdk.SystemOneResponse.model_validate_json(json.dumps(body))


class _FakeClient:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    async def system_one(self, state, questions, *, model=None, **kwargs):
        self.calls.append({"state": state, "questions": questions, "model": model})
        if self.error:
            raise self.error
        return self.response


QUESTIONS = {
    "dept": Choice("Which team?", options={"billing": "Payments", "technical": None}),
    "urgent": YesNo("Urgent?", true="Time pressure", false="Can wait"),
    "anger": Score("How angry?", levels=["calm", "upset", "furious"]),
}
ANSWERS = {
    "dept": {
        "type": "choice",
        "choice": "billing",
        "probabilities": {"billing": 0.9, "technical": 0.1},
        "confidence": 0.8,
    },
    "urgent": {"type": "noul", "noul": 0.95},
    "anger": {
        "type": "score",
        "score": 1.1,
        "legend": {"0": "calm", "1": "upset", "2": "furious"},
        "probabilities": {"0": 0.1, "1": 0.7, "2": 0.2},
        "confidence": 0.5,
    },
}


@pytest.mark.asyncio
async def test_ask_maps_questions_and_answers():
    client = _FakeClient(_response(ANSWERS))
    model = TypeSafeDecisionModel(client=client)

    tru_response = await model.ask({"ticket": "charged twice"}, QUESTIONS)

    exp_response = DecisionResponse(
        answers={
            "dept": ChoiceAnswer(choice="billing", probabilities={"billing": 0.9, "technical": 0.1}, confidence=0.8),
            "urgent": YesNoAnswer(probability=0.95, confidence=pytest.approx(0.9)),
            "anger": ScoreAnswer(score=1.1, probabilities={0: 0.1, 1: 0.7, 2: 0.2}, confidence=0.5),
        },
        model_id="jev-1.13.0",
        usage={"inputTokens": 300, "outputTokens": 20, "totalTokens": 320},
    )
    assert tru_response == exp_response

    call = client.calls[0]
    assert call["model"] == "jev-latest"
    assert call["state"] == {"ticket": "charged twice"}
    assert call["questions"]["dept"] == typesafe_sdk.Choice(
        instructions="Which team?", criteria={"billing": "Payments", "technical": None}
    )
    assert call["questions"]["urgent"] == typesafe_sdk.Noul(
        instructions="Urgent?", criteria={"true": "Time pressure", "false": "Can wait"}
    )
    assert call["questions"]["anger"] == typesafe_sdk.Score(
        instructions="How angry?", criteria=["calm", "upset", "furious"]
    )


@pytest.mark.asyncio
async def test_decide_end_to_end_with_versioned_model_id():
    class Triage(BaseModel):
        dept: Annotated[Literal["billing", "technical"], Choice("Which team?")]
        urgent: Annotated[bool, YesNo("Urgent?")]

    model = TypeSafeDecisionModel(
        client=_FakeClient(_response({k: ANSWERS[k] for k in ("dept", "urgent")})), model_id="jev-1.13.0"
    )

    tru_decision = await model.decide(Triage, state="charged twice")

    assert tru_decision.output == Triage(dept="billing", urgent=True)
    assert tru_decision.model_id == "jev-1.13.0"


@pytest.mark.asyncio
async def test_yesno_without_criteria_sends_none():
    client = _FakeClient(_response({"q": {"type": "noul", "noul": 0.1}}))

    await TypeSafeDecisionModel(client=client).ask("s", {"q": YesNo("?")})

    assert client.calls[0]["questions"]["q"] == typesafe_sdk.Noul(instructions="?", criteria=None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "expected", "message"),
    [
        (typesafe_sdk.TypeSafeRateLimitError(429, {}, httpx2.Headers()), ModelThrottledException, "429"),
        (typesafe_sdk.TypeSafeAPIError(529, {}, httpx2.Headers()), ModelThrottledException, "529"),
        (typesafe_sdk.TypeSafeUnprocessableEntityError(422, {}, httpx2.Headers()), ValueError, "rejected"),
        (typesafe_sdk.TypeSafeBadRequestError(400, {}, httpx2.Headers()), ValueError, "rejected"),
        (
            typesafe_sdk.TypeSafeAuthenticationError(401, {}, httpx2.Headers()),
            typesafe_sdk.TypeSafeAuthenticationError,
            "401",
        ),
    ],
)
async def test_ask_maps_vendor_errors(error, expected, message):
    model = TypeSafeDecisionModel(client=_FakeClient(error=error))

    with pytest.raises(expected, match=message):
        await model.ask("s", {"q": YesNo("?")})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("state", "questions", "message"),
    [
        ("x" * 130_000, {"q": YesNo("?")}, "longest question"),
        ("x" * 40_000, {f"q{n}": YesNo("y" * 60_000) for n in range(4)}, "per request"),
    ],
    ids=["state_plus_longest", "total_request"],
)
async def test_ask_rejects_over_budget_before_sending(state, questions, message):
    client = _FakeClient(_response({}))

    with pytest.raises(ContextWindowOverflowException, match=message):
        await TypeSafeDecisionModel(client=client).ask(state, questions)

    assert client.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("question", "message"),
    [
        (Choice("q", options={str(n): None for n in range(256)}), "at most 255 Choice options"),
        (Score("q", levels=[str(n) for n in range(11)]), "at most 10 Score levels"),
    ],
)
async def test_ask_enforces_typesafe_limits_before_sending(question, message):
    client = _FakeClient(_response({}))

    with pytest.raises(ValueError, match=message):
        await TypeSafeDecisionModel(client=client).ask("s", {"q": question})

    assert client.calls == []


def test_init_requires_api_key(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)

    with pytest.raises(ValueError, match="TYPESAFE_API_KEY"):
        TypeSafeDecisionModel()


def test_ask_uses_a_fresh_client_per_event_loop(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-key")
    created = []

    class _Client(_FakeClient):
        def __init__(self, **kwargs):
            super().__init__(_response({"q": {"type": "noul", "noul": 0.7}}))
            created.append(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

    monkeypatch.setattr(typesafe_sdk, "AsyncTypeSafeClient", _Client)
    model = TypeSafeDecisionModel(client_args={"timeout": 5})

    for _ in range(2):  # separate asyncio.run loops, as Agent.__call__ does
        asyncio.run(model.ask("s", {"q": YesNo("?")}))

    assert created == [{"api_key": "test-key", "base_url": "https://api.typesafe.ai", "timeout": 5}] * 2


def _kev_transport(seen):
    def handler(request):
        seen.append(request)
        body = json.loads(request.content)
        answers = {question_id: {"type": "noul", "noul": 0.8} for question_id in body["questions"]}
        payload = {"model": body["model"], "answers": answers, "usage": {"input_tokens": 40, "output_tokens": 2}}
        return httpx2.Response(200, json=payload)

    return httpx2.MockTransport(handler)


@pytest.mark.asyncio
async def test_self_hosted_kev_over_http_without_sending_the_typesafe_key(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "secret-typesafe-key")
    seen = []
    model = TypeSafeDecisionModel(
        base_url="http://127.0.0.1:8009/",
        model_id="kev-latest",
        client_args={"transport": _kev_transport(seen)},
    )

    tru_response = await model.ask("charged twice", {"q": YesNo("Billing?")})

    assert tru_response.answers == {"q": YesNoAnswer(probability=0.8, confidence=pytest.approx(0.6))}
    assert tru_response.model_id == "kev-latest"
    assert str(seen[0].url) == "http://127.0.0.1:8009/v1/systemone"
    assert seen[0].headers["authorization"] == "Bearer local"
    assert json.loads(seen[0].content)["model"] == "kev-latest"


@pytest.mark.asyncio
async def test_base_url_from_env_and_explicit_key_is_sent(monkeypatch):
    monkeypatch.setenv("TYPESAFE_BASE_URL", "https://kev.example.test")
    seen = []
    model = TypeSafeDecisionModel(api_key="kev-bearer", client_args={"transport": _kev_transport(seen)})

    await model.ask("s", {"q": YesNo("?")})

    assert model.base_url == "https://kev.example.test"
    assert str(seen[0].url) == "https://kev.example.test/v1/systemone"
    assert seen[0].headers["authorization"] == "Bearer kev-bearer"


@pytest.mark.asyncio
async def test_kev_budgets_are_configurable():
    client = _FakeClient(_response({f"q{n}": {"type": "noul", "noul": 0.5} for n in range(4)}))
    kev = TypeSafeDecisionModel(
        client=client, max_state_plus_question_tokens=KEV_MAX_STATE_PLUS_QUESTION_TOKENS, max_request_tokens=None
    )

    with pytest.raises(ContextWindowOverflowException, match="allows 8192"):
        await kev.ask("x" * 36_000, {"q": YesNo("?")})  # ~9k tokens: fine for Jev, over Kev's row
    await kev.ask("x" * 20_000, {f"q{n}": YesNo("y" * 10_000) for n in range(4)})  # no per-request cap

    assert len(client.calls) == 1


def test_config_calibration_and_unknown_keys():
    model = TypeSafeDecisionModel(client=_FakeClient())

    model.update_config(model_id="jev-1.13.0")

    assert model.get_config() == {
        "model_id": "jev-1.13.0",
        "max_state_plus_question_tokens": 32_000,
        "max_request_tokens": 64_000,
    }
    assert model.model_id == "jev-1.13.0"
    assert model.calibrated is True
    with pytest.warns(UserWarning, match="Invalid configuration parameters"):
        model.update_config(temperature=0.1)  # type: ignore[call-arg]
