"""Tests for ClassifierStrategy routing through a DecisionModel."""

import asyncio
import json
import logging
import re
import typing
from dataclasses import replace
from typing import Any

import pytest

from strands import Agent
from strands.agent.invocation_context import _create_invocation_context
from strands.decisions import DecisionInput, DecisionMetadata, DecisionModel, DecisionResult, Question, Uncertain
from strands.models import ClassifierStrategy, ModelRouter, RoutingAttempt, RoutingCandidate
from strands.models.routing.classifier_strategy import (
    _DEFAULT_ROUTING_POLICY,
    _QUESTION_ID,
    _REQUEST_BLOCK_PROJECTIONS,
    _ROUTING_RULES,
    _candidate_key,
    _latest_request_text,
    _routing_question,
)
from strands.models.routing.strategy import RoutingContext
from strands.types.content import ContentBlock
from strands.types.event_loop import Usage
from tests.fixtures.mocked_model_provider import MockedModelProvider


class _FakeDecisionModel(DecisionModel):
    """Records each ask and answers the routing question with a scripted value."""

    def __init__(
        self,
        answer: bool | str | Uncertain | Exception,
        *,
        delay: float = 0,
        usage: Usage | None = None,
        ignore_cancel: bool = False,
    ) -> None:
        self.answer = answer
        self.delay = delay
        self.usage = usage
        self.ignore_cancel = ignore_cancel
        self.states: list[DecisionInput] = []
        self.questions: list[dict[str, Question]] = []
        self.cancelled = False

    async def _ask(self, state: DecisionInput, questions: dict[str, Question], **kwargs: Any) -> DecisionResult:
        self.states.append(state)
        self.questions.append(questions)
        if self.delay:
            await self._sleep()
        if isinstance(self.answer, Exception):
            raise self.answer
        return DecisionResult(
            answers={_QUESTION_ID: self.answer}, usage=self.usage, metadata=DecisionMetadata(latency_ms=1)
        )

    async def _sleep(self) -> None:
        try:
            await asyncio.sleep(self.delay)
        except asyncio.CancelledError:
            self.cancelled = True
            if not self.ignore_cancel:
                raise
            await asyncio.sleep(self.delay)


def _response_model(text: str) -> MockedModelProvider:
    return MockedModelProvider([{"role": "assistant", "content": [{"text": text}]}])


def _candidate(name: str) -> RoutingCandidate:
    return RoutingCandidate(_response_model(name), name=name, description=f"Model for {name} requests.")


def _context(router: ModelRouter, *, messages=None, system_prompt: Any = "Be precise", attempts=()) -> RoutingContext:
    return RoutingContext(
        messages=messages or [{"role": "user", "content": [{"text": "Plan a migration"}]}],
        system_prompt=system_prompt,
        tool_specs=[],
        candidates=router.candidates,
        invocation_state={},
        attempts=attempts,
    )


def _sent_question(decision_model: _FakeDecisionModel) -> Question:
    return decision_model.questions[0][_QUESTION_ID]


@pytest.mark.asyncio
async def test_select_maps_the_answered_positional_key_to_the_configured_candidate_instance():
    strategy = ClassifierStrategy(_FakeDecisionModel(_candidate_key(1)))
    router = ModelRouter(models=[_candidate("routine"), _candidate("complex")], strategy=strategy)

    tru_candidate = await strategy.select(_context(router))

    assert tru_candidate is router.candidates[1]


@pytest.mark.asyncio
async def test_select_asks_the_fixed_routing_question_over_positional_keys_with_uncertainty_disabled():
    decision_model = _FakeDecisionModel(_candidate_key(0))
    strategy = ClassifierStrategy(decision_model)
    router = ModelRouter(
        models=[_candidate("a"), _response_model("unnamed"), _candidate("uncertain")],
        strategy=strategy,
    )

    await strategy.select(_context(router))

    exp_questions = [
        {
            _QUESTION_ID: {
                "question": _routing_question(_DEFAULT_ROUTING_POLICY),
                "choices": [_candidate_key(0), _candidate_key(1), _candidate_key(2)],
                "uncertainty": False,
            }
        }
    ]
    assert decision_model.questions == exp_questions


@pytest.mark.asyncio
async def test_select_asks_the_custom_routing_policy_after_the_fixed_routing_rules():
    decision_model = _FakeDecisionModel(_candidate_key(0))
    strategy = ClassifierStrategy(decision_model, routing_policy="Prefer the cheaper candidate.")
    router = ModelRouter(models=[_candidate("a"), _candidate("b")], strategy=strategy)

    await strategy.select(_context(router))

    assert (
        _sent_question(decision_model)["question"]
        == f"{_ROUTING_RULES}\n\nRouting policy: Prefer the cheaper candidate."
    )


@pytest.mark.asyncio
async def test_select_sends_the_fixed_rules_alone_for_an_empty_routing_policy():
    decision_model = _FakeDecisionModel(_candidate_key(0))
    strategy = ClassifierStrategy(decision_model, routing_policy="  ")
    router = ModelRouter(models=[_candidate("a"), _candidate("b")], strategy=strategy)

    await strategy.select(_context(router))

    assert _sent_question(decision_model)["question"] == _ROUTING_RULES


@pytest.mark.asyncio
async def test_select_accepts_the_deprecated_system_prompt_as_the_routing_policy():
    decision_model = _FakeDecisionModel(_candidate_key(0))
    with pytest.warns(
        DeprecationWarning, match=re.escape("system_prompt=...) is deprecated and will be removed in v2.0.0")
    ) as record:
        strategy = ClassifierStrategy(decision_model, system_prompt="Prefer the cheaper candidate.")
    assert record[0].filename == __file__
    router = ModelRouter(models=[_candidate("a"), _candidate("b")], strategy=strategy)

    await strategy.select(_context(router))

    assert _sent_question(decision_model)["question"] == _routing_question("Prefer the cheaper candidate.")


def test_constructor_rejects_routing_policy_and_system_prompt_together():
    with pytest.raises(ValueError, match="routing_policy and system_prompt cannot both be set"):
        ClassifierStrategy(_FakeDecisionModel(_candidate_key(0)), routing_policy="a", system_prompt="b")


@pytest.mark.asyncio
async def test_select_keeps_candidate_evidence_in_the_state_and_out_of_the_question():
    decision_model = _FakeDecisionModel(_candidate_key(0))
    strategy = ClassifierStrategy(decision_model)
    router = ModelRouter(models=[_candidate("routine-evidence"), _candidate("complex-evidence")], strategy=strategy)

    await strategy.select(_context(router))

    tru_state = json.loads(decision_model.states[0])
    assert "routine-evidence" not in _sent_question(decision_model)["question"]
    assert [profile["name"] for profile in tru_state["candidates"]] == ["routine-evidence", "complex-evidence"]


@pytest.mark.asyncio
async def test_select_sends_bounded_request_instructions_and_keyed_evidence_as_json_state():
    decision_model = _FakeDecisionModel(_candidate_key(0))
    strategy = ClassifierStrategy(decision_model, max_message_chars=100, max_agent_instructions_chars=50)
    router = ModelRouter(
        models=[RoutingCandidate(_response_model("a"), name="a", metadata={"cost": "low"}), _response_model("b")],
        strategy=strategy,
    )
    context = _context(
        router,
        messages=[{"role": "user", "content": [{"text": "A" * 300}]}],
        system_prompt=[{"text": "B" * 200}, {"cachePoint": {"type": "default"}}],
    )

    await strategy.select(context)

    tru_state = json.loads(decision_model.states[0])
    tru_shape = (
        len(tru_state["latest_request"]),
        "...[content omitted for routing]..." in tru_state["latest_request"],
        len(tru_state["agent_instructions"]),
        tru_state["candidates"],
    )
    exp_shape = (
        100,
        True,
        50,
        [{"key": _candidate_key(0), "name": "a", "metadata": {"cost": "low"}}, {"key": _candidate_key(1)}],
    )
    assert tru_shape == exp_shape


@pytest.mark.asyncio
async def test_select_bypasses_the_decision_model_for_a_single_candidate():
    decision_model = _FakeDecisionModel(_candidate_key(0))
    strategy = ClassifierStrategy(decision_model)
    router = ModelRouter(models=[_candidate("only")], strategy=strategy)

    tru_candidate = await strategy.select(_context(router))

    assert (tru_candidate, len(decision_model.states)) == (router.candidates[0], 0)


@pytest.mark.asyncio
async def test_select_declines_after_an_attempt_without_asking():
    decision_model = _FakeDecisionModel(_candidate_key(0))
    strategy = ClassifierStrategy(decision_model)
    router = ModelRouter(models=[_candidate("a"), _candidate("b")], strategy=strategy)
    attempts = (RoutingAttempt(router.candidates[0], ValueError("down")),)

    tru_candidate = await strategy.select(_context(router, attempts=attempts))

    assert (tru_candidate, len(decision_model.states)) == (None, 0)


@pytest.mark.asyncio
async def test_select_counts_only_caller_authored_evidence_toward_the_budget_not_the_generated_keys():
    decision_model = _FakeDecisionModel(_candidate_key(0))
    evidence_size = len(json.dumps([{}, {}], separators=(",", ":")))
    strategy = ClassifierStrategy(decision_model, max_candidate_chars=evidence_size)
    router = ModelRouter(models=[_response_model("a"), _response_model("b")], strategy=strategy)

    tru_candidate = await strategy.select(_context(router))

    assert tru_candidate is router.candidates[0]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("answer", "error_type"),
    [
        (_candidate_key(9), None),
        ("b", None),
        (True, None),
        (Uncertain("ambiguous"), None),
        (RuntimeError("provider-secret"), "RuntimeError"),
    ],
    ids=["unknown-key", "name-not-key", "boolean", "uncertain", "decision-error"],
)
async def test_select_warns_safely_and_declines_with_classifier_error(answer, error_type, caplog):
    strategy = ClassifierStrategy(_FakeDecisionModel(answer))
    router = ModelRouter(models=[_candidate("a"), _candidate("b")], strategy=strategy)

    with caplog.at_level(logging.WARNING):
        tru_candidate = await strategy.select(_context(router))

    error_field = "" if error_type is None else f", error_type=<{error_type}>"
    assert tru_candidate is None
    assert f"strategy=<ClassifierStrategy>, reason=<classifier_error>{error_field} | classification declined" in (
        caplog.text
    )
    assert "provider-secret" not in caplog.text


@pytest.mark.asyncio
async def test_select_times_out_cancels_the_decision_and_declines(caplog):
    decision_model = _FakeDecisionModel(_candidate_key(1), delay=1)
    strategy = ClassifierStrategy(decision_model, timeout=0.01)
    router = ModelRouter(models=[_candidate("a"), _candidate("b")], strategy=strategy)

    with caplog.at_level(logging.WARNING):
        tru_candidate = await strategy.select(_context(router))
    await asyncio.sleep(0)

    assert (tru_candidate, decision_model.cancelled) == (None, True)
    assert "reason=<classifier_timeout>, error_type=<TimeoutError>" in caplog.text


@pytest.mark.asyncio
async def test_select_declines_at_the_deadline_when_the_decision_model_suppresses_cancellation():
    decision_model = _FakeDecisionModel(_candidate_key(1), delay=0.2, ignore_cancel=True)
    strategy = ClassifierStrategy(decision_model, timeout=0.01)
    router = ModelRouter(models=[_candidate("a"), _candidate("b")], strategy=strategy)
    loop = asyncio.get_running_loop()

    started_at = loop.time()
    tru_candidate = await strategy.select(_context(router))
    elapsed = loop.time() - started_at
    await asyncio.sleep(0)

    assert (tru_candidate, decision_model.cancelled) == (None, True)
    assert elapsed < 0.15


@pytest.mark.asyncio
async def test_cancelling_select_cancels_the_in_flight_decision():
    decision_model = _FakeDecisionModel(_candidate_key(1), delay=1)
    strategy = ClassifierStrategy(decision_model, timeout=30)
    router = ModelRouter(models=[_candidate("a"), _candidate("b")], strategy=strategy)

    selection = asyncio.ensure_future(strategy.select(_context(router)))
    await asyncio.sleep(0.01)
    selection.cancel()
    with pytest.raises(asyncio.CancelledError):
        await selection
    await asyncio.sleep(0)

    assert decision_model.cancelled


@pytest.mark.asyncio
async def test_select_adds_the_decision_usage_to_the_request_total_even_when_the_request_limit_is_used_up():
    usage = Usage(inputTokens=4, outputTokens=5, totalTokens=9)
    strategy = ClassifierStrategy(_FakeDecisionModel(_candidate_key(1), usage=usage))
    router = ModelRouter(models=[_candidate("first"), _candidate("second")], strategy=strategy)
    request = _create_invocation_context({"turns": 1})
    request._usage["turns_taken"] = 5

    selected = await strategy.select(replace(_context(router), invocation_context=request))

    assert selected is router.candidates[1]
    assert request.usage == {"turns_taken": 5, "inputTokens": 4, "outputTokens": 5, "totalTokens": 9}


@pytest.mark.asyncio
async def test_select_adds_nothing_when_the_decision_model_reports_no_usage():
    strategy = ClassifierStrategy(_FakeDecisionModel(_candidate_key(1)))
    router = ModelRouter(models=[_candidate("first"), _candidate("second")], strategy=strategy)
    request = _create_invocation_context({"turns": 1})

    await strategy.select(replace(_context(router), invocation_context=request))

    assert request.usage == {"turns_taken": 0, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0}


def test_agent_serves_the_chosen_candidate():
    router = ModelRouter(
        models=[_candidate("routine"), _candidate("complex")],
        strategy=ClassifierStrategy(_FakeDecisionModel(_candidate_key(1))),
    )
    agent = Agent(model=router, callback_handler=None)

    tru_result = agent("hello")

    assert tru_result.message["content"][0]["text"] == "complex"


def test_agent_serves_candidate_zero_when_the_decision_fails():
    router = ModelRouter(
        models=[_candidate("default"), _candidate("other")],
        strategy=ClassifierStrategy(_FakeDecisionModel(RuntimeError("down"))),
    )
    agent = Agent(model=router, retry_strategy=None, callback_handler=None)

    tru_result = agent("hello")

    assert tru_result.message["content"][0]["text"] == "default"


def test_request_projection_covers_every_content_block_key():
    assert set(_REQUEST_BLOCK_PROJECTIONS) == set(typing.get_type_hints(ContentBlock))


@pytest.mark.parametrize(
    ("guard_content", "exp_request"),
    [
        ({"image": {"format": "png", "source": {"bytes": b"guarded-image"}}}, "[Guarded content]"),
        ({"text": {"text": "guarded-secret"}}, "[Guarded content]"),
    ],
    ids=["guarded-image", "guarded-text"],
)
def test_latest_request_counts_guarded_payloads_without_forwarding_them(guard_content, exp_request):
    messages = [
        {"role": "user", "content": [{"text": "older request"}]},
        {"role": "user", "content": [{"guardContent": guard_content}]},
    ]

    assert _latest_request_text(messages) == exp_request
