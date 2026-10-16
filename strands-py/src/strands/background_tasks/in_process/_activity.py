"""Bounded activity types for in-process background tasks."""

from typing import Literal, TypeAlias

from typing_extensions import TypedDict

BackgroundTaskActivityType: TypeAlias = Literal["lifecycle", "progress", "tool_request", "tool_result"]


class BackgroundTaskActivityEvent(TypedDict):
    """One activity recorded during a background task."""

    sequence: int
    timestamp: str
    type: BackgroundTaskActivityType
    message: str


class BackgroundTaskActivityHistory(TypedDict):
    """Retained activity after a sequence cursor."""

    events: list[BackgroundTaskActivityEvent]
    first_available_sequence: int
    last_sequence: int
    truncated: bool
