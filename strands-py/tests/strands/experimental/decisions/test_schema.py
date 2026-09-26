import enum
from typing import Annotated, Literal

import pytest
from pydantic import BaseModel, Field

from strands.experimental.decisions import Choice, Score, YesNo, compile_schema, yes_no_confidence
from strands.experimental.decisions._schema import NO_MATCH_OPTION
from tests.fixtures.mocked_decision_model import choice, score, yes


class Department(enum.Enum):
    BILLING = "billing"
    TECHNICAL = "technical"


class Triage(BaseModel):
    department: Annotated[
        Literal["billing", "technical", "sales"],
        Choice("Which team should handle `ticket`?", options={"billing": "Payments, refunds"}),
    ]
    urgent: Annotated[bool, YesNo("Does `ticket` convey time pressure?", threshold=0.7)]
    frustration: Annotated[float, Score("How frustrated is the customer?", levels=["calm", "frustrated", "angry"])]


def test_compile_schema_builds_questions_from_types_and_markers():
    tru_questions = compile_schema(Triage).questions
    exp_questions = {
        "department": Choice(
            "Which team should handle `ticket`?",
            options={"billing": "Payments, refunds", "technical": None, "sales": None},
        ),
        "urgent": YesNo("Does `ticket` convey time pressure?", threshold=0.7),
        "frustration": Score("How frustrated is the customer?", levels=["calm", "frustrated", "angry"]),
    }
    assert tru_questions == exp_questions


def test_compile_schema_is_cached_per_class():
    assert compile_schema(Triage) is compile_schema(Triage)


def test_build_output_maps_answers_to_typed_fields():
    compiled = compile_schema(Triage)

    tru_output = compiled.build_output(
        {"department": choice("technical"), "urgent": yes(0.69), "frustration": score(1.4)}
    )

    assert tru_output == Triage(department="technical", urgent=False, frustration=1.4)


def test_optional_choice_adds_no_match_option_and_maps_it_to_none():
    class Pick(BaseModel):
        element: Annotated[Literal["e1", "e2"] | None, Choice("Which element to click?")]

    compiled = compile_schema(Pick)

    assert list(compiled.questions["element"].options) == ["e1", "e2", NO_MATCH_OPTION]
    assert compiled.build_output({"element": choice(NO_MATCH_OPTION)}).element is None


def test_enum_field_and_field_description_compile_to_choice():
    class Route(BaseModel):
        department: Department = Field(description="Which team handles it?")

    compiled = compile_schema(Route)

    assert compiled.questions["department"] == Choice(
        "Which team handles it?", options={"billing": None, "technical": None}
    )
    assert compiled.build_output({"department": choice("billing")}).department is Department.BILLING


def test_bool_field_with_description_compiles_to_yesno():
    class Check(BaseModel):
        refund: bool = Field(description="Does the customer ask for a refund?")

    assert compile_schema(Check).questions["refund"] == YesNo("Does the customer ask for a refund?")


@pytest.mark.parametrize(
    ("annotation", "message"),
    [
        (str, "they do not generate"),
        (int, "they do not generate"),
        (list[str], "they do not generate"),
        (float, "needs a Score"),
    ],
)
def test_compile_schema_rejects_unanswerable_fields(annotation, message):
    schema = type("Bad", (BaseModel,), {"__annotations__": {"field": annotation}, "field": Field(description="q")})

    with pytest.raises(TypeError, match=message):
        compile_schema(schema)


def test_compile_schema_rejects_marker_options_not_in_type():
    class Bad(BaseModel):
        pick: Annotated[Literal["a"], Choice("q", options={"b": "x"})]

    with pytest.raises(TypeError, match=r"\['b'\] are not values"):
        compile_schema(Bad)


def test_compile_schema_rejects_non_string_options():
    class Bad(BaseModel):
        pick: Annotated[Literal[1, 2], Choice("q")]

    with pytest.raises(TypeError, match="options must be strings"):
        compile_schema(Bad)


def test_compile_schema_requires_instructions():
    class Bad(BaseModel):
        pick: Literal["a", "b"]

    with pytest.raises(TypeError, match="marker or a Field"):
        compile_schema(Bad)


def test_compile_schema_rejects_mismatched_marker():
    class Bad(BaseModel):
        flag: Annotated[bool, Choice("q")]

    with pytest.raises(TypeError, match="takes a YesNo marker"):
        compile_schema(Bad)


def test_compile_schema_rejects_non_pydantic():
    with pytest.raises(TypeError, match="BaseModel subclass"):
        compile_schema(dict)  # type: ignore[arg-type]


def test_build_output_rejects_wrong_answer_type():
    with pytest.raises(ValueError, match="expected a Choice answer"):
        compile_schema(Triage).build_output({"department": yes(1.0), "urgent": yes(1.0), "frustration": score(1)})


@pytest.mark.parametrize(
    ("factory", "message"),
    [
        (lambda: Choice(""), "non-empty"),
        (lambda: Score("q", levels=["only"]), "at least 2 levels"),
        (lambda: Score("q", levels="calm"), "at least 2 levels"),
        (lambda: YesNo("q", threshold=1.5), "between 0 and 1"),
    ],
)
def test_question_validation(factory, message):
    with pytest.raises(ValueError, match=message):
        factory()


def test_question_types_carry_no_vendor_limits():
    assert len(Choice("q", options={str(n): None for n in range(300)}).options) == 300
    assert len(Score("q", levels=[str(n) for n in range(20)]).levels) == 20


@pytest.mark.parametrize(("probability", "expected"), [(0.5, 0.0), (0.0, 1.0), (1.0, 1.0), (0.8, 0.6), (0.1, 0.8)])
def test_yes_no_confidence_is_distance_from_even_odds(probability, expected):
    assert yes_no_confidence(probability) == pytest.approx(expected)
