"""Sequential tool executor implementation."""

from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING, Any

from typing_extensions import override

from ...telemetry.metrics import Trace
from ...types._events import ToolInterruptEvent, ToolResultEvent, TypedEvent
from ...types.tools import ToolResult, ToolUse
from ._executor import ToolExecutor

if TYPE_CHECKING:  # pragma: no cover
    from ...agent import Agent
    from ..structured_output._structured_output_context import StructuredOutputContext


class SequentialToolExecutor(ToolExecutor):
    """Sequential tool executor."""

    @override
    async def _execute(
        self,
        agent: "Agent",
        tool_uses: list[ToolUse],
        tool_results: list[ToolResult],
        cycle_trace: Trace,
        cycle_span: Any,
        invocation_state: dict[str, Any],
        structured_output_context: "StructuredOutputContext | None" = None,
    ) -> AsyncGenerator[TypedEvent, None]:
        """Execute tools sequentially.

        Breaks early if an interrupt is raised by the user.

        Args:
            agent: The agent for which tools are being executed.
            tool_uses: Metadata and inputs for the tools to be executed.
            tool_results: List of tool results from each tool execution.
            cycle_trace: Trace object for the current event loop cycle.
            cycle_span: Span object for tracing the cycle.
            invocation_state: Context for the tool invocation.
            structured_output_context: Context for structured output handling.

        Yields:
            Events from the tool execution stream.
        """
        interrupted = False

        for tool_use in tool_uses:
            if agent._observe_cancellation():
                cancel_result: ToolResult = {
                    "toolUseId": str(tool_use.get("toolUseId")),
                    "status": "error",
                    "content": [{"text": "Tool execution cancelled"}],
                }
                tool_results.append(cancel_result)
                yield ToolResultEvent(cancel_result)
                continue

            events = ToolExecutor._stream_with_trace(
                agent, tool_use, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
            )
            async for event in events:
                if isinstance(event, ToolInterruptEvent):
                    interrupted = True

                yield event

            if interrupted:
                break
