"""Multi-agent execution lifecycle events for hook system integration.

Deprecated: Use strands.hooks.multiagent instead.
"""

import warnings

from ....hooks import (
    AfterMultiAgentInvocationEvent,
    AfterNodeCallEvent,
    BeforeMultiAgentInvocationEvent,
    BeforeNodeCallEvent,
    MultiAgentInitializedEvent,
)

warnings.warn(
    "strands.experimental.hooks.multiagent is deprecated. Use strands.hooks instead.",
    DeprecationWarning,
    stacklevel=2,
)

__all__ = [
    "AfterMultiAgentInvocationEvent",
    "AfterNodeCallEvent",
    "BeforeMultiAgentInvocationEvent",
    "BeforeNodeCallEvent",
    "MultiAgentInitializedEvent",
]
