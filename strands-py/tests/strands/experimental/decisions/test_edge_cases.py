"""Error and edge paths across the decisions package: schema compile/build, answer types, agent, LLM model."""

import enum
from typing import Annotated, Literal
from unittest import mock

import pytest
from pydantic import BaseModel, Field

from strands.agent.agent_result import AgentResult
from strands.experimental.decisions import (
    Choice,
    ChoiceAnswer,
    DecisionAgent,
    DecisionResponse,
    LLMDecisionModel,
    Score,
    ScoreAnswer,
    YesNo,
    YesNoAnswer,
    compile_schema,
)
from tests.fixtures.mocked_decision_model import MockedDecisionModel, choice, score, yes
from tests.fixtures.mocked_model_provider import MockedModelProvider


class Rated(BaseModel):
    team: Annotated[Literal["a", "b"], Choice("Which team?")]
    urgent: Annotated[bool, YesNo("Urgent?")]
    anger: Annotated[float, Score("How angry?", levels=["calm", "angry"])]


class Color(enum.Enum):
    RED = "red"
    BLUE = "blue"


class IntEnum(enum.Enum):
    ONE = 1


# --------------------------------------------------------------------------- schema: build_output


@pytest.mark.parametrize(
    ("answers", "message"),
    [
        ({"urgent": yes(1.0), "anger": score(1, levels=2)}, r"no answer for Rated\.team"),
        ({"team": choice("a"), "urgent": choice("a"), "anger": score(1, levels=2)}, "expected a YesNo answer"),
        ({"team": choice("a"), "urgent": yes(1.0), "anger": yes(1.0)}, "expected a Score answer"),
    ],
    ids=["missing", "yesno_type", "score_type"],
)
def test_build_output_rejects_missing_or_mistyped_answers(answers, message):
    with pytest.raises(ValueError, match=message):
        compile_schema(Rated).build_output(answers)


def test_build_output_maps_enum_and_score():
    class Paint(BaseModel):
        color: Annotated[Color, Choice("Which color?")]
        anger: Annotated[float, Score("How angry?", levels=["calm", "angry"])]

    tru_output = compile_schema(Paint).build_output({"color": choice("blue"), "anger": score(0.4, levels=2)})

    assert tru_output == Paint(color=Color.BLUE, anger=0.4)


# --------------------------------------------------------------------------- schema: compile errors


class _NoFields(BaseModel):
    pass


class _TwoMarkers(BaseModel):
    x: Annotated[bool, YesNo("a?"), YesNo("b?")]


class _OptionalScore(BaseModel):
    x: Annotated[float | None, Score("s", levels=["lo", "hi"])]


class _BareFloat(BaseModel):
    x: float


class _WrongChoiceMarker(BaseModel):
    x: Annotated[Literal["a", "b"], YesNo("?")]


class _UnknownOption(BaseModel):
    x: Annotated[Literal["a", "b"], Choice("?", options={"c": None})]


class _OptionalReservesNone(BaseModel):
    x: Annotated[Literal["a", "none"] | None, Choice("?")]


class _NonStringEnum(BaseModel):
    x: Annotated[IntEnum, Choice("?")]


class _OptionalYesNo(BaseModel):
    x: Annotated[bool | None, YesNo("?")]


class _WrongBoolMarker(BaseModel):
    x: Annotated[bool, Choice("?", options={"a": None})]


@pytest.mark.parametrize(
    ("schema", "message"),
    [
        (_NoFields, "no fields to decide"),
        (_TwoMarkers, "at most one Choice/Score/YesNo marker"),
        (_OptionalScore, "Score field cannot be optional"),
        (_BareFloat, r"float field needs a Score\(\.\.\.\) marker"),
        (_WrongChoiceMarker, "takes a Choice marker, not YesNo"),
        (_UnknownOption, r"Choice options \['c'\] are not values"),
        (_OptionalReservesNone, "reserves the 'none' option"),
        (_NonStringEnum, "Choice options must be strings"),
        (_OptionalYesNo, "YesNo field cannot be optional"),
        (_WrongBoolMarker, "bool field takes a YesNo marker, not Choice"),
    ],
)
def test_compile_schema_rejects_unaskable_fields(schema, message):
    with pytest.raises(TypeError, match=message):
        compile_schema(schema)


def test_bool_field_without_marker_uses_its_description():
    class Plain(BaseModel):
        urgent: bool = Field(description="Is the request urgent?")

    tru_question = compile_schema(Plain).questions["urgent"]

    assert tru_question == YesNo(instructions="Is the request urgent?")


# --------------------------------------------------------------------------- answer types


@pytest.mark.parametrize(
    ("factory", "message"),
    [
        (lambda: ChoiceAnswer(choice="a", probabilities={}), "non-empty map"),
        (lambda: ChoiceAnswer(choice="a", probabilities={"a": float("nan")}), "finite, non-negative"),
        (lambda: ChoiceAnswer(choice="c", probabilities={"a": 1.0}), "not one of the answered options"),
        (lambda: ScoreAnswer(score=0.0, probabilities={0: -0.1}), "finite, non-negative"),
        (lambda: YesNoAnswer(probability=1.5), "between 0 and 1"),
        (lambda: YesNoAnswer(probability=float("inf")), "between 0 and 1"),
    ],
)
def test_answer_types_validate(factory, message):
    with pytest.raises(ValueError, match=message):
        factory()


def test_score_level_is_most_probable_index_and_response_indexes_by_id():
    answer = ScoreAnswer(score=1.4, probabilities={0: 0.1, 1: 0.5, 2: 0.4})
    response = DecisionResponse(answers={"anger": answer})

    assert answer.level == 1
    assert response["anger"] is answer


# --------------------------------------------------------------------------- DecisionAgent


class Triage(BaseModel):
    department: Annotated[Literal["billing", "technical"], Choice("Which team?")]
    urgent: Annotated[bool, YesNo("Urgent?")]
    anger: Annotated[float, Score("How angry?", levels=["calm", "angry"])]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("prompt", "message"),
    [([], "needs a prompt"), ([{"image": {}}], "found no text in the prompt")],
    ids=["empty", "no_text"],
)
async def test_agent_rejects_prompts_without_text(prompt, message):
    with pytest.raises(ValueError, match=message):
        await DecisionAgent(MockedDecisionModel(), Triage).invoke_async(prompt)


@pytest.mark.asyncio
async def test_agent_reads_message_content_and_summarizes_score():
    decisions = MockedDecisionModel({"department": choice("billing", confidence=None), "anger": score(0.6, levels=2)})

    tru_result = await DecisionAgent(decisions, Triage).invoke_async(
        [{"role": "user", "content": [{"text": "charged twice"}]}]
    )

    assert decisions.requests[0][0] == "charged twice"
    assert tru_result.message["content"][0]["text"] == "department: billing; urgent: p=0.00; anger: 0.60"


class _Silent:
    """An AgentBase (structurally) that streams events but never yields a result."""

    name = "silent"

    async def invoke_async(self, prompt=None, **kwargs):
        raise NotImplementedError

    def __call__(self, prompt=None, **kwargs):
        raise NotImplementedError

    async def stream_async(self, prompt=None, **kwargs):
        yield {"data": "partial"}


@pytest.mark.asyncio
async def test_agent_route_without_result_raises():
    agent = DecisionAgent(
        MockedDecisionModel({"department": choice("billing")}),
        Triage,
        route_on="department",
        routes={"billing": _Silent(), "technical": lambda d, p: "x"},
    )

    with pytest.raises(ValueError, match="route 'silent' produced no result"):
        await agent.invoke_async("x")


@pytest.mark.asyncio
async def test_agent_callable_route_may_return_an_agent_result():
    def route(decision, prompt):
        return AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": "from route"}]},
            metrics=None,
            state={},
        )

    agent = DecisionAgent(
        MockedDecisionModel({"department": choice("technical")}),
        Triage,
        route_on="department",
        routes={"billing": lambda d, p: "x", "technical": route},
    )

    tru_result = await agent.invoke_async("x")

    assert str(tru_result).strip() == "from route"
    assert tru_result.state["decision"].output.department == "technical"


# --------------------------------------------------------------------------- LLMDecisionModel


@pytest.mark.parametrize(
    ("config", "forwarded"),
    [
        ({"system_prompt": "Decide.", "temperature": 0.2}, [mock.call(temperature=0.2)]),
        ({"system_prompt": "Decide."}, []),
    ],
    ids=["forwards_model_keys", "prompt_only"],
)
def test_llm_update_config_sets_prompt_and_forwards_only_model_keys(config, forwarded):
    inner = MockedModelProvider([])
    llm = LLMDecisionModel(inner)

    with mock.patch.object(inner, "update_config") as update_config:
        llm.update_config(**config)

    assert llm.get_config()["system_prompt"] == "Decide."
    assert update_config.call_args_list == forwarded
