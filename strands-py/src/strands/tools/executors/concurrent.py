"""Concurrent tool executor implementation."""

import asyncio
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING, Any

from typing_extensions import override

from ...telemetry.metrics import Trace
from ...types._events import TypedEvent
from ...types.tools import ToolResult, ToolUse
from ._executor import ToolExecutor

if TYPE_CHECKING:  # pragma: no cover
    from ...agent import Agent
    from ...experimental.bidi import BidiAgent
    from ..structured_output._structured_output_context import StructuredOutputContext


class ConcurrentToolExecutor(ToolExecutor):
    """Concurrent tool executor."""

    @override
    async def _execute(
        self,
        agent: "Agent | BidiAgent",
        tool_uses: list[ToolUse],
        tool_results: list[ToolResult],
        cycle_trace: Trace | None,
        cycle_span: Any,
        invocation_state: dict[str, Any],
        structured_output_context: "StructuredOutputContext | None" = None,
    ) -> AsyncGenerator[TypedEvent, None]:
        """Execute tools concurrently.

        Args:
            agent: The agent for which tools are being executed.
            tool_uses: Metadata and inputs for the tools to be executed.
            tool_results: List of tool results from each tool execution.
            cycle_trace: Trace object for the current event loop cycle, if available.
            cycle_span: Span object for tracing the cycle.
            invocation_state: Context for the tool invocation.
            structured_output_context: Context for structured output handling.

        Yields:
            Events from the tool execution stream.
        """
        task_queue: asyncio.Queue[tuple[int, Any]] = asyncio.Queue()
        task_events = [asyncio.Event() for _ in tool_uses]
        task_results: list[list[ToolResult]] = [[] for _ in tool_uses]
        stop_event = object()

        tasks = []
        try:
            for task_id, tool_use in enumerate(tool_uses):
                tasks.append(
                    asyncio.create_task(
                        self._task(
                            agent,
                            tool_use,
                            task_results[task_id],
                            cycle_trace,
                            cycle_span,
                            invocation_state,
                            task_id,
                            task_queue,
                            task_events[task_id],
                            stop_event,
                            structured_output_context,
                        )
                    )
                )

            task_count = len(tasks)
            while task_count:
                task_id, event = await task_queue.get()
                if event is stop_event:
                    task_count -= 1
                    continue

                if isinstance(event, Exception):
                    raise event

                yield event
                task_events[task_id].set()
            for results in task_results:
                tool_results.extend(results)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _task(
        self,
        agent: "Agent | BidiAgent",
        tool_use: ToolUse,
        tool_results: list[ToolResult],
        cycle_trace: Trace | None,
        cycle_span: Any,
        invocation_state: dict[str, Any],
        task_id: int,
        task_queue: asyncio.Queue,
        task_event: asyncio.Event,
        stop_event: object,
        structured_output_context: "StructuredOutputContext | None",
    ) -> None:
        """Execute a single tool and put results in the task queue.

        Args:
            agent: The agent executing the tool.
            tool_use: Tool use metadata and inputs.
            tool_results: List of tool results from each tool execution.
            cycle_trace: Trace object for the current event loop cycle, if available.
            cycle_span: Span object for tracing the cycle.
            invocation_state: Context for tool execution.
            task_id: Unique identifier for this task.
            task_queue: Queue to put tool events into.
            task_event: Event to signal when task can continue.
            stop_event: Sentinel object to signal task completion.
            structured_output_context: Context for structured output handling.
        """
        try:
            events = ToolExecutor._stream_with_trace(
                agent, tool_use, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
            )
            async for event in events:
                task_queue.put_nowait((task_id, event))
                await task_event.wait()
                task_event.clear()

        except Exception as e:
            task_queue.put_nowait((task_id, e))

        finally:
            task_queue.put_nowait((task_id, stop_event))
