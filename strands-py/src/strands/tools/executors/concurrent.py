"""Concurrent tool executor implementation."""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from typing import TYPE_CHECKING, Any

from typing_extensions import override

from ...telemetry.metrics import Trace
from ...types._events import ToolResultEvent, TypedEvent
from ...types.tools import ToolResult, ToolUse
from ._executor import ToolExecutor

if TYPE_CHECKING:  # pragma: no cover
    from ...agent import Agent
    from ..structured_output._structured_output_context import StructuredOutputContext

_CANCEL_POLL_INTERVAL_SECONDS = 0.05


def _cancellation_requested(agent: "Agent") -> bool:
    """Return True when the agent (or linked external signal) requested cancel."""
    observe = getattr(agent, "_observe_cancellation", None)
    if callable(observe):
        try:
            return bool(observe())
        except Exception:
            pass
    cancel_signal = getattr(agent, "_cancel_signal", None)
    return bool(cancel_signal is not None and cancel_signal.is_set())


def _cancelled_tool_result(tool_use: ToolUse) -> ToolResult:
    return {
        "toolUseId": str(tool_use.get("toolUseId")),
        "status": "error",
        "content": [{"text": "Tool execution cancelled"}],
    }


async def _wait_for_cancellation(agent: "Agent") -> None:
    """Block until the agent cancel signal is set."""
    while not _cancellation_requested(agent):
        await asyncio.sleep(_CANCEL_POLL_INTERVAL_SECONDS)


async def _next_event_or_cancel(
    iterator: AsyncIterator[Any],
    agent: "Agent",
) -> Any:
    """Return the next iterator item, or None when cancel wins first."""
    next_task = asyncio.create_task(iterator.__anext__())  # type: ignore[arg-type]
    cancel_task = asyncio.create_task(_wait_for_cancellation(agent))
    try:
        done, pending = await asyncio.wait(
            {next_task, cancel_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        if cancel_task in done and not cancel_task.cancelled():
            raise asyncio.CancelledError()

        try:
            return next_task.result()
        except StopAsyncIteration:
            return None
    except asyncio.CancelledError:
        next_task.cancel()
        cancel_task.cancel()
        await asyncio.gather(next_task, cancel_task, return_exceptions=True)
        raise


class ConcurrentToolExecutor(ToolExecutor):
    """Concurrent tool executor."""

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
        """Execute tools concurrently.

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
        task_queue: asyncio.Queue[tuple[int, Any]] = asyncio.Queue()
        task_events = [asyncio.Event() for _ in tool_uses]
        task_results: list[list[ToolResult]] = [[] for _ in tool_uses]
        stop_event = object()
        cancelled = False

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
                queue_get = asyncio.create_task(task_queue.get())
                cancel_wait = asyncio.create_task(_wait_for_cancellation(agent))
                done, pending = await asyncio.wait(
                    {queue_get, cancel_wait},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)

                if cancel_wait in done and not cancel_wait.cancelled():
                    cancelled = True
                    break

                task_id, event = queue_get.result()
                if event is stop_event:
                    task_count -= 1
                    continue

                if isinstance(event, Exception):
                    raise event

                yield event
                task_events[task_id].set()

            if cancelled:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

                # Drain any events tasks queued before they observed cancellation.
                while not task_queue.empty():
                    try:
                        task_id, event = task_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    if event is stop_event or isinstance(event, Exception):
                        continue
                    if isinstance(event, ToolResultEvent):
                        yield event
                        result = event.tool_result
                        if result not in task_results[task_id]:
                            task_results[task_id].append(result)

                for task_id, tool_use in enumerate(tool_uses):
                    if task_results[task_id]:
                        for result in task_results[task_id]:
                            if result not in tool_results:
                                tool_results.append(result)
                        continue
                    cancel_result = _cancelled_tool_result(tool_use)
                    task_results[task_id].append(cancel_result)
                    tool_results.append(cancel_result)
                    yield ToolResultEvent(cancel_result)
                return

            for results in task_results:
                tool_results.extend(results)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    async def _task(
        self,
        agent: "Agent",
        tool_use: ToolUse,
        tool_results: list[ToolResult],
        cycle_trace: Trace,
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
            cycle_trace: Trace object for the current event loop cycle.
            cycle_span: Span object for tracing the cycle.
            invocation_state: Context for tool execution.
            task_id: Unique identifier for this task.
            task_queue: Queue to put tool events into.
            task_event: Event to signal when task can continue.
            stop_event: Sentinel object to signal task completion.
            structured_output_context: Context for structured output handling.
        """
        try:
            if _cancellation_requested(agent):
                cancel_result = _cancelled_tool_result(tool_use)
                tool_results.append(cancel_result)
                task_queue.put_nowait((task_id, ToolResultEvent(cancel_result)))
                await task_event.wait()
                task_event.clear()
                return

            events = ToolExecutor._stream_with_trace(
                agent, tool_use, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
            )
            iterator = events.__aiter__()
            while True:
                try:
                    event = await _next_event_or_cancel(iterator, agent)
                except asyncio.CancelledError:
                    cancel_result = _cancelled_tool_result(tool_use)
                    if not tool_results:
                        tool_results.append(cancel_result)
                        task_queue.put_nowait((task_id, ToolResultEvent(cancel_result)))
                        # Best-effort unblock the main loop if it is waiting on us.
                        task_event.set()
                    raise

                if event is None:
                    break

                task_queue.put_nowait((task_id, event))
                wait_task = asyncio.create_task(task_event.wait())
                cancel_task = asyncio.create_task(_wait_for_cancellation(agent))
                done, pending = await asyncio.wait(
                    {wait_task, cancel_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)

                if cancel_task in done and not cancel_task.cancelled():
                    cancel_result = _cancelled_tool_result(tool_use)
                    if not any(r.get("toolUseId") == cancel_result["toolUseId"] for r in tool_results):
                        # Prefer a cancel result when the stream has not finished.
                        if not tool_results:
                            tool_results.append(cancel_result)
                    raise asyncio.CancelledError()

                task_event.clear()

        except asyncio.CancelledError:
            cancel_result = _cancelled_tool_result(tool_use)
            if not tool_results:
                tool_results.append(cancel_result)
                task_queue.put_nowait((task_id, ToolResultEvent(cancel_result)))
                task_event.set()

        except Exception as e:
            task_queue.put_nowait((task_id, e))

        finally:
            task_queue.put_nowait((task_id, stop_event))
