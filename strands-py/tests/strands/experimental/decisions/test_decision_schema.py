from typing import Annotated, Literal

import pytest
from pydantic import BaseModel

from strands.experimental.decisions import Choice, DecisionSchema, Score, YesNo, compile_schema
from tests.fixtures.mocked_decision_model import MockedDecisionModel, choice, yes


class Triage(DecisionSchema):
    department: Annotated[Literal["billing", "technical"], Choice("Which team should handle `ticket`?")]
    urgent: Annotated[bool, YesNo("Does `ticket` convey time pressure?")]


def test_a_decision_schema_is_a_base_model_and_compiles_like_one():
    class Plain(BaseModel):
        department: Annotated[Literal["billing", "technical"], Choice("Which team should handle `ticket`?")]
        urgent: Annotated[bool, YesNo("Does `ticket` convey time pressure?")]

    assert issubclass(Triage, BaseModel)
    assert compile_schema(Triage).questions == compile_schema(Plain).questions


def test_a_decision_schema_rejects_an_unanswerable_field_at_class_definition():
    with pytest.raises(TypeError, match="they do not generate"):

        class Summary(DecisionSchema):
            text: str


def test_a_decision_schema_base_with_no_fields_is_not_compiled():
    class Base(DecisionSchema):
        pass

    class Child(Base):
        urgent: Annotated[bool, YesNo("Is it urgent?")]

    assert list(compile_schema(Child).questions) == ["urgent"]
    with pytest.raises(TypeError, match="no fields to decide"):
        compile_schema(Base)


def test_build_turns_runtime_questions_into_a_compiled_schema():
    route = Choice("Which agent should take `request`?", options={"billing": "Charges", "tech": None})
    urgent = YesNo("Is `request` urgent?", threshold=0.6)
    anger = Score("How upset is the customer?", levels=["calm", "upset"])

    built = DecisionSchema.build("Route", agent=route, urgent=urgent, anger=anger)

    assert issubclass(built, DecisionSchema)
    assert built.__name__ == "Route"
    assert compile_schema(built).questions == {"agent": route, "urgent": urgent, "anger": anger}


@pytest.mark.asyncio
async def test_decide_on_a_built_schema_returns_an_instance_of_it():
    built = DecisionSchema.build("Route", agent=Choice("Which agent?", options={"billing": None, "tech": None}))
    model = MockedDecisionModel({"agent": choice("tech")})

    decision = await model.decide(built, state={"request": "The app crashes"})

    assert isinstance(decision.output, built)
    assert decision.output.agent == "tech"  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_decide_still_accepts_a_plain_base_model():
    class Plain(BaseModel):
        urgent: Annotated[bool, YesNo("Is it urgent?")]

    decision = await MockedDecisionModel({"urgent": yes(0.9)}).decide(Plain, state="now!")

    assert decision.output == Plain(urgent=True)


@pytest.mark.parametrize(
    ("questions", "message"),
    [
        ({}, "at least one question"),
        ({"agent": Choice("Which agent?")}, "needs its options"),
        ({"agent": "billing"}, "expected a Choice, Score or YesNo"),
    ],
)
def test_build_rejects_bad_questions(questions, message):
    with pytest.raises(TypeError, match=message):
        DecisionSchema.build("Bad", **questions)
