"""Unit tests for ``LLMDecisionModel``."""

from collections.abc import AsyncGenerator
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from strands.decisions import (
    DecisionInput,
    DecisionMetadata,
    DecisionModel,
    DecisionResult,
    LLMDecisionModel,
    Question,
    Uncertain,
)
from strands.models.model import Model
from strands.tools.structured_output.structured_output_utils import convert_pydantic_to_tool_spec
from strands.types.content import Messages
from strands.types.event_loop import Usage
from strands.types.exceptions import StructuredOutputException

DEFAULT_USAGE: Usage = {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}


class RecordingModel(Model):
    """A model whose ``structured_output`` replays a canned answer set and records its inputs.

    ``raw`` entries may be bare strings (shorthand for ``{"answer": ...}``) or full
    ``{"answer", "reason"?}`` mappings. Set ``emit_output=False`` to simulate a model that produces
    no structured answers, or ``error`` to simulate a provider failure. ``usage``/``latency_ms`` of
    ``None`` suppress that metadata.
    """

    def __init__(
        self,
        raw: dict[str, Any],
        *,
        usage: Usage | None = DEFAULT_USAGE,
        latency_ms: int | None = 42,
        emit_output: bool = True,
        error: ValueError | None = None,
    ) -> None:
        self.raw = raw
        self.usage = usage
        self.latency_ms = latency_ms
        self.emit_output = emit_output
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def get_config(self) -> Any:
        return {}

    def update_config(self, **model_config: Any) -> None:
        pass

    async def structured_output(
        self, output_model: type[BaseModel], prompt: Messages, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncGenerator[dict[str, Any], None]:
        self.calls.append({"output_model": output_model, "prompt": prompt, "system_prompt": system_prompt})

        if self.error is not None:
            raise self.error

        metadata: dict[str, Any] = {}
        if self.usage is not None:
            metadata["usage"] = self.usage
        if self.latency_ms is not None:
            metadata["metrics"] = {"latencyMs": self.latency_ms}
        if metadata:
            yield {"event": {"metadata": metadata}}

        if self.emit_output:
            normalized = {
                key: (value if isinstance(value, dict) else {"answer": value}) for key, value in self.raw.items()
            }
            yield {"output": output_model(**normalized)}

    async def stream(self, *args: Any, **kwargs: Any) -> AsyncGenerator[Any, None]:
        raise NotImplementedError
        yield  # pragma: no cover


class RecordingDecisionModel(DecisionModel):
    """A decision model that records implementation-specific keyword arguments."""

    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    async def _ask(self, state: DecisionInput, questions: dict[str, Question], **kwargs: Any) -> DecisionResult:
        self.kwargs = kwargs
        return DecisionResult(
            answers={question_id: True for question_id in questions},
            metadata=DecisionMetadata(latency_ms=0),
        )


def _answer_enum(output_model: type[BaseModel], question_id: str) -> list[str]:
    """Pull the enum of allowed values for a question from the built answer model's JSON schema.

    Questions are exposed under their id (a field alias), each referencing a per-question ``$def``.
    """
    schema = output_model.model_json_schema()
    ref = schema["properties"][question_id]["$ref"]
    per_question = schema["$defs"][ref.rsplit("/", 1)[-1]]
    return per_question["properties"]["answer"]["enum"]


@pytest.mark.asyncio
async def test_forwards_additional_keyword_arguments_to_the_implementation():
    decision = RecordingDecisionModel()
    questions: dict[str, Question] = {"q": {"question": "ok?", "choices": "boolean"}}

    result = await decision.ask("x", questions, future_option="value")

    assert decision.kwargs == {"future_option": "value"}
    assert result.answers == {"q": True}


@pytest.mark.asyncio
async def test_narrows_string_and_bool_answers_from_a_successful_call():
    model = RecordingModel({"color": "red", "is_fruit": "true"})
    decision = LLMDecisionModel(model=model)

    result = await decision.ask(
        "The fruit is an apple",
        {
            "color": {"question": "What color is the fruit?", "choices": ["red", "green", "blue"]},
            "is_fruit": {"question": "Is the thing talked about a fruit?", "choices": "boolean", "uncertainty": False},
        },
    )

    assert list(result.answers.keys()) == ["color", "is_fruit"]
    assert result.answers["color"] == "red"
    assert result.answers["is_fruit"] is True
    assert result.usage == DEFAULT_USAGE
    assert result.metadata.latency_ms == 42


@pytest.mark.asyncio
async def test_question_ids_do_not_collide_with_internal_field_names():
    model = RecordingModel({"q0": "true", "q1": "sports"})
    decision = LLMDecisionModel(model=model)

    result = await decision.ask(
        "English text about sports",
        {
            "q0": {"question": "Is the text in English?", "choices": "boolean"},
            "q1": {"question": "Which topic?", "choices": ["sports", "politics"]},
        },
    )

    schema = convert_pydantic_to_tool_spec(model.calls[0]["output_model"])["inputSchema"]["json"]
    assert schema["properties"]["q0"]["properties"]["answer"]["enum"] == ["true", "false", "uncertain"]
    assert schema["properties"]["q1"]["properties"]["answer"]["enum"] == ["sports", "politics", "uncertain"]
    assert schema["required"] == ["q0", "q1"]
    assert result.answers == {"q0": True, "q1": "sports"}


@pytest.mark.asyncio
async def test_falls_back_to_wall_clock_latency_when_provider_omits_latency():
    model = RecordingModel({"q": "true"}, latency_ms=None)
    decision = LLMDecisionModel(model=model)

    result = await decision.ask("x", {"q": {"question": "ok?", "choices": "boolean"}})

    assert result.metadata.latency_ms >= 0


@pytest.mark.asyncio
async def test_falls_back_to_wall_clock_latency_when_provider_reports_zero(monkeypatch):
    timestamps = iter([10.0, 10.125])
    monkeypatch.setattr("strands.decisions.llm_decision_model.time.perf_counter", lambda: next(timestamps))
    model = RecordingModel({"q": "true"}, latency_ms=0)
    decision = LLMDecisionModel(model=model)

    result = await decision.ask("x", {"q": {"question": "ok?", "choices": "boolean"}})

    assert result.metadata.latency_ms == 125


@pytest.mark.asyncio
async def test_returns_uncertain_when_model_picks_the_uncertain_option():
    model = RecordingModel({"color": "uncertain"})
    decision = LLMDecisionModel(model=model)

    result = await decision.ask("ambiguous", {"color": {"question": "color?", "choices": ["red", "green"]}})

    assert isinstance(result.answers["color"], Uncertain)


@pytest.mark.asyncio
async def test_returns_uncertain_carrying_the_model_supplied_reason():
    model = RecordingModel({"color": {"answer": "uncertain", "reason": "the input mentioned no color"}})
    decision = LLMDecisionModel(model=model)

    result = await decision.ask("ambiguous", {"color": {"question": "color?", "choices": ["red", "green"]}})

    answer = result.answers["color"]
    assert isinstance(answer, Uncertain)
    assert answer.reason == "the input mentioned no color"


@pytest.mark.asyncio
async def test_omits_uncertain_from_the_enum_when_a_question_opts_out():
    model = RecordingModel({"q": "yes"})
    decision = LLMDecisionModel(model=model)

    await decision.ask("state", {"q": {"question": "ok?", "choices": ["yes", "no"], "uncertainty": False}})

    assert _answer_enum(model.calls[0]["output_model"], "q") == ["yes", "no"]


@pytest.mark.asyncio
async def test_appends_uncertain_to_the_enum_by_default():
    model = RecordingModel({"q": "uncertain"})
    decision = LLMDecisionModel(model=model)

    await decision.ask("state", {"q": {"question": "ok?", "choices": ["yes", "no"]}})

    assert _answer_enum(model.calls[0]["output_model"], "q") == ["yes", "no", "uncertain"]


@pytest.mark.asyncio
async def test_wraps_a_plain_string_state_as_a_single_user_message():
    model = RecordingModel({"q": "true"})
    decision = LLMDecisionModel(model=model)

    await decision.ask("the state", {"q": {"question": "is this a string?", "choices": "boolean"}})

    sent = model.calls[0]["prompt"]
    assert sent == [{"role": "user", "content": [{"text": "the state"}]}]


@pytest.mark.asyncio
async def test_wraps_a_content_array_as_a_single_user_message():
    model = RecordingModel({"q": "true"})
    decision = LLMDecisionModel(model=model)

    await decision.ask([{"text": "hello"}], {"q": {"question": "greeting?", "choices": "boolean"}})

    sent = model.calls[0]["prompt"]
    assert sent == [{"role": "user", "content": [{"text": "hello"}]}]


@pytest.mark.asyncio
async def test_passes_a_message_history_straight_through():
    model = RecordingModel({"q": "true"})
    decision = LLMDecisionModel(model=model)

    history: Messages = [
        {"role": "user", "content": [{"text": "earlier"}]},
        {"role": "assistant", "content": [{"text": "ack"}]},
        {"role": "user", "content": [{"text": "the real question"}]},
    ]

    await decision.ask(history, {"q": {"question": "conversation?", "choices": "boolean"}})

    assert model.calls[0]["prompt"] is history


@pytest.mark.asyncio
async def test_includes_the_untrusted_state_defense_in_the_system_prompt():
    model = RecordingModel({"q": "true"})
    decision = LLMDecisionModel(model=model)

    await decision.ask("x", {"q": {"question": "ok?", "choices": "boolean"}})

    assert "MANDATORY RULES" in model.calls[0]["system_prompt"]


@pytest.mark.asyncio
async def test_throws_when_the_model_returns_no_structured_answers():
    model = RecordingModel({}, emit_output=False)
    decision = LLMDecisionModel(model=model)

    with pytest.raises(StructuredOutputException, match="no structured answers"):
        await decision.ask("x", {"q": {"question": "bool?", "choices": "boolean"}})


@pytest.mark.parametrize(
    "provider_error",
    [
        "Failed to parse or load content into model: schema validation failed",
        "Failed to parse tool call arguments into model: schema validation failed",
    ],
)
@pytest.mark.asyncio
async def test_preserves_provider_schema_failure_details(provider_error):
    error = ValueError(provider_error)
    model = RecordingModel({}, error=error)
    decision = LLMDecisionModel(model=model)

    with pytest.raises(StructuredOutputException) as raised:
        await decision.ask("x", {"q": {"question": "bool?", "choices": "boolean"}})

    assert str(raised.value) == f"decision model returned no structured answers: {provider_error}"
    assert raised.value.__cause__ is error


@pytest.mark.asyncio
async def test_rejects_an_empty_question_map_before_calling_the_model():
    model = RecordingModel({})
    decision = LLMDecisionModel(model=model)

    with pytest.raises(ValueError, match="at least one question"):
        await decision.ask("x", {})
    assert model.calls == []


@pytest.mark.asyncio
async def test_rejects_empty_question_text():
    model = RecordingModel({})
    decision = LLMDecisionModel(model=model)

    with pytest.raises(ValueError, match="question must be a non-empty string"):
        await decision.ask("x", {"q": {"question": "   ", "choices": "boolean"}})
    assert model.calls == []


@pytest.mark.asyncio
async def test_accepts_an_uncertainty_object_without_min_confidence():
    model = RecordingModel({"q": "uncertain"})
    decision = LLMDecisionModel(model=model)

    result = await decision.ask("x", {"q": {"question": "bool?", "choices": "boolean", "uncertainty": {}}})

    assert isinstance(result.answers["q"], Uncertain)


@pytest.mark.parametrize("min_confidence", [-0.1, 1.1, float("nan"), float("inf")])
@pytest.mark.asyncio
async def test_rejects_out_of_range_or_non_finite_min_confidence(min_confidence):
    model = RecordingModel({})
    decision = LLMDecisionModel(model=model)

    with pytest.raises(ValueError, match=r"uncertainty.min_confidence must be in \[0.0, 1.0\]"):
        await decision.ask(
            "x",
            {
                "q": {
                    "question": "bool?",
                    "choices": "boolean",
                    "uncertainty": {"min_confidence": min_confidence},
                }
            },
        )
    assert model.calls == []


@pytest.mark.asyncio
async def test_rejects_a_choice_literally_named_uncertain():
    model = RecordingModel({})
    decision = LLMDecisionModel(model=model)

    with pytest.raises(ValueError, match="reserved for the Uncertain answer"):
        await decision.ask("x", {"q": {"question": "pick", "choices": ["certain", "uncertain"]}})
    assert model.calls == []


@pytest.mark.asyncio
async def test_rejects_an_empty_choice_list():
    model = RecordingModel({})
    decision = LLMDecisionModel(model=model)

    with pytest.raises(ValueError, match="choices must be a non-empty list of strings"):
        await decision.ask("x", {"q": {"question": "pick", "choices": []}})
    assert model.calls == []


@pytest.mark.asyncio
async def test_rejects_an_empty_choice_value():
    model = RecordingModel({})
    decision = LLMDecisionModel(model=model)

    with pytest.raises(ValueError, match="choices must be non-empty strings"):
        await decision.ask("x", {"q": {"question": "pick", "choices": [""]}})
    assert model.calls == []


@pytest.mark.asyncio
async def test_rejects_duplicate_option_values():
    model = RecordingModel({})
    decision = LLMDecisionModel(model=model)

    with pytest.raises(ValueError, match="unique"):
        await decision.ask("x", {"q": {"question": "pick", "choices": ["a", "a"]}})
    assert model.calls == []


@pytest.mark.asyncio
async def test_returns_a_result_without_usage_when_the_provider_omits_it():
    model = RecordingModel({"q": "true"}, usage=None)
    decision = LLMDecisionModel(model=model)

    result = await decision.ask("x", {"q": {"question": "ok?", "choices": "boolean"}})

    assert result.answers["q"] is True
    assert result.usage is None
    assert result.metadata.latency_ms >= 0


@pytest.mark.asyncio
async def test_translates_an_omitted_answer_validation_error():
    model = RecordingModel({})
    decision = LLMDecisionModel(model=model)

    with pytest.raises(StructuredOutputException, match="invalid answer set") as raised:
        await decision.ask("x", {"q": {"question": "bool?", "choices": "boolean"}})

    assert isinstance(raised.value.__cause__, ValidationError)


@pytest.mark.asyncio
async def test_translates_an_unknown_option_validation_error():
    model = RecordingModel({"color": "purple"})
    decision = LLMDecisionModel(model=model)

    with pytest.raises(StructuredOutputException, match="invalid answer set") as raised:
        await decision.ask("x", {"color": {"question": "c?", "choices": ["red", "green"]}})

    assert isinstance(raised.value.__cause__, ValidationError)


def test_rejects_a_non_model_argument():
    with pytest.raises(TypeError):
        LLMDecisionModel(model=object())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_routes_through_structured_output_with_the_built_answer_model():
    model = RecordingModel({"q": "true"})
    decision = LLMDecisionModel(model=model)

    await decision.ask("x", {"q": {"question": "ok?", "choices": "boolean"}})

    assert len(model.calls) == 1
    output_model = model.calls[0]["output_model"]
    assert issubclass(output_model, BaseModel)
    assert _answer_enum(output_model, "q") == ["true", "false", "uncertain"]


@pytest.mark.asyncio
async def test_carries_question_ids_that_are_not_valid_python_identifiers():
    model = RecordingModel({"is it red?": "yes", "model_config": "no"})
    decision = LLMDecisionModel(model=model)

    result = await decision.ask(
        "x",
        {
            "is it red?": {"question": "red?", "choices": ["yes", "no"]},
            "model_config": {"question": "config?", "choices": ["yes", "no"]},
        },
    )

    assert result.answers == {"is it red?": "yes", "model_config": "no"}
    assert _answer_enum(model.calls[0]["output_model"], "is it red?") == ["yes", "no", "uncertain"]


@pytest.mark.parametrize("stop_reason", ["end_turn", "max_tokens", "guardrail_intervened"])
@pytest.mark.asyncio
async def test_translates_bedrock_non_tool_stop_reasons(monkeypatch, stop_reason):
    from strands.models.bedrock import BedrockModel

    model = BedrockModel.__new__(BedrockModel)

    async def fake_stream(self, *args, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockDelta": {"delta": {"text": "not a structured answer"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": stop_reason}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                "metrics": {"latencyMs": 1},
            }
        }

    monkeypatch.setattr(BedrockModel, "stream", fake_stream)
    decision = LLMDecisionModel(model=model)

    with pytest.raises(StructuredOutputException, match="no structured answers") as raised:
        await decision.ask("x", {"q": {"question": "ok?", "choices": "boolean"}})

    assert isinstance(raised.value.__cause__, ValueError)
    assert stop_reason in str(raised.value.__cause__)


@pytest.mark.asyncio
async def test_bedrock_structured_output_surfaces_usage_and_latency(monkeypatch):
    """Pin the provider-metadata contract the port depends on: BedrockModel's structured_output
    surfaces a ``{"event": {"metadata": ...}}`` chunk whose usage/latency flow into the result."""
    import json

    from strands.models.bedrock import BedrockModel

    model = BedrockModel.__new__(BedrockModel)

    async def fake_stream(self, *args, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {"toolUse": {"name": "DecisionAnswers", "toolUseId": "d"}}}}
        yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps({"q": {"answer": "true"}})}}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "tool_use"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 11, "outputTokens": 4, "totalTokens": 15},
                "metrics": {"latencyMs": 7},
            }
        }

    monkeypatch.setattr(BedrockModel, "stream", fake_stream)
    decision = LLMDecisionModel(model=model)

    result = await decision.ask("x", {"q": {"question": "ok?", "choices": "boolean"}})

    assert result.answers["q"] is True
    assert result.usage == {"inputTokens": 11, "outputTokens": 4, "totalTokens": 15}
    assert result.metadata.latency_ms == 7
