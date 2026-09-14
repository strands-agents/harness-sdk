"""Utility for inferring event types from callback type hints."""

import inspect
import logging
import types
from typing import TYPE_CHECKING, Union, cast, get_args, get_origin, get_type_hints

if TYPE_CHECKING:
    from .registry import HookCallback, TEvent

logger = logging.getLogger(__name__)


def _normalize_event_type(type_hint: object) -> type | None:
    """Normalize a plain or parameterized annotation to its event type."""
    origin = get_origin(type_hint)
    candidate = origin or type_hint
    return candidate if isinstance(candidate, type) else None


def infer_event_types(callback: "HookCallback[TEvent]") -> "list[type[TEvent]]":
    """Infer the event type(s) from a callback's type hints.

    Supports plain or parameterized event types and unions (A | B or Union[A, B]).

    Args:
        callback: The callback function to inspect.

    Returns:
        A list of event types inferred from the callback's first parameter type hint.

    Raises:
        ValueError: If the event type cannot be inferred from the callback's type hints,
            or if a union contains None or non-BaseHookEvent types.
    """
    # Import here to avoid circular dependency
    from .registry import BaseHookEvent

    try:
        hints = get_type_hints(callback)
    except Exception as e:
        logger.debug("callback=<%s>, error=<%s> | failed to get type hints", callback, e)
        raise ValueError(
            "failed to get type hints for callback | cannot infer event type, please provide event_type explicitly"
        ) from e

    # Get the first parameter's type hint
    sig = inspect.signature(callback)
    params = list(sig.parameters.values())

    if not params:
        raise ValueError("callback has no parameters | cannot infer event type, please provide event_type explicitly")

    # Skip 'self' and 'cls' parameters for methods
    first_param = params[0]
    if first_param.name in ("self", "cls") and len(params) > 1:
        first_param = params[1]

    type_hint = hints.get(first_param.name)

    if type_hint is None:
        raise ValueError(
            f"parameter=<{first_param.name}> has no type hint | "
            "cannot infer event type, please provide event_type explicitly"
        )

    # Check if it's a Union type (Union[A, B] or A | B)
    origin = get_origin(type_hint)
    if origin is Union or origin is types.UnionType:
        event_types: list[type[TEvent]] = []
        for arg in get_args(type_hint):
            if arg is type(None):
                raise ValueError("None is not a valid event type in union")
            event_type = _normalize_event_type(arg)
            if event_type is None or not issubclass(event_type, BaseHookEvent):
                raise ValueError(f"Invalid type in union: {arg} | must be a subclass of BaseHookEvent")
            event_types.append(cast("type[TEvent]", event_type))
        return event_types

    # Handle single type
    event_type = _normalize_event_type(type_hint)
    if event_type is not None and issubclass(event_type, BaseHookEvent):
        return [cast("type[TEvent]", event_type)]

    raise ValueError(
        f"parameter=<{first_param.name}>, type=<{type_hint}> | type hint must be a subclass of BaseHookEvent"
    )
