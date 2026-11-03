"""Decision-model primitive — see ``team/designs/0020-decision-models.md``."""

from typing import Any

from .decision_model import DecisionModel
from .llm_decision_model import LLMDecisionModel
from .types import (
    DecisionInput,
    DecisionMetadata,
    DecisionResult,
    Question,
    Uncertain,
    UncertaintyOptions,
)

__all__ = [
    "DecisionInput",
    "DecisionMetadata",
    "DecisionModel",
    "DecisionResult",
    "LLMDecisionModel",
    "Question",
    "Uncertain",
    "UncertaintyOptions",
]


def __getattr__(name: str) -> Any:
    """Lazy load provider-backed decision models only when accessed.

    This keeps ``import strands`` from importing ``httpx`` (and its optional dependencies) eagerly.
    """
    if name == "DecisionsAPIDecisionModel":
        from .decisions_api_decision_model import DecisionsAPIDecisionModel

        return DecisionsAPIDecisionModel
    if name == "TypeSafeDecisionModel":
        from .typesafe_decision_model import TypeSafeDecisionModel

        return TypeSafeDecisionModel
    raise AttributeError(f"cannot import name '{name}' from '{__name__}' ({__file__})")
