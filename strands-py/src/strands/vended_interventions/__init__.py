"""Vended intervention handlers for Strands agents.

Ready-to-use InterventionHandler implementations for common control patterns.
"""

from .hitl import HumanInTheLoop

__all__ = ["CedarAuthorization", "HumanInTheLoop"]


def __getattr__(name: str) -> type:
    if name == "CedarAuthorization":
        from .cedar import CedarAuthorization

        return CedarAuthorization
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
