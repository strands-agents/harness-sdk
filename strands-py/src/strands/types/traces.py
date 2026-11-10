"""Tracing type definitions for the SDK."""

from collections.abc import Mapping, Sequence

AttributeValue = (
    str
    | bool
    | float
    | int
    | list[str]
    | list[bool]
    | list[float]
    | list[int]
    | Sequence[str]
    | Sequence[bool]
    | Sequence[int]
    | Sequence[float]
)

Attributes = Mapping[str, AttributeValue] | None
