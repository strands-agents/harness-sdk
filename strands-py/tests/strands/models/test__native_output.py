import datetime
import enum
from typing import Any, Literal

import anthropic
import pydantic
import pytest

from strands.models._native_output import (
    _FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES,
    _NATIVE_OUTPUT_REJECTED_MESSAGES,
    _NATIVE_OUTPUT_UNSUPPORTED_MESSAGES,
    find_unsupported_native_output_feature,
    handle_rejected_mechanism,
    structured_output_mechanisms,
    to_native_output_schema,
    unsupported_mechanisms,
)


class Person(pydantic.BaseModel):
    name: str
    age: int


class Color(enum.Enum):
    RED = "red"
    BLUE = "blue"


class Team(pydantic.BaseModel):
    """A team of people."""

    members: list[Person] = pydantic.Field(min_length=2)
    lead: Person | None = None
    color: Color
    kind: Literal["a", "b"]
    code: str = pydantic.Field(pattern=r"^[A-Z]+$", description="Team code")
    founded: datetime.date
    score: float = pydantic.Field(ge=0)


class WithDict(pydantic.BaseModel):
    scores: dict[str, int]


class WithNestedDict(pydantic.BaseModel):
    team: Team
    extra: list[WithDict]


class WithTuple(pydantic.BaseModel):
    point: tuple[int, int]


class WithAny(pydantic.BaseModel):
    value: Any


class WithMixedLiteral(pydantic.BaseModel):
    value: Literal["a", 1]


FORCED = {"tool": {"name": "Person"}}


@pytest.mark.parametrize(
    ("unsupported", "tool_choice", "exp_mechanisms"),
    [
        (set(), FORCED, ["forced", "native", "auto"]),
        (set(), {"any": {}}, ["forced", "native", "auto"]),
        (set(), {"auto": {}}, ["native", "auto"]),
        (set(), None, ["native", "auto"]),
        ({"forced"}, FORCED, ["native", "auto"]),
        ({"forced", "native"}, FORCED, ["auto"]),
    ],
)
def test_structured_output_mechanisms(unsupported, tool_choice, exp_mechanisms):
    tru_mechanisms = structured_output_mechanisms(unsupported, tool_choice, Person)

    assert tru_mechanisms == exp_mechanisms


def test_structured_output_mechanisms_skips_native_for_unrepresentable_model():
    with pytest.warns(UserWarning, match=r"cannot represent WithDict \(dict fields\)"):
        tru_mechanisms = structured_output_mechanisms(set(), FORCED, WithDict)

    assert tru_mechanisms == ["forced", "auto"]


def test_structured_output_mechanisms_does_not_warn_when_native_is_known_unsupported(captured_warnings):
    tru_mechanisms = structured_output_mechanisms({"native"}, FORCED, WithDict)

    assert tru_mechanisms == ["forced", "auto"]
    assert captured_warnings == []


@pytest.mark.parametrize(
    ("mechanism", "signal"),
    [
        *(("forced", signal) for signal in _FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES),
        *(("native", signal) for signal in _NATIVE_OUTPUT_UNSUPPORTED_MESSAGES),
    ],
)
def test_handle_rejected_mechanism_remembers_unsupported_mechanism(mechanism, signal):
    tru_handled = handle_rejected_mechanism("p", "m", mechanism, Person, f"ValidationException: {signal}.")

    assert tru_handled is True
    assert unsupported_mechanisms("p", "m", WithDict) == {mechanism}
    assert unsupported_mechanisms("p", "other-model", Person) == set()


@pytest.mark.parametrize("signal", _NATIVE_OUTPUT_REJECTED_MESSAGES)
def test_handle_rejected_mechanism_remembers_rejected_schema_per_output_model(signal):
    with pytest.warns(UserWarning, match="Native structured output rejected Person"):
        tru_handled = handle_rejected_mechanism("p", "m", "native", Person, f"invalid_request_error: {signal}")

    assert tru_handled is True
    assert unsupported_mechanisms("p", "m", Person) == {"native"}
    assert unsupported_mechanisms("p", "m", WithDict) == set()


@pytest.mark.parametrize(
    ("mechanism", "message"),
    [
        ("forced", "Input is too long for requested model"),
        ("forced", _NATIVE_OUTPUT_REJECTED_MESSAGES[0]),
        ("native", _FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES[0]),
        ("auto", _FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES[0]),
    ],
)
def test_handle_rejected_mechanism_ignores_unrelated_error(mechanism, message):
    tru_handled = handle_rejected_mechanism("p", "m", mechanism, Person, message)

    assert tru_handled is False
    assert unsupported_mechanisms("p", "m", Person) == set()


@pytest.mark.parametrize(
    ("schema", "exp_feature"),
    [
        (Person.model_json_schema(), None),
        (Team.model_json_schema(), None),
        (WithDict.model_json_schema(), "dict fields"),
        (WithNestedDict.model_json_schema(), "dict fields"),
        ({"type": "object", "patternProperties": {"^a": {"type": "string"}}}, "dict fields"),
        (WithTuple.model_json_schema(), "tuple fields"),
        (WithAny.model_json_schema(), "untyped fields (Any)"),
        (WithMixedLiteral.model_json_schema(), "untyped fields (Any)"),
    ],
)
def test_find_unsupported_native_output_feature(schema, exp_feature):
    tru_feature = find_unsupported_native_output_feature(schema)

    assert tru_feature == exp_feature


@pytest.mark.parametrize("output_model", [Person, Team, WithNestedDict])
def test_to_native_output_schema_matches_anthropic_transform_schema(output_model):
    tru_schema = to_native_output_schema(output_model.model_json_schema())
    exp_schema = anthropic.transform_schema(output_model)

    assert tru_schema == exp_schema


def test_to_native_output_schema_untyped_node():
    with pytest.raises(ValueError, match="Schema must have a 'type'"):
        to_native_output_schema(WithAny.model_json_schema())
