"""Experimental hook functionality that has not yet reached stability."""

from typing import Any

from . import events

# Deprecated aliases are accessed via __getattr__ to emit warnings only on use


def __getattr__(name: str) -> Any:
    return getattr(events, name)


__all__ = [
    "BeforeToolInvocationEvent",
    "AfterToolInvocationEvent",
    "BeforeModelInvocationEvent",
    "AfterModelInvocationEvent",
]
