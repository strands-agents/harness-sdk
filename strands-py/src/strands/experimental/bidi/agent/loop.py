"""Agent loop.

The agent loop handles the events received from the model and executes tools when given a tool use request.
"""

import asyncio
import logging
import time
import warnings
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from opentelemetry.trace import Span

from ....hooks import AfterToolsEvent, BeforeToolsEvent
from ....telemetry.tracer import get_tracer
from ....tools._validator import validate_and_prepare_tools
from ....types._events import ToolInterruptEvent, ToolResultEvent, ToolResultMessageEvent
from ....types.content import ContentBlock, Message
from ....types.tools import ToolResult, ToolUse
from .. import _telemetry
from .._async import _TaskPool, stop_all
from ..hooks.events import (
    BidiAfterConnectionRestartEvent,
    BidiAgentStopEvent,
    BidiBeforeConnectionRestartEvent,
)
from ..hooks.events import (
    BidiInterruptionEvent as BidiInterruptionHookEvent,
)
from ..hooks.events import (
    BidiResponseCompleteEvent as BidiResponseCompleteHookEvent,
)
from ..models import BidiModelTimeoutError, Restartable
from ..types.events import (
    BidiAudioStreamEvent,
    BidiConnectionCloseEvent,
    BidiConnectionRestartEvent,
    BidiConnectionWarningEvent,
    BidiInputEvent,
    BidiInterruptionEvent,
    BidiOutputEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiToolUsesCompleteEvent,
    BidiTranscriptCompleteEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
)
from ._reconnect_timer import BidiReconnectTimer, resolve_deadline_s

if TYPE_CHECKING:
    from .agent import BidiAgent

logger = logging.getLogger(__name__)

# Bound on awaiting a superseded reader after its stream is closed before cancelling it.
_MODEL_RESTART_STOP_TIMEOUT_S = 2

# Fixed advance notice, in seconds before a scheduled reconnect, for the warning event.
_MODEL_RESTART_WARNING_S = 10

# Max seconds a proactive reconnect waits for a turn boundary before forcing the swap.
_MODEL_RESTART_TURN_TIMEOUT_S = 10


@dataclass(frozen=True)
class _ReaderError:
    """A model-reader error tagged with the connection generation it was raised on.

    receive() uses the tag to drop the error if the connection was superseded before it was
    consumed.
    """

    generation: int
    error: Exception


class _BidiAgentLoop:
    """Agent loop.

    Attributes:
        _agent: BidiAgent instance to loop.
        _started: Flag if agent loop has started.
        _task_pool: Track active async tasks created in loop.
        _event_queue: Queue output and connection lifecycle events for receiver.
        _invocation_state: Optional context to pass to tools during execution.
            This allows passing custom data (user_id, session_id, database connections, etc.)
            that tools can access via their invocation_state parameter.
        _send_gate: Gate the sending of events to the model.
            Blocks while the agent is reconnecting the model connection.
    """

    def __init__(self, agent: "BidiAgent") -> None:
        """Initialize members of the agent loop.

        Note, before receiving events from the loop, the user must call `start`.

        Args:
            agent: Bidirectional agent to loop over.
        """
        self._agent = agent
        self._started = False
        self._task_pool = _TaskPool()
        self._event_queue: asyncio.Queue
        self._invocation_state: dict[str, Any]
        self._model_task: asyncio.Task | None = None

        self._send_gate = asyncio.Event()

        self._tracer = get_tracer()
        self._session_span: Span | None = None

        # Session totals = baseline (finished connections) + current (this connection).
        self._current_input_tokens = 0
        self._current_output_tokens = 0
        self._current_total_tokens = 0
        self._current_cache_read_tokens = 0
        self._baseline_input_tokens = 0
        self._baseline_output_tokens = 0
        self._baseline_total_tokens = 0
        self._baseline_cache_read_tokens = 0

        self._reconnect_timer = BidiReconnectTimer(
            on_warning=self._on_reconnect_warning,
            on_deadline=self._on_reconnect_deadline,
        )
        # Guards _restart_connection against concurrent reactive + proactive entry.
        self._reconnecting = False
        # Incremented per reconnect so a superseded reader's events (and its stream-close
        # error) are dropped rather than forwarded after the swap.
        self._generation = 0

        # Tool use IDs are connection-scoped. Keep admitted IDs for the current generation
        # so a duplicate completion event cannot execute the same call twice.
        self._admitted_tool_use_ids: dict[int, set[str]] = {}
        self._tool_batches_in_flight = 0

        # Turn-boundary tracking, so a proactive reconnect waits for the current turn to
        # finish rather than cutting off a response or dropping an unanswered user turn.
        # A provider that emits neither response nor transcript events never leaves the
        # boundary state, so the aligned wait is a no-op (reconnect fires immediately).
        self._response_active = False
        self._awaiting_response = False
        self._turn_complete = asyncio.Event()
        self._turn_complete.set()

    async def start(self, invocation_state: dict[str, Any] | None = None) -> None:
        """Start the agent loop.

        The agent model is started as part of this call.

        Args:
            invocation_state: Optional context to pass to tools during execution.
                This allows passing custom data (user_id, session_id, database connections, etc.)
                that tools can access via their invocation_state parameter.

        Raises:
            RuntimeError: If loop already started.
        """
        if self._started:
            raise RuntimeError("loop already started | call stop before starting again")

        logger.debug("agent loop starting")
        model_id = getattr(self._agent.model, "model_id", None)

        self._session_span = _telemetry.start_session_span(
            self._tracer,
            agent_name=self._agent.name,
            model_id=model_id,
            tools=self._agent.tool_names,
            system_prompt=self._agent.system_prompt,
        )

        connection_span = _telemetry.start_connection_span(
            self._tracer, parent_span=self._session_span, model_id=model_id
        )
        try:
            await self._agent.model.start(
                system_prompt=self._agent.system_prompt,
                tools=self._agent.tool_registry.get_all_tool_specs(),
                messages=self._agent.messages,
            )
        except Exception as error:
            _telemetry.end_connection_span(self._tracer, connection_span, error=error)
            _telemetry.end_session_span(self._tracer, self._session_span, error=error)
            self._session_span = None
            raise
        _telemetry.end_connection_span(self._tracer, connection_span)
        self._reset_token_tracking()
        self._admitted_tool_use_ids.clear()
        self._tool_batches_in_flight = 0
        self._reset_turn_state()

        self._event_queue = asyncio.Queue(maxsize=1)

        self._task_pool = _TaskPool()
        self._model_task = self._task_pool.create(self._run_model(self._generation))

        self._invocation_state = invocation_state if invocation_state is not None else {}
        self._send_gate.set()
        self._started = True

        self._arm_reconnect_timer()

    async def stop(self) -> None:
        """Stop the agent loop."""
        logger.debug("agent loop stopping")

        self._started = False
        self._send_gate.clear()
        self._reconnect_timer.cancel()
        # Unblock a deadline callback waiting on a turn boundary (it is past the timer's cancel);
        # once released it re-checks _started and no-ops.
        self._turn_complete.set()
        self._invocation_state = {}

        async def stop_tasks() -> None:
            await self._task_pool.cancel()

        async def stop_model() -> None:
            await self._agent.model.stop()

        try:
            await stop_all(stop_tasks, stop_model)
        finally:
            if self._session_span:
                _telemetry.end_session_span(
                    self._tracer,
                    self._session_span,
                    input_tokens=self._accumulated_input_tokens,
                    output_tokens=self._accumulated_output_tokens,
                    total_tokens=self._accumulated_total_tokens,
                    cache_read_input_tokens=self._accumulated_cache_read_tokens,
                )
                self._session_span = None

            await self._agent.hooks.invoke_callbacks_async(BidiAgentStopEvent(agent=self._agent))

    async def send(self, event: BidiInputEvent) -> None:
        """Send model event.

        Additionally, add text input to messages array.

        Args:
            event: User input event or tool result.

        Raises:
            RuntimeError: If start has not been called.
        """
        if not self._started:
            raise RuntimeError("loop not started | call start before sending")

        if not self._send_gate.is_set():
            logger.debug("waiting for model send signal")
            await self._send_gate.wait()

        if isinstance(event, BidiTextInputEvent):
            message: Message = {"role": event.role, "content": [{"text": event.text}]}
            await self._agent._append_messages(message)
            if event.role == "user":
                # A user text turn owes a response, same as a finished audio turn. Mark it so a
                # proactive reconnect waits for the reply instead of swapping mid-turn; without
                # this, a text-driven session always looks idle and the turn can be cut.
                self._awaiting_response = True
                self._update_turn_state()

        await self._agent.model.send(event)

    async def receive(self) -> AsyncGenerator[BidiOutputEvent, None]:
        """Receive model and tool call events.

        Yields:
            Model and tool call events.

        Raises:
            RuntimeError: If start has not been called.
        """
        if not self._started:
            raise RuntimeError("loop not started | call start before receiving")

        while True:
            event = await self._event_queue.get()
            if isinstance(event, _ReaderError):
                if event.generation != self._generation:
                    # Superseded reader: its connection was already replaced, so drop the error
                    # rather than surface or restart on it.
                    logger.debug("dropping stale reader error from a superseded connection")
                    continue
                error = event.error
                if isinstance(error, BidiModelTimeoutError):
                    logger.debug("model timeout error received")
                    if not self._auto_reconnect_enabled():
                        logger.debug("auto_reconnect disabled | surfacing timeout to caller")
                        raise error
                    restart_event = BidiConnectionRestartEvent(
                        reason="timeout",
                        timeout_error=error,
                        turn_interrupted=not self._turn_complete.is_set(),
                    )
                    try:
                        await self._restart_connection(
                            error,
                            event.generation,
                            restart_event=restart_event,
                        )
                    except Exception:
                        # The restart event was queued before the failing swap. Surface it before
                        # preserving the existing behavior of raising the restart failure.
                        yield self._event_queue.get_nowait()
                        raise
                    continue
                raise error

            if isinstance(event, Exception):
                raise event

            # Check for graceful shutdown event
            if isinstance(event, BidiConnectionCloseEvent) and event.reason in {"complete", "user_request"}:
                yield event
                break

            yield event

    def _auto_reconnect_enabled(self) -> bool:
        """Whether the agent reconnects automatically.

        Automatic reconnect is the default: a provider is opted in unless it explicitly
        declares ``auto_reconnect: False`` in its connection config.
        """
        return self._agent.model.get_connection_config().get("auto_reconnect", True)

    def _arm_reconnect_timer(self) -> None:
        """Arm the proactive reconnect timer when the model opts in with a declared deadline.

        Owns the arming policy (auto_reconnect + a declared ``restart_after_s``); the timer
        itself is a pure mechanism. A no-op when reconnect is disabled or none is declared.
        """
        if not self._auto_reconnect_enabled():
            return
        deadline_s = resolve_deadline_s(self._agent.model.get_connection_config())
        if deadline_s is None:
            return
        self._reconnect_timer.arm(deadline_s, _MODEL_RESTART_WARNING_S)

    async def _on_reconnect_warning(self, time_left_s: int) -> None:
        """Timer callback: surface an approaching-reconnect warning to the receiver."""
        logger.debug("time_left_s=<%.1f> | emitting connection warning", time_left_s)
        await self._event_queue.put(BidiConnectionWarningEvent(time_left_s=time_left_s))

    async def _on_reconnect_deadline(self) -> None:
        """Timer callback: align to a turn boundary, then reconnect proactively.

        Waits (bounded) for the current turn to finish so the swap does not cut off a
        response or drop an unanswered user turn; surfaces any failure on the event queue.
        """
        logger.debug("proactive reconnect deadline reached")
        # Capture before the wait so _restart_connection can decline if the loop stopped or a
        # reactive swap ran while we waited.
        generation = self._generation
        await self._await_turn_boundary()
        # A forced swap (the wait timed out) leaves _turn_complete clear: an in-progress or owed
        # turn is being cut and won't be answered on replay. Capture before the swap resets it.
        turn_interrupted = not self._turn_complete.is_set()
        restart_event = BidiConnectionRestartEvent(reason="scheduled", turn_interrupted=turn_interrupted)
        try:
            await self._restart_connection(None, generation, restart_event=restart_event)
        except Exception as error:
            await self._event_queue.put(error)

    async def _await_turn_boundary(self) -> None:
        """Wait for the current turn to finish, bounded so the reconnect beats the limit.

        Returns immediately at a turn boundary (including for a provider that emits no turn
        events). Otherwise waits up to ``_MODEL_RESTART_TURN_TIMEOUT_S`` for the turn to complete, then
        proceeds so the swap does not overrun the headroom below the provider limit.
        """
        if self._turn_complete.is_set():
            return
        try:
            await asyncio.wait_for(self._turn_complete.wait(), timeout=_MODEL_RESTART_TURN_TIMEOUT_S)
        except asyncio.TimeoutError:
            logger.debug(
                "no turn boundary within %.1fs | forcing reconnect",
                _MODEL_RESTART_TURN_TIMEOUT_S,
            )

    def _reset_turn_state(self) -> None:
        """Reset provider response state without discarding active tool work."""
        self._response_active = False
        self._awaiting_response = False
        self._update_turn_state()

    def _update_turn_state(self) -> None:
        """Mark the turn complete only when no response or tool work remains."""
        if self._response_active or self._awaiting_response or self._tool_batches_in_flight:
            self._turn_complete.clear()
        else:
            self._turn_complete.set()

    def _reserve_tool_use_ids(self, tool_uses: list[ToolUse], generation: int) -> None:
        """Reserve tool use IDs once for the connection generation that issued them."""
        if generation != self._generation:
            raise RuntimeError(
                f"tool_generation=<{generation}>, current_generation=<{self._generation}>"
                " | cannot admit tool uses from a superseded connection"
            )

        self._discard_obsolete_tool_admissions()
        admitted = self._admitted_tool_use_ids.setdefault(generation, set())
        duplicate_ids: set[str] = set()
        pending_ids: set[str] = set()
        for tool_use in tool_uses:
            tool_use_id = tool_use["toolUseId"]
            if tool_use_id in admitted or tool_use_id in pending_ids:
                duplicate_ids.add(tool_use_id)
            pending_ids.add(tool_use_id)

        if duplicate_ids:
            duplicates = ", ".join(sorted(duplicate_ids))
            raise ValueError(f"tool_use_ids=<[{duplicates}]> | tool uses already admitted")

        admitted.update(pending_ids)

    def _discard_obsolete_tool_admissions(self) -> None:
        """Discard reservations from superseded connection generations."""
        admitted = self._admitted_tool_use_ids.get(self._generation)
        self._admitted_tool_use_ids.clear()
        if admitted is not None:
            self._admitted_tool_use_ids[self._generation] = admitted

    def _begin_tool_batch(self) -> None:
        """Hold the turn boundary while a tool batch is active."""
        self._tool_batches_in_flight += 1
        self._update_turn_state()

    def _end_tool_batch(self) -> None:
        """Release one active tool batch and update the turn boundary."""
        if self._tool_batches_in_flight == 0:
            raise RuntimeError("tool batch accounting underflow")
        self._tool_batches_in_flight -= 1
        self._update_turn_state()

    async def _restart_connection(
        self,
        timeout_error: BidiModelTimeoutError | None,
        generation: int,
        *,
        restart_event: BidiConnectionRestartEvent | None = None,
    ) -> bool:
        """Restart the model connection, reactively (after timeout) or proactively (timer).

        The single guard point for both paths: declines when the loop has stopped, when the
        connection was already swapped since the trigger, or when a restart is in flight. A
        supplied restart event is emitted after these checks and before the connection is swapped.

        Args:
            timeout_error: Timeout error on the reactive path, or ``None`` when proactive.
            generation: Connection generation the trigger was raised for; the restart is declined
                as stale if the connection has since been swapped.
            restart_event: Restart event to emit before an accepted swap.

        Returns:
            ``True`` if this call performed the swap, ``False`` if it declined. Raises if the
            swap itself fails.
        """
        if not self._started:
            logger.debug("loop stopped | ignoring reconnect trigger")
            return False
        if generation != self._generation:
            logger.debug(
                "trigger_generation=<%d>, current_generation=<%d> | connection already swapped | ignoring restart",
                generation,
                self._generation,
            )
            return False
        if self._reconnecting:
            logger.debug("reconnect already in progress | ignoring duplicate trigger")
            return False
        self._reconnecting = True
        self._reconnect_timer.cancel()

        reason: Literal["timeout", "scheduled"] = "timeout" if timeout_error is not None else "scheduled"
        logger.debug("reason=<%s> | resetting model connection", reason)

        try:
            self._send_gate.clear()
            if restart_event is not None:
                await self._event_queue.put(restart_event)
                if not self._started:
                    # stop() can run while the bounded queue put is suspended.
                    logger.debug(  # type: ignore[unreachable]
                        "loop stopped while emitting restart event | ignoring restart trigger"
                    )
                    return False
            self._fold_token_baseline()

            # A raising before-restart hook propagates out with the send gate left closed.
            await self._agent.hooks.invoke_callbacks_async(
                BidiBeforeConnectionRestartEvent(self._agent, reason=reason, timeout_error=timeout_error)
            )
            await self._swap_connection(reason, timeout_error)

            self._reset_turn_state()
            self._arm_reconnect_timer()
            self._send_gate.set()
        finally:
            self._reconnecting = False

        return True

    async def _swap_connection(
        self, reason: Literal["timeout", "scheduled"], timeout_error: BidiModelTimeoutError | None
    ) -> None:
        """Swap to a new connection under a restart span, firing the after-restart hook.

        Supersedes the current reader (generation bump) so its stream-close error is fenced
        rather than forwarded, then reconnects and starts the new reader. A failed swap is
        re-raised after telemetry and the after-restart hook report it, leaving the gate closed.
        """
        restart_span = _telemetry.start_restart_span(
            self._tracer,
            parent_span=self._session_span,
            reason=reason,
            error_message=str(timeout_error) if timeout_error is not None else None,
        )

        restart_kwargs = timeout_error.restart_config if timeout_error is not None else {}
        restart_exception: Exception | None = None
        try:
            previous_reader = self._model_task
            self._generation += 1
            self._discard_obsolete_tool_admissions()
            await self._restart_model(restart_kwargs)
            await self._wait_for_model_task(previous_reader)
            self._model_task = self._task_pool.create(self._run_model(self._generation))
        except Exception as exception:
            restart_exception = exception
        finally:
            _telemetry.end_restart_span(self._tracer, restart_span, error=restart_exception)
            await self._agent.hooks.invoke_callbacks_async(
                BidiAfterConnectionRestartEvent(self._agent, reason=reason, exception=restart_exception)
            )

        if restart_exception is not None:
            raise restart_exception

    async def _restart_model(self, restart_kwargs: dict[str, Any]) -> None:
        """Restart through the provider when supported, otherwise use ``stop()`` then ``start()``."""
        model = self._agent.model
        system_prompt = self._agent.system_prompt
        tools = self._agent.tool_registry.get_all_tool_specs()
        messages = self._agent.messages

        if isinstance(model, Restartable):
            await model.restart(system_prompt, tools, messages, **restart_kwargs)
            return

        await model.stop()
        await model.start(system_prompt, tools, messages, **restart_kwargs)

    async def _wait_for_model_task(self, task: asyncio.Task | None) -> None:
        """Await a superseded reader after its stream is closed; cancel only as a backstop.

        The reader is expected to fall out of receive() when its connection is closed. It is
        awaited (not force-cancelled) so a live provider read is never interrupted; the
        bounded cancel handles a provider whose receive() does not unblock on close.
        """
        if task is None or task.done():
            return
        try:
            await asyncio.wait_for(task, timeout=_MODEL_RESTART_STOP_TIMEOUT_S)
        except Exception as error:
            # Expected: the reader's stream-close error, or the reap timeout. Logged, not
            # forwarded — the current reader is the only one that surfaces errors to the consumer.
            logger.debug("error=<%s> | superseded reader reaped", error)

    @property
    def _accumulated_input_tokens(self) -> int:
        return self._baseline_input_tokens + self._current_input_tokens

    @property
    def _accumulated_output_tokens(self) -> int:
        return self._baseline_output_tokens + self._current_output_tokens

    @property
    def _accumulated_total_tokens(self) -> int:
        return self._baseline_total_tokens + self._current_total_tokens

    @property
    def _accumulated_cache_read_tokens(self) -> int:
        return self._baseline_cache_read_tokens + self._current_cache_read_tokens

    def _reset_token_tracking(self) -> None:
        """Reset per-connection and baseline token tracking at session start."""
        self._current_input_tokens = 0
        self._current_output_tokens = 0
        self._current_total_tokens = 0
        self._current_cache_read_tokens = 0
        self._baseline_input_tokens = 0
        self._baseline_output_tokens = 0
        self._baseline_total_tokens = 0
        self._baseline_cache_read_tokens = 0

    def _fold_token_baseline(self) -> None:
        """Fold the current connection's token totals into the baseline before reconnect."""
        self._baseline_input_tokens += self._current_input_tokens
        self._baseline_output_tokens += self._current_output_tokens
        self._baseline_total_tokens += self._current_total_tokens
        self._baseline_cache_read_tokens += self._current_cache_read_tokens
        self._current_input_tokens = 0
        self._current_output_tokens = 0
        self._current_total_tokens = 0
        self._current_cache_read_tokens = 0

    def _record_usage(self, event: BidiUsageEvent) -> None:
        """Update the current connection's token counts from a usage event.

        Cumulative providers report a running total (replace); delta providers report
        per-response counts (add).
        """
        cache_read = event.cache_read_input_tokens or 0

        if getattr(self._agent.model, "usage_is_cumulative", False):
            self._current_input_tokens = event.input_tokens
            self._current_output_tokens = event.output_tokens
            self._current_total_tokens = event.total_tokens
            self._current_cache_read_tokens = cache_read
        else:
            self._current_input_tokens += event.input_tokens
            self._current_output_tokens += event.output_tokens
            self._current_total_tokens += event.total_tokens
            self._current_cache_read_tokens += cache_read

    async def _run_model(self, generation: int) -> None:
        """Task for running the model.

        Events are streamed through the event queue. Once superseded by a reconnect
        (``generation`` no longer current), the stream-close error and any further handling
        are dropped, so a closed old connection cannot mutate the new connection's state.
        """
        logger.debug("model task starting")

        response_span: Span | None = None
        response_start_time: float | None = None
        time_to_first_audio_ms: int | None = None
        model_error: Exception | None = None

        try:
            async for event in self._agent.model.receive():
                if generation != self._generation:
                    return

                if isinstance(event, BidiResponseStartEvent):
                    if response_span:
                        _telemetry.end_response_span(
                            self._tracer,
                            response_span,
                            stop_reason="interrupted",
                            time_to_first_audio_ms=time_to_first_audio_ms,
                        )
                    response_span = _telemetry.start_response_span(
                        self._tracer, event.response_id, parent_span=self._session_span
                    )
                    response_start_time = time.perf_counter()
                    time_to_first_audio_ms = None
                    self._response_active = True
                    self._awaiting_response = False
                    self._update_turn_state()

                elif isinstance(event, BidiAudioStreamEvent):
                    if response_start_time is not None and time_to_first_audio_ms is None:
                        time_to_first_audio_ms = int((time.perf_counter() - response_start_time) * 1000)

                elif isinstance(event, BidiResponseCompleteEvent):
                    if response_span:
                        _telemetry.end_response_span(
                            self._tracer,
                            response_span,
                            stop_reason=event.stop_reason,
                            time_to_first_audio_ms=time_to_first_audio_ms,
                        )
                        response_span = None
                    self._response_active = False
                    # A completed reply satisfies the user turn: clear the latch so a lagging user
                    # transcript arriving after completion does not re-open the turn.
                    self._awaiting_response = False
                    self._update_turn_state()
                    await self._agent.hooks.invoke_callbacks_async(
                        BidiResponseCompleteHookEvent(
                            agent=self._agent, response_id=event.response_id, stop_reason=event.stop_reason
                        )
                    )
                    if generation != self._generation:
                        return

                elif isinstance(event, BidiTranscriptStreamEvent):
                    if event["role"] == "user":
                        # Any user speech opens a turn that owes a model reply, so a proactive
                        # reconnect holds for the reply (or force-swaps, flagging turn_interrupted)
                        # instead of dropping a turn spoken near the deadline. Keyed on any user
                        # transcript, not just the final one: providers differ in whether they flag
                        # the final user transcript, and the reply is what clears this state.
                        self._awaiting_response = True
                        self._update_turn_state()

                elif isinstance(event, BidiTranscriptCompleteEvent):
                    message: Message = {"role": event.role, "content": [{"text": event.transcript}]}
                    await self._agent._append_messages(message)
                    if generation != self._generation:
                        return

                elif isinstance(event, BidiInterruptionEvent):
                    if self._session_span:
                        _telemetry.add_interruption_event(self._session_span, event["reason"])

                    # A barge-in ends the current response; the user's next turn owes a reply.
                    self._response_active = False
                    self._update_turn_state()
                    await self._agent.hooks.invoke_callbacks_async(
                        BidiInterruptionHookEvent(
                            agent=self._agent,
                            reason=event["reason"],
                            interrupted_response_id=event.get("interrupted_response_id"),
                        )
                    )
                    if generation != self._generation:
                        return

                elif isinstance(event, BidiUsageEvent):
                    self._record_usage(event)

                await self._event_queue.put(event)
                if generation != self._generation:
                    return

                if isinstance(event, BidiToolUsesCompleteEvent):
                    self._reserve_tool_use_ids(event.tool_uses, generation)
                    self._begin_tool_batch()
                    try:
                        self._task_pool.create(self._run_tools(event.message, generation))
                    except BaseException:
                        self._end_tool_batch()
                        raise

        except Exception as error:
            model_error = error
            # Tag with this reader's generation so receive() drops it if superseded. The put can
            # suspend on a full queue across a swap, which the pre-put check alone can't fence.
            if generation == self._generation:
                await self._event_queue.put(_ReaderError(generation, error))
        finally:
            if response_span:
                stop_reason = "error" if model_error else "incomplete"
                _telemetry.end_response_span(
                    self._tracer,
                    response_span,
                    stop_reason=stop_reason,
                    time_to_first_audio_ms=time_to_first_audio_ms,
                    error=model_error,
                )
                response_span = None

    async def _run_tools(self, message: Message, generation: int) -> None:
        """Run one complete provider-defined tool group.

        Args:
            message: Assistant message containing the complete tool-use group.
            generation: Connection generation that issued the group.
        """
        try:
            await self._run_tools_impl(message, generation)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self._event_queue.put(error)
        finally:
            self._end_tool_batch()

    async def _run_tools_impl(self, message: Message, generation: int) -> None:
        """Execute, record, and deliver one tool group."""
        tool_uses = BidiToolUsesCompleteEvent(message).tool_uses
        invocation_state = self._invocation_state
        invocation_state.setdefault("request_state", {})

        before_event, interrupts = await self._agent.hooks.invoke_callbacks_async(
            BeforeToolsEvent(agent=self._agent, message=message, invocation_state=invocation_state)
        )
        if interrupts:
            self._raise_unsupported_tool_interrupts(interrupts)

        tool_results: list[ToolResult] = []
        try:
            if before_event.cancel:
                tool_results.extend(self._build_cancelled_tool_results(tool_uses, before_event.cancel))
                for tool_result in tool_results:
                    await self._event_queue.put(ToolResultEvent(tool_result))
            else:
                validated_tool_uses: list[ToolUse] = []
                validation_results: list[ToolResult] = []
                invalid_tool_use_ids: list[str] = []
                validate_and_prepare_tools(
                    message,
                    validated_tool_uses,
                    validation_results,
                    invalid_tool_use_ids,
                )
                tool_results.extend(validation_results)
                executable_tool_uses = [
                    tool_use for tool_use in validated_tool_uses if tool_use["toolUseId"] not in invalid_tool_use_ids
                ]
                tool_events = self._agent.tool_executor._execute(
                    self._agent,
                    executable_tool_uses,
                    tool_results,
                    None,
                    self._session_span,
                    invocation_state,
                )
                async for tool_event in tool_events:
                    await self._event_queue.put(tool_event)
                    if isinstance(tool_event, ToolInterruptEvent):
                        self._raise_unsupported_tool_interrupts(tool_event.interrupts)
        finally:
            try:
                hook_message = self._build_tool_result_message(tool_uses, tool_results, require_complete=False)
            except (KeyError, TypeError, ValueError):
                hook_message = {
                    "role": "user",
                    "content": [{"toolResult": result} for result in tool_results],
                }
            after_event, _ = await self._agent.hooks.invoke_callbacks_async(
                AfterToolsEvent(agent=self._agent, message=hook_message, invocation_state=invocation_state)
            )

        tool_result_message = self._build_tool_result_message(tool_uses, tool_results, require_complete=True)
        await self._agent._append_messages(message, tool_result_message)
        await self._event_queue.put(ToolResultMessageEvent(tool_result_message))

        if after_event.end_turn:
            end_turn_message = self._build_end_turn_message(after_event.end_turn)
            await self._agent._append_messages(end_turn_message)
            connection_id = getattr(self._agent.model, "_connection_id", "unknown")
            await self._event_queue.put(BidiConnectionCloseEvent(connection_id=connection_id, reason="complete"))
            return

        if self._should_stop_after_tools(tool_uses, invocation_state):
            connection_id = getattr(self._agent.model, "_connection_id", "unknown")
            await self._event_queue.put(BidiConnectionCloseEvent(connection_id=connection_id, reason="user_request"))
            return

        await self._send_gate.wait()
        if generation != self._generation:
            tool_use_ids = [tool_use["toolUseId"] for tool_use in tool_uses]
            logger.warning(
                "tool_use_ids=<%s> | tool group completed across reconnect | results recorded, not sent",
                tool_use_ids,
            )
            return

        await self._agent.model.send_tool_results(tool_result_message)

    @staticmethod
    def _build_cancelled_tool_results(tool_uses: list[ToolUse], cancel: bool | str) -> list[ToolResult]:
        """Create one error result per tool when a batch hook cancels execution."""
        message = cancel if isinstance(cancel, str) else "Tool cancelled by hook"
        return [
            {
                "toolUseId": tool_use["toolUseId"],
                "status": "error",
                "content": [{"text": message}],
            }
            for tool_use in tool_uses
        ]

    @staticmethod
    def _build_end_turn_message(end_turn: bool | str | list[ContentBlock]) -> Message:
        """Convert an after-tools end-turn value to a final assistant message."""
        if isinstance(end_turn, list):
            content = list(end_turn)
        elif isinstance(end_turn, str):
            content = [{"text": end_turn}]
        else:
            content = [{"text": "Turn ended early by hook after tool execution"}]
        return {"role": "assistant", "content": content}

    @staticmethod
    def _build_tool_result_message(
        tool_uses: list[ToolUse],
        tool_results: list[ToolResult],
        *,
        require_complete: bool,
    ) -> Message:
        """Build a provider-ordered tool-result message and validate result cardinality."""
        expected_ids = {tool_use["toolUseId"] for tool_use in tool_uses}
        results_by_id: dict[str, ToolResult] = {}
        for result in tool_results:
            tool_use_id = result["toolUseId"]
            if tool_use_id not in expected_ids:
                raise ValueError(f"tool_use_id=<{tool_use_id}> | result does not belong to tool group")
            if tool_use_id in results_by_id:
                raise ValueError(f"tool_use_id=<{tool_use_id}> | tool group contains duplicate results")
            results_by_id[tool_use_id] = result

        missing_ids = expected_ids.difference(results_by_id)
        if require_complete and missing_ids:
            missing = ", ".join(sorted(missing_ids))
            raise ValueError(f"tool_use_ids=<[{missing}]> | tool group is missing results")

        content: list[ContentBlock] = []
        for tool_use in tool_uses:
            tool_use_id = tool_use["toolUseId"]
            if tool_use_id in results_by_id:
                content.append({"toolResult": results_by_id[tool_use_id]})
        return {"role": "user", "content": content}

    def _raise_unsupported_tool_interrupts(self, interrupts: list[Any]) -> None:
        """Raise the bidi unsupported-operation error for tool interrupts."""
        self._agent._interrupt_state.deactivate()
        interrupt_names = [interrupt.name for interrupt in interrupts]
        raise RuntimeError(f"interrupts={interrupt_names} | tool interrupts are not supported in bidi")

    @staticmethod
    def _should_stop_after_tools(tool_uses: list[ToolUse], invocation_state: dict[str, Any]) -> bool:
        """Return whether tool state requests conversation closure."""
        request_state = invocation_state["request_state"]
        if request_state.get("stop_event_loop", False):
            logger.info("stop_event_loop=<True> | stopping conversation")
            return True
        if any(tool_use["name"] == "stop_conversation" for tool_use in tool_uses):
            warnings.warn(
                "Stopping the event loop by tool name 'stop_conversation' is deprecated. "
                "Use request_state['stop_event_loop'] = True instead.",
                DeprecationWarning,
                stacklevel=2,
            )
            return True
        return False
