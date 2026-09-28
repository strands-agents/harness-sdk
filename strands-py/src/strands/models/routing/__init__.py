"""Model routing primitives.

``ModelRouter`` asks its ``RoutingStrategy`` which candidate to use, and asks again after a failed
call, so the strategy owns every routing decision and the router only orchestrates. Declining with
``None`` at the opening choice serves the request on the router's default model; declining after a
failure ends routing and lets the model's error surface. The default ``FallbackStrategy`` prefers the
candidate with the fewest recorded failures, breaking ties by declaration order, and re-arms a candidate
once a later call succeeds. The API is provisional and may change before it is finalized.
"""

from .classifier_strategy import ClassifierStrategy
from .fallback_strategy import FallbackStrategy
from .router import CandidateInput, ModelRouter, RoutingCandidate
from .strategy import RoutingAttempt, RoutingContext, RoutingStrategy

__all__ = [
    "CandidateInput",
    "ClassifierStrategy",
    "FallbackStrategy",
    "ModelRouter",
    "RoutingAttempt",
    "RoutingCandidate",
    "RoutingContext",
    "RoutingStrategy",
]
