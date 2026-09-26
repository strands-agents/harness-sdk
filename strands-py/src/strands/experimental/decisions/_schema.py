"""Compile a Pydantic decision schema into System One questions, and answers back into the schema."""

from __future__ import annotations

import enum
import functools
import types
import typing
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, TypeVar, get_args, get_origin

from pydantic import BaseModel
from pydantic.fields import FieldInfo

from ._types import Answer, Choice, ChoiceAnswer, JSONContent, Question, Score, ScoreAnswer, YesNo, YesNoAnswer

T = TypeVar("T", bound=BaseModel)

NO_MATCH_OPTION = "none"
_NO_MATCH_DESCRIPTION = "None of the other options applies"
_GENERATE_HINT = (
    "System One models select or score; they do not generate. Extract candidates in code and ask a Choice "
    "over them, or use an LLM for this field."
)


@dataclass(frozen=True)
class _CompiledField:
    """One schema field: the question to ask and how to turn its answer back into a field value."""

    name: str
    question: Question
    kind: Literal["choice", "yesno", "score"]
    optional: bool
    enum_type: type[enum.Enum] | None = None


@dataclass(frozen=True)
class CompiledSchema:
    """A decision schema compiled to questions. Compile once per class; reuse for every request."""

    schema: type[BaseModel]
    fields: tuple[_CompiledField, ...]

    @property
    def questions(self) -> dict[str, Question]:
        """Questions keyed by field name."""
        return {compiled.name: compiled.question for compiled in self.fields}

    def build_output(self, answers: Mapping[str, Answer]) -> BaseModel:
        """Map answers to a validated schema instance.

        Raises:
            ValueError: If an answer is missing or has the wrong type for its field.
        """
        values: dict[str, Any] = {}
        for compiled in self.fields:
            answer = answers.get(compiled.name)
            if answer is None:
                raise ValueError(f"decision model returned no answer for {self.schema.__name__}.{compiled.name}")
            values[compiled.name] = _field_value(compiled, answer)
        return self.schema.model_validate(values)


def _field_value(compiled: _CompiledField, answer: Answer) -> Any:
    if compiled.kind == "choice":
        if not isinstance(answer, ChoiceAnswer):
            raise ValueError(f"{compiled.name}: expected a Choice answer, got {type(answer).__name__}")
        if compiled.optional and answer.choice == NO_MATCH_OPTION:
            return None
        return compiled.enum_type(answer.choice) if compiled.enum_type else answer.choice
    if compiled.kind == "yesno":
        if not isinstance(answer, YesNoAnswer):
            raise ValueError(f"{compiled.name}: expected a YesNo answer, got {type(answer).__name__}")
        assert isinstance(compiled.question, YesNo)
        return answer.probability >= compiled.question.threshold
    if not isinstance(answer, ScoreAnswer):
        raise ValueError(f"{compiled.name}: expected a Score answer, got {type(answer).__name__}")
    return answer.score


def compile_schema(schema: type[BaseModel]) -> CompiledSchema:
    """Compile ``schema`` into questions, caching the result per class.

    Raises:
        TypeError: If ``schema`` is not a Pydantic model or a field cannot be asked of a System One model.
    """
    if not (isinstance(schema, type) and issubclass(schema, BaseModel)):
        raise TypeError(f"decision schema must be a pydantic BaseModel subclass, got {schema!r}")
    return _compile_cached(schema)


@functools.lru_cache(maxsize=256)
def _compile_cached(schema: type[BaseModel]) -> CompiledSchema:
    if not schema.model_fields:
        raise TypeError(f"{schema.__name__} has no fields to decide")
    fields = tuple(_compile_field(schema, name, info) for name, info in schema.model_fields.items())
    return CompiledSchema(schema=schema, fields=fields)


def _unwrap_optional(annotation: Any) -> tuple[Any, bool]:
    if get_origin(annotation) in (typing.Union, types.UnionType):
        members = [arg for arg in get_args(annotation) if arg is not type(None)]
        if len(members) == 1 and len(members) < len(get_args(annotation)):
            return members[0], True
    return annotation, False


def _marker(info: FieldInfo) -> Question | None:
    markers = [item for item in info.metadata if isinstance(item, (Choice, Score, YesNo))]
    if len(markers) > 1:
        raise TypeError("a decision field takes at most one Choice/Score/YesNo marker")
    return markers[0] if markers else None


def _compile_field(schema: type[BaseModel], name: str, info: FieldInfo) -> _CompiledField:
    where = f"{schema.__name__}.{name}"
    annotation, optional = _unwrap_optional(info.annotation)
    marker = _marker(info)
    description = info.description

    if get_origin(annotation) is Literal or (isinstance(annotation, type) and issubclass(annotation, enum.Enum)):
        return _compile_choice(where, name, annotation, marker, description, optional)
    if annotation is bool:
        return _compile_yesno(where, name, marker, description, optional)
    if annotation is float and isinstance(marker, Score):
        if optional:
            raise TypeError(f"{where}: a Score field cannot be optional; every level set always yields a score")
        return _CompiledField(name=name, question=marker, kind="score", optional=False)
    if annotation is float:
        raise TypeError(f"{where}: a float field needs a Score(...) marker with ordered levels")
    raise TypeError(f"{where}: unsupported field type {annotation!r}. {_GENERATE_HINT}")


def _compile_choice(
    where: str,
    name: str,
    annotation: Any,
    marker: Question | None,
    description: str | None,
    optional: bool,
) -> _CompiledField:
    if marker is not None and not isinstance(marker, Choice):
        raise TypeError(f"{where}: a Literal/Enum field takes a Choice marker, not {type(marker).__name__}")
    names, enum_type = _choice_values(where, annotation)
    marker_options = marker.options if marker else {}
    unknown = set(marker_options) - set(names)
    if unknown:
        raise TypeError(f"{where}: Choice options {sorted(unknown)} are not values of the field type")
    if optional and NO_MATCH_OPTION in names:
        raise TypeError(f"{where}: an optional Choice reserves the {NO_MATCH_OPTION!r} option for no-match")

    options: dict[str, JSONContent | None] = {option: marker_options.get(option) for option in names}
    if optional:
        options[NO_MATCH_OPTION] = _NO_MATCH_DESCRIPTION
    instructions = _instructions(where, marker, description)
    return _CompiledField(
        name=name,
        question=Choice(instructions=instructions, options=options),
        kind="choice",
        optional=optional,
        enum_type=enum_type,
    )


def _choice_values(where: str, annotation: Any) -> tuple[list[str], type[enum.Enum] | None]:
    """Return a Literal/Enum field's option names, and the enum type when it is an Enum."""
    is_literal = get_origin(annotation) is Literal
    values = list(get_args(annotation)) if is_literal else [member.value for member in annotation]
    if not all(isinstance(value, str) for value in values):
        raise TypeError(f"{where}: Choice options must be strings (string Literal values or a str-valued Enum)")
    return values, None if is_literal else annotation


def _compile_yesno(
    where: str, name: str, marker: Question | None, description: str | None, optional: bool
) -> _CompiledField:
    if optional:
        raise TypeError(f"{where}: a YesNo field cannot be optional; it always yields a probability")
    if marker is not None and not isinstance(marker, YesNo):
        raise TypeError(f"{where}: a bool field takes a YesNo marker, not {type(marker).__name__}")
    question = marker if marker is not None else YesNo(instructions=_instructions(where, None, description))
    return _CompiledField(name=name, question=question, kind="yesno", optional=False)


def _instructions(where: str, marker: Question | None, description: str | None) -> JSONContent:
    if marker is not None:
        return marker.instructions
    if description:
        return description
    raise TypeError(f"{where}: give the field a Choice/Score/YesNo marker or a Field(description=...) to ask")
