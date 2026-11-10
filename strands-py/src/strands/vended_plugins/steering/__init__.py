"""Steering system for Strands agents.

Provides contextual guidance for agents through modular prompting with progressive disclosure.
Instead of front-loading all instructions, steering handlers provide just-in-time feedback
based on local context data populated by context callbacks.

Core components:

- SteeringHandler: Base class for guidance logic with local context
- SteeringContextCallback: Protocol for context update functions
- SteeringContextProvider: Protocol for multi-event context providers
- ToolSteeringAction/ModelSteeringAction: Proceed/Guide/Interrupt decisions

Usage:
    handler = LLMSteeringHandler(system_prompt="...")
    agent = Agent(tools=[...], plugins=[handler])
"""

# Core primitives
# Context providers
from .context_providers.ledger_provider import (
    LedgerAfterToolCall,
    LedgerBeforeToolCall,
    LedgerProvider,
)
from .core.action import Guide, Interrupt, ModelSteeringAction, Proceed, ToolSteeringAction
from .core.context import SteeringContextCallback, SteeringContextProvider
from .core.handler import SteeringHandler

# Handler implementations
from .handlers.llm import LLMPromptMapper, LLMSteeringHandler

__all__ = [
    "ToolSteeringAction",
    "ModelSteeringAction",
    "Proceed",
    "Guide",
    "Interrupt",
    "SteeringHandler",
    "SteeringContextCallback",
    "SteeringContextProvider",
    "LedgerBeforeToolCall",
    "LedgerAfterToolCall",
    "LedgerProvider",
    "LLMSteeringHandler",
    "LLMPromptMapper",
]
