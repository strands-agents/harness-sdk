"""Multi-agent hook events.

Deprecated: Use strands.hooks.multiagent instead.
"""

from .events import (
    AfterMultiAgentInvocationEvent,
    AfterNodeCallEvent,
    BeforeMultiAgentInvocationEvent,
    BeforeNodeCallEvent,
    MultiAgentInitializedEvent,
)

__all__ = [
    "AfterMultiAgentInvocationEvent",
    "AfterNodeCallEvent",
    "BeforeMultiAgentInvocationEvent",
    "BeforeNodeCallEvent",
    "MultiAgentInitializedEvent",
]
