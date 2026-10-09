"""Middleware system for wrapping agent stages.

Middleware wraps the core stages of an agent run (model invocation and tool execution) with
composable handlers that can transform inputs, transform results, or wrap execution to retry,
cache, short-circuit, or gate behind a human-in-the-loop interrupt. Register handlers with
``agent.add_middleware(stage_or_phase, handler)``.

Each stage exposes three phases that run in a fixed order (Input -> Wrap -> Output), independent
of registration order:

- ``Input`` transforms the context before execution.
- ``Wrap`` (the bare stage token) wraps the whole operation and calls ``next_fn`` itself.
- ``Output`` transforms the result after execution.

Example:
    ```python
    from strands import Agent
    from strands.middleware import InvokeModelStage

    agent = Agent()

    async def timing(context, next_fn):
        async for event in next_fn(context):
            yield event

    agent.add_middleware(InvokeModelStage, timing)
    ```
"""

from ..types._events import ModelStopReason, ToolResultEvent, TypedEvent
from .stages import (
    ExecuteToolContext,
    ExecuteToolResult,
    ExecuteToolStage,
    InvokeModelContext,
    InvokeModelResult,
    InvokeModelStage,
    MiddlewareInterruptResult,
)
from .types import (
    MiddlewareHandler,
    MiddlewareInputHandler,
    MiddlewareInputPhase,
    MiddlewareNext,
    MiddlewareOutputHandler,
    MiddlewareOutputPhase,
    MiddlewareStage,
    MiddlewareWrapPhase,
)

# AgentStreamStage, AgentStreamContext and AgentStreamResult live in the private _agent_stream
# module until their context contract is finalized.
__all__ = [
    "ExecuteToolContext",
    "ExecuteToolResult",
    "ExecuteToolStage",
    "InvokeModelContext",
    "InvokeModelResult",
    "InvokeModelStage",
    "MiddlewareHandler",
    "MiddlewareInputHandler",
    "MiddlewareInputPhase",
    "MiddlewareInterruptResult",
    "MiddlewareNext",
    "MiddlewareOutputHandler",
    "MiddlewareOutputPhase",
    "MiddlewareStage",
    "MiddlewareWrapPhase",
    "ModelStopReason",
    "ToolResultEvent",
    "TypedEvent",
]
