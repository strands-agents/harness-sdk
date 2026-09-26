"""System One decision models: typed, calibrated decisions as a first-class primitive.

A ``Model`` generates; a ``DecisionModel`` decides. Declare questions as a Pydantic schema (or ``Choice`` /
``Score`` / ``YesNo`` objects), ask them together about some state, and get typed answers with probabilities.

Experimental: subject to change without notice. See ``team/designs/0020-system-one-decision-models.md``.
"""

from ...models._request_text import project_state
from ._agent import DECISION_STATE_KEY, DecisionAgent
from ._graph import DecisionEdgeCondition, when_below, when_choice, when_yes
from ._guard import DecisionGuard, decision_classifier
from ._llm import LLMDecisionModel
from ._model import DecisionModel
from ._schema import CompiledSchema, compile_schema
from ._strategy import DecisionStrategy
from ._tool import DecisionTool, decision_tool
from ._types import (
    Answer,
    Choice,
    ChoiceAnswer,
    Decision,
    DecisionResponse,
    DecisionState,
    Question,
    Score,
    ScoreAnswer,
    YesNo,
    YesNoAnswer,
    yes_no_confidence,
)

__all__ = [
    "DECISION_STATE_KEY",
    "Answer",
    "Choice",
    "ChoiceAnswer",
    "CompiledSchema",
    "Decision",
    "DecisionAgent",
    "DecisionEdgeCondition",
    "DecisionGuard",
    "DecisionModel",
    "DecisionResponse",
    "DecisionState",
    "DecisionStrategy",
    "DecisionTool",
    "LLMDecisionModel",
    "Question",
    "Score",
    "ScoreAnswer",
    "YesNo",
    "YesNoAnswer",
    "compile_schema",
    "decision_classifier",
    "decision_tool",
    "project_state",
    "when_below",
    "when_choice",
    "when_yes",
    "yes_no_confidence",
]
