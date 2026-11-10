"""Strands Agent executor for the A2A protocol.

This module provides the StrandsA2AExecutor class, which adapts a Strands Agent
to be used as an executor in the A2A protocol. It handles the execution of agent
requests and the conversion of Strands Agent streamed responses to A2A events.

The A2A AgentExecutor ensures clients receive responses for synchronous and
streamed requests to the A2AServer.
"""

import asyncio
import base64
import json
import logging
import mimetypes
import uuid
import warnings
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, cast

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import (
    DataPart,
    FilePart,
    InternalError,
    InvalidParamsError,
    Part,
    TaskState,
    TextPart,
    UnsupportedOperationError,
)
from a2a.utils import new_agent_text_message, new_task
from a2a.utils.errors import ServerError

from ...agent.agent import Agent as SAAgent
from ...agent.agent import AgentResult as SAAgentResult
from ...session.session_manager import SessionManager
from ...types._snapshot import Snapshot
from ...types.content import ContentBlock
from ...types.interrupt import InterruptResponse, InterruptResponseContent
from ...types.media import (
    DocumentContent,
    DocumentSource,
    ImageContent,
    ImageSource,
    VideoContent,
    VideoSource,
)

logger = logging.getLogger(__name__)

# A factory that builds a fresh Agent for a given A2A context_id.
AgentFactory = Callable[[str], SAAgent]

# Key identifying a DataPart that carries a Strands interrupt response. The A2A payload mirrors the
# `InterruptResponseContent` type verbatim so the wire contract and the SDK type cannot drift.
INTERRUPT_RESPONSE_KEY = "interruptResponse"

# Key under which an `input_required` status message advertises the interrupts awaiting an answer.
# Each entry carries the `interruptId` that the matching interrupt response must echo back.
INTERRUPTS_KEY = "interrupts"

# What this executor invokes the agent with: fresh conversational content, or interrupt responses
# resuming a task parked in `input_required`. Deliberately narrower than the public `AgentInput`,
# which also admits `str`, `Messages`, and `None` — an A2A message only ever converts to these two.
# Each arm stays homogeneous because `_InterruptState.resume()` rejects a prompt whose contents are
# not all interrupt responses.
_AgentPrompt = list[ContentBlock] | list[InterruptResponseContent]


def _is_interrupt_resume(prompt: _AgentPrompt) -> bool:
    """Whether a prompt carries interrupt responses rather than conversational content."""
    return bool(prompt) and INTERRUPT_RESPONSE_KEY in prompt[0]


def _jsonable(value: Any) -> Any:
    """Return a value unchanged when it can cross the JSON-RPC boundary, else its string form.

    An interrupt reason is arbitrary user data. A value the transport cannot encode would otherwise
    surface only while serializing the response, long after the interrupt details are assembled.
    """
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return str(value)
    return value


@dataclass
class _StreamState:
    """Per-invocation A2A-compliant streaming state."""

    artifact_id: str
    is_first_chunk: bool = True


@dataclass
class _ContextEntry:
    """Per-context bookkeeping for factory mode: a dedicated agent and its serializing lock."""

    agent: SAAgent
    lock: asyncio.Lock


class StrandsA2AExecutor(AgentExecutor):
    """Executor that adapts a Strands Agent to the A2A protocol.

    Handles agent execution in streaming mode and converts Strands Agent responses to A2A
    protocol events, supporting the full task lifecycle (failed state, cancellation, and
    interrupt-based input_required flows).

    Conversation state is isolated per A2A ``context_id`` so callers in different contexts cannot
    read or influence each other's history. See ``__init__`` for the two isolation modes
    (``agent_factory`` and the deprecated single ``agent``).
    """

    # Default formats for each file type when MIME type is unavailable or unrecognized
    DEFAULT_FORMATS = {"document": "txt", "image": "png", "video": "mp4", "unknown": "txt"}

    # Handle special cases where format differs from extension
    FORMAT_MAPPINGS = {"jpg": "jpeg", "htm": "html", "3gp": "three_gp", "3gpp": "three_gp", "3g2": "three_gp"}

    # Cap on concurrently tracked A2A contexts. Beyond this, the least-recently-used context is
    # evicted to bound memory in long-running servers.
    DEFAULT_MAX_CONTEXTS = 1000

    def __init__(
        self,
        agent: SAAgent | None = None,
        *,
        agent_factory: AgentFactory | None = None,
        enable_a2a_compliant_streaming: bool = False,
        max_contexts: int = DEFAULT_MAX_CONTEXTS,
    ):
        """Initialize a StrandsA2AExecutor.

        Provide exactly one of ``agent`` or ``agent_factory``:

        - ``agent_factory`` (recommended): a callable ``(context_id) -> Agent`` invoked once per
          context to build a dedicated ``Agent``. Each context owns an independent agent and runs
          under its own lock, so different contexts execute concurrently and never share state.
          The factory is also where per-context concerns such as a ``session_manager`` are wired.
        - ``agent`` (deprecated): a single ``Agent`` reused across contexts. Each context's
          conversation state is swapped on/off this instance under a lock, so requests are
          serialized. A ``session_manager`` is not supported here, since every context would
          persist into one interleaved session — use ``agent_factory`` instead.

        Note:
            Contexts are keyed on the client-supplied ``context_id``, which is not an
            authentication boundary. A caller that knows another caller's ``context_id`` can
            attach to that conversation. Multi-tenant deployments must enforce authenticated
            identity at the transport/gateway layer.

            At most ``max_contexts`` contexts are retained; beyond that the least-recently-used is
            evicted (A2A spec §3.4.1 context cleanup policy) and a later request reusing that
            ``context_id`` starts fresh.

        Args:
            agent: A single Strands Agent. Deprecated; prefer ``agent_factory``.
            agent_factory: Callable ``(context_id) -> Agent`` building a fresh agent per context.
            enable_a2a_compliant_streaming: If True, uses A2A-compliant streaming with artifact
                updates. If False, uses legacy status updates streaming behavior for backwards
                compatibility. Defaults to False.
            max_contexts: Maximum number of contexts to retain concurrently; the least-recently-
                used is evicted beyond this. Must be >= 1. Defaults to ``DEFAULT_MAX_CONTEXTS``.

        Raises:
            ValueError: If neither or both of ``agent``/``agent_factory`` are provided, if
                ``max_contexts`` is less than 1, or if a single ``agent`` has a ``session_manager``.
        """
        if max_contexts < 1:
            raise ValueError(f"max_contexts must be >= 1, got {max_contexts}")
        if (agent is None) == (agent_factory is None):
            raise ValueError("Provide exactly one of 'agent' or 'agent_factory'.")

        self.enable_a2a_compliant_streaming = enable_a2a_compliant_streaming
        self._max_contexts = max_contexts
        self._agent_factory = agent_factory

        # Guards the per-context bookkeeping maps below.
        self._contexts_lock = asyncio.Lock()

        if agent_factory is not None:
            # Factory mode: a dedicated agent and lock per context.
            self.agent: SAAgent | None = None
            self._contexts: OrderedDict[str, _ContextEntry] = OrderedDict()
        else:
            # Single-agent mode: reuse one agent, swapping each context's snapshot on/off it.
            if isinstance(getattr(agent, "_session_manager", None), SessionManager):
                raise ValueError(
                    "A single 'agent' with a session_manager is not supported: the session manager "
                    "persists every context's messages into one interleaved session. Use "
                    "'agent_factory' to build a per-context agent with its own session_manager."
                )
            warnings.warn(
                "Passing a single 'agent' to StrandsA2AExecutor is deprecated and will be removed "
                "in a future version. A single agent serializes all requests; pass 'agent_factory' "
                "(a callable taking the context_id) instead to isolate conversations per context.",
                DeprecationWarning,
                stacklevel=2,
            )
            self.agent = agent
            self._template_snapshot = self._capture_state(agent)  # type: ignore[arg-type]
            self._snapshots: OrderedDict[str, Snapshot] = OrderedDict()

    def _capture_state(self, agent: SAAgent) -> Snapshot:
        """Snapshot an agent's session state."""
        return agent.take_snapshot(preset="session")

    def _restore_state(self, agent: SAAgent, snapshot: Snapshot) -> None:
        """Load a snapshot into an agent, restoring its session state."""
        agent.load_snapshot(snapshot)

    def _evict_excess_contexts(self) -> None:
        """Evict least-recently-used contexts beyond ``max_contexts``. Caller holds the lock."""
        contexts = self._contexts if self._agent_factory is not None else self._snapshots
        while len(contexts) > self._max_contexts:
            evicted_id, _ = contexts.popitem(last=False)
            logger.debug("context_id=<%s> | evicted least-recently-used A2A context", evicted_id)

    async def _acquire_context_agent(self, context_id: str) -> tuple[SAAgent, asyncio.Lock]:
        """Return the dedicated agent and lock for a context, building it on first use (factory mode)."""
        async with self._contexts_lock:
            entry = self._contexts.get(context_id)
            if entry is None:
                entry = _ContextEntry(agent=self._agent_factory(context_id), lock=asyncio.Lock())  # type: ignore[misc]
                self._contexts[context_id] = entry
                self._evict_excess_contexts()
            else:
                self._contexts.move_to_end(context_id)
            return entry.agent, entry.lock

    async def _run_with_context_agent(
        self,
        context_id: str,
        prompt: _AgentPrompt,
        invocation_state: dict[str, Any],
        updater: TaskUpdater,
        stream_state: _StreamState | None,
    ) -> None:
        """Factory mode: run against this context's dedicated agent, serialized only per context."""
        agent, lock = await self._acquire_context_agent(context_id)
        async with lock:
            await self._stream_agent(agent, prompt, invocation_state, updater, stream_state)

    async def _run_with_shared_agent(
        self,
        context_id: str,
        prompt: _AgentPrompt,
        invocation_state: dict[str, Any],
        updater: TaskUpdater,
        stream_state: _StreamState | None,
    ) -> None:
        """Single-agent mode: swap this context's snapshot on/off the shared agent under a lock."""
        async with self._contexts_lock:
            self._restore_state(self.agent, self._snapshots.get(context_id, self._template_snapshot))  # type: ignore[arg-type]
            try:
                await self._stream_agent(self.agent, prompt, invocation_state, updater, stream_state)  # type: ignore[arg-type]
            finally:
                # Persist updated history (even on error), evict, then reset the agent for the next caller.
                self._snapshots[context_id] = self._capture_state(self.agent)  # type: ignore[arg-type]
                self._snapshots.move_to_end(context_id)
                self._evict_excess_contexts()
                self._restore_state(self.agent, self._template_snapshot)  # type: ignore[arg-type]

    async def _stream_agent(
        self,
        agent: SAAgent,
        prompt: _AgentPrompt,
        invocation_state: dict[str, Any],
        updater: TaskUpdater,
        stream_state: _StreamState | None,
    ) -> None:
        """Stream one agent invocation and translate its events to A2A updates.

        Raises:
            ServerError: If the input does not match the agent's interrupt state — interrupt
                responses that name no parked interrupt, or fresh content for a parked task. Both
                fail before the agent runs, so a parked interrupt survives a rejected resume.
        """
        # Binding is checked here rather than at extraction: the agent, and with it the interrupt
        # state this request must match, is only resolved once the context's snapshot is restored.
        if _is_interrupt_resume(prompt):
            self._validate_interrupt_resume(agent, cast(list[InterruptResponseContent], prompt))
        elif agent._interrupt_state.activated:
            raise ServerError(
                error=InvalidParamsError(
                    message="Task is awaiting an interrupt response and cannot accept a new message"
                )
            ) from None

        try:
            result: SAAgentResult | None = None
            async for event in agent.stream_async(prompt, invocation_state=invocation_state):
                if "result" in event:
                    result = event["result"]
                else:
                    await self._handle_streaming_event(event, updater, stream_state)

            # Check if agent returned with interrupts (input_required)
            # Note: stop_reason="interrupt" is the authoritative signal. Even if interrupts
            # list is empty (edge case), the agent still indicated it needs input.
            if result is not None and result.stop_reason == "interrupt":
                await self._handle_interrupt_result(result, updater)
            else:
                await self._handle_agent_result(result, updater, stream_state)
        except Exception:
            logger.exception("Error in streaming execution")
            raise

    async def execute(
        self,
        context: RequestContext,
        event_queue: EventQueue,
    ) -> None:
        """Execute a request using the Strands Agent and send the response as A2A events.

        This method executes the user's input using the Strands Agent in streaming mode
        and converts the agent's response to A2A events. If the agent raises an exception,
        the task transitions to the `failed` state. If the agent returns with interrupts,
        the task transitions to the `input_required` state.

        Args:
            context: The A2A request context, containing the user's input and task metadata.
            event_queue: The A2A event queue used to send response events back to the client.

        Raises:
            ServerError: If an unrecoverable error occurs during agent execution setup
                (e.g., missing input). Agent execution errors are handled gracefully
                by transitioning the task to the failed state.
        """
        task = context.current_task
        if not task:
            task = new_task(context.message)  # type: ignore
            await event_queue.enqueue_event(task)

        updater = TaskUpdater(event_queue, task.id, task.context_id)

        try:
            await self._execute_streaming(context, updater)
        except ServerError:
            # Re-raise ServerErrors (setup failures like missing input)
            raise
        except asyncio.CancelledError:
            # asyncio.CancelledError is a BaseException (not Exception) — raised when
            # the asyncio task is cancelled (e.g., HTTP client disconnect, server shutdown).
            # We transition to canceled state so the task doesn't remain a zombie in "working".
            logger.warning("task_id=<%s> | asyncio task cancelled, transitioning to canceled state", task.id)
            try:
                await updater.cancel(
                    message=updater.new_agent_message(
                        parts=[Part(root=TextPart(text="Task cancelled due to connection termination"))]
                    )
                )
            except RuntimeError:
                # Task already in terminal state
                logger.debug("task_id=<%s> | task already in terminal state, cannot transition to canceled", task.id)
            raise
        except Exception:
            # Agent execution failures transition to failed state
            logger.exception("task_id=<%s> | agent execution failed, transitioning to failed state", task.id)
            try:
                await updater.failed(
                    message=updater.new_agent_message(parts=[Part(root=TextPart(text="Agent execution failed"))])
                )
            except RuntimeError:
                # Task already in terminal state (e.g., completed before error in cleanup)
                logger.debug("task_id=<%s> | task already in terminal state, cannot transition to failed", task.id)

    async def _execute_streaming(self, context: RequestContext, updater: TaskUpdater) -> None:
        """Execute request in streaming mode.

        Streams the agent's response in real-time, sending incremental updates
        as they become available from the agent.

        Args:
            context: The A2A request context, containing the user's input and other metadata.
            updater: The task updater for managing task state and sending updates.

        Raises:
            ServerError: If input conversion fails (missing or empty content), or if the message
                carries malformed interrupt responses.
        """
        if not (context.message and hasattr(context.message, "parts")):
            raise ServerError(error=InternalError(message="Request message is missing or has no parts")) from None

        # Interrupt responses resume a parked task, so they are recognized before the generic
        # conversion below would flatten them into text.
        prompt: _AgentPrompt | None = self._extract_interrupt_responses(context.message.parts)
        if prompt is None:
            prompt = self._convert_a2a_parts_to_content_blocks(context.message.parts)
            if not prompt:
                raise ServerError(
                    error=InternalError(message="No valid content found in request message parts")
                ) from None

        if not self.enable_a2a_compliant_streaming:
            warnings.warn(
                "The default A2A response stream implemented in the strands sdk does not conform to "
                "what is expected in the A2A spec. Please set the `enable_a2a_compliant_streaming` "
                "boolean to `True` on your `A2AServer` class to properly conform to the spec. "
                "In the next major version release, this will be the default behavior.",
                UserWarning,
                stacklevel=3,
            )

        # Per-invocation streaming state (None in legacy mode).
        stream_state = _StreamState(artifact_id=str(uuid.uuid4())) if self.enable_a2a_compliant_streaming else None

        # Forward the A2A RequestContext so downstream tools and hooks can read request metadata.
        invocation_state: dict[str, Any] = {"a2a_request_context": context}

        # The framework always populates context_id before execute() runs; isolation is keyed on it.
        context_id = context.context_id
        if not context_id:
            raise ServerError(error=InternalError(message="Request is missing a context_id")) from None

        if self._agent_factory is not None:
            await self._run_with_context_agent(context_id, prompt, invocation_state, updater, stream_state)
        else:
            await self._run_with_shared_agent(context_id, prompt, invocation_state, updater, stream_state)

    async def _handle_interrupt_result(self, result: SAAgentResult, updater: TaskUpdater) -> None:
        """Handle an agent result that contains interrupts.

        When the Strands Agent returns with stop_reason="interrupt", this maps to
        the A2A `input_required` state. The interrupt details are communicated to
        the client via the status message.

        The details are carried twice: a TextPart describing what is needed, and a DataPart holding
        each interrupt's id. Only the id lets a client address its response back to the interrupt
        that raised it, and an id is generated server-side so it cannot be inferred from the prose.

        Args:
            result: The agent result containing interrupts.
            updater: The task updater for managing task state.
        """
        # Build a descriptive message about what input is needed
        interrupt_descriptions = []
        pending_interrupts: list[dict[str, Any]] = []
        for interrupt in result.interrupts or []:
            desc = f"- {interrupt.name}"
            if interrupt.reason:
                desc += f": {interrupt.reason}"
            interrupt_descriptions.append(desc)
            pending_interrupts.append(
                {"interruptId": interrupt.id, "name": interrupt.name, "reason": _jsonable(interrupt.reason)}
            )

        if interrupt_descriptions:
            input_message = "Agent requires input:\n" + "\n".join(interrupt_descriptions)
        else:
            # Edge case: stop_reason="interrupt" but no interrupt details provided.
            # Still transition to input_required — the agent signaled it needs input.
            input_message = "Agent requires additional input to continue"

        # The TextPart stays first so clients that only read prose are unaffected.
        parts = [Part(root=TextPart(text=input_message))]
        if pending_interrupts:
            parts.append(Part(root=DataPart(data={INTERRUPTS_KEY: pending_interrupts})))

        await updater.requires_input(message=updater.new_agent_message(parts=parts))

    async def _handle_streaming_event(
        self, event: dict[str, Any], updater: TaskUpdater, stream_state: _StreamState | None
    ) -> None:
        """Handle a single streaming event from the Strands Agent.

        Processes streaming events from the agent, converting data chunks to A2A
        task updates and handling the final result when streaming is complete.

        Args:
            event: The streaming event from the agent, containing either 'data' for
                incremental content or 'result' for the final response.
            updater: The task updater for managing task state and sending updates.
            stream_state: Per-invocation streaming state when A2A-compliant streaming is enabled,
                else None.
        """
        logger.debug("Streaming event: %s", event)
        if "data" in event:
            if text_content := event["data"]:
                if stream_state is not None:
                    await updater.add_artifact(
                        [Part(root=TextPart(text=text_content))],
                        artifact_id=stream_state.artifact_id,
                        name="agent_response",
                        append=not stream_state.is_first_chunk,
                    )
                    stream_state.is_first_chunk = False
                else:
                    # Legacy use update_status with agent message
                    await updater.update_status(
                        TaskState.working,
                        new_agent_text_message(
                            text_content,
                            updater.context_id,
                            updater.task_id,
                        ),
                    )

    async def _handle_agent_result(
        self, result: SAAgentResult | None, updater: TaskUpdater, stream_state: _StreamState | None
    ) -> None:
        """Handle the final result from the Strands Agent.

        For A2A-compliant streaming: sends the final artifact chunk marker and marks
        the task as complete. If no data chunks were previously sent, includes the
        result content.

        For legacy streaming: adds the final result as a simple artifact without
        artifact_id tracking.

        Args:
            result: The agent result object containing the final response, or None if no result.
            updater: The task updater for managing task state and adding the final artifact.
            stream_state: Per-invocation streaming state when A2A-compliant streaming is enabled,
                else None.
        """
        if stream_state is not None:
            if stream_state.is_first_chunk:
                final_content = str(result) if result else ""
                await updater.add_artifact(
                    [Part(root=TextPart(text=final_content))],
                    artifact_id=stream_state.artifact_id,
                    name="agent_response",
                    last_chunk=True,
                )
            else:
                await updater.add_artifact(
                    [Part(root=TextPart(text=""))],
                    artifact_id=stream_state.artifact_id,
                    name="agent_response",
                    append=True,
                    last_chunk=True,
                )
        elif final_content := str(result):
            await updater.add_artifact(
                [Part(root=TextPart(text=final_content))],
                name="agent_response",
            )
        await updater.complete()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        """Cancel an ongoing execution.

        Transitions the task to the canceled state and attempts to stop the agent.
        The agent's cancel() method is called to signal cooperative cancellation
        of in-flight execution.

        Note: This transitions the A2A task state. The underlying agent execution
        may still complete its current model call before stopping.

        Args:
            context: The A2A request context.
            event_queue: The A2A event queue.

        Raises:
            ServerError: If no current task exists or the task is already in a terminal state.
        """
        task = context.current_task
        if not task:
            logger.warning("context_id=<%s> | cancel requested but no current task found", context.context_id)
            raise ServerError(error=UnsupportedOperationError()) from None

        # Cooperatively cancel the agent's execution (best-effort). In factory mode, resolve the
        # agent for this context; in single-agent mode, the shared agent.
        target_agent = self.agent
        if self._agent_factory is not None:
            entry = self._contexts.get(context.context_id) if context.context_id else None
            target_agent = entry.agent if entry is not None else None
        if target_agent is not None:
            try:
                target_agent.cancel()
            except Exception:
                logger.debug("task_id=<%s> | agent cancel signal failed (non-critical)", task.id)

        updater = TaskUpdater(event_queue, task.id, task.context_id)

        try:
            await updater.cancel(
                message=updater.new_agent_message(parts=[Part(root=TextPart(text="Task cancelled by client request"))])
            )
        except RuntimeError:
            # TaskUpdater raises RuntimeError when task is already in a terminal state
            logger.warning("task_id=<%s> | cannot cancel, already in terminal state", task.id)
            raise ServerError(error=UnsupportedOperationError()) from None

    def _get_file_type_from_mime_type(self, mime_type: str | None) -> Literal["document", "image", "video", "unknown"]:
        """Classify file type based on MIME type.

        Args:
            mime_type: The MIME type of the file

        Returns:
            The classified file type
        """
        if not mime_type:
            return "unknown"

        mime_type = mime_type.lower()

        if mime_type.startswith("image/"):
            return "image"
        elif mime_type.startswith("video/"):
            return "video"
        elif (
            mime_type.startswith("text/")
            or mime_type.startswith("application/")
            or mime_type in ["application/pdf", "application/json", "application/xml"]
        ):
            return "document"
        else:
            return "unknown"

    def _get_file_format_from_mime_type(self, mime_type: str | None, file_type: str) -> str:
        """Extract file format from MIME type using Python's mimetypes library.

        Args:
            mime_type: The MIME type of the file
            file_type: The classified file type (image, video, document, txt)

        Returns:
            The file format string
        """
        if not mime_type:
            return self.DEFAULT_FORMATS.get(file_type, "txt")

        mime_type = mime_type.lower()

        # Extract subtype from MIME type and check existing format mappings
        if "/" in mime_type:
            subtype = mime_type.split("/")[-1]
            if subtype in self.FORMAT_MAPPINGS:
                return self.FORMAT_MAPPINGS[subtype]

        # Use mimetypes library to find extensions for the MIME type
        extensions = mimetypes.guess_all_extensions(mime_type)

        if extensions:
            extension = extensions[0][1:]  # Remove the leading dot
            return self.FORMAT_MAPPINGS.get(extension, extension)

        # Fallback to defaults for unknown MIME types
        return self.DEFAULT_FORMATS.get(file_type, "txt")

    def _strip_file_extension(self, file_name: str) -> str:
        """Strip the file extension from a file name.

        Args:
            file_name: The original file name with extension

        Returns:
            The file name without extension
        """
        if "." in file_name:
            return file_name.rsplit(".", 1)[0]
        return file_name

    def _extract_interrupt_responses(self, parts: list[Part]) -> list[InterruptResponseContent] | None:
        """Extract Strands interrupt responses from inbound A2A message parts.

        A client resumes a task parked in ``input_required`` by sending a DataPart shaped like the
        Strands ``InterruptResponseContent`` type::

            {"kind": "data", "data": {"interruptResponse": {"interruptId": "<id>", "response": <any>}}}

        Recognition is deliberately narrow: only the explicit shape above is treated as a resume, so
        an ordinary DataPart still reaches the generic content-block path unchanged.

        Args:
            parts: List of A2A Part objects from the inbound message.

        Returns:
            The interrupt responses carried by ``parts``, or None when none are present and the
            caller should fall back to generic content-block conversion.

        Raises:
            ServerError: If an interrupt response is malformed, carries a null response, repeats an
                interrupt id, or is accompanied by unrelated content in the same message.
        """
        responses: list[InterruptResponseContent] = []
        seen_ids: set[str] = set()
        unrelated_parts = 0

        for part in parts:
            part_root = part.root
            data = part_root.data if isinstance(part_root, DataPart) else None
            if not isinstance(data, dict) or INTERRUPT_RESPONSE_KEY not in data:
                unrelated_parts += 1
                continue

            response = data[INTERRUPT_RESPONSE_KEY]
            if not isinstance(response, dict):
                raise ServerError(
                    error=InvalidParamsError(
                        message=f"'{INTERRUPT_RESPONSE_KEY}' must be an object with 'interruptId' and 'response'"
                    )
                ) from None

            interrupt_id = response.get("interruptId")
            if not isinstance(interrupt_id, str) or not interrupt_id:
                raise ServerError(
                    error=InvalidParamsError(message="Interrupt response is missing a non-empty 'interruptId'")
                ) from None

            # `Interrupt.response` of None means "not yet answered", so a null answer would leave
            # the interrupt unsatisfied and re-raise it — the client would see an identical
            # input_required and no error. Falsy answers such as False are fine.
            if response.get("response") is None:
                raise ServerError(
                    error=InvalidParamsError(
                        message=f"Interrupt response for '{interrupt_id}' must provide a non-null 'response'"
                    )
                ) from None

            # Two answers for one interrupt are ambiguous; reject rather than silently choosing one.
            if interrupt_id in seen_ids:
                raise ServerError(
                    error=InvalidParamsError(message=f"Duplicate interrupt response for '{interrupt_id}'")
                ) from None

            seen_ids.add(interrupt_id)
            responses.append(
                InterruptResponseContent(
                    interruptResponse=InterruptResponse(interruptId=interrupt_id, response=response["response"])
                )
            )

        if not responses:
            return None

        # The agent resumes from interrupt responses alone; delivering both would mean dropping the
        # conversational content, which is exactly the silent behavior the resume path must avoid.
        if unrelated_parts:
            raise ServerError(
                error=InvalidParamsError(
                    message="A message carrying interrupt responses must not contain other content parts"
                )
            ) from None

        logger.debug("interrupt_ids=<%s> | extracted interrupt responses from request", sorted(seen_ids))
        return responses

    def _validate_interrupt_resume(self, agent: SAAgent, responses: list[InterruptResponseContent]) -> None:
        """Verify interrupt responses bind to interrupts actually parked on this context's agent.

        Args:
            agent: The agent serving this context, with its interrupt state already restored.
            responses: Interrupt responses extracted from the inbound message.

        Raises:
            ServerError: If the agent holds no parked interrupts, or a response names an interrupt
                the agent is not waiting on.
        """
        interrupt_state = agent._interrupt_state

        if not interrupt_state.activated:
            raise ServerError(
                error=InvalidParamsError(message="Received interrupt responses but no interrupt is pending")
            ) from None

        unknown_ids = sorted(
            content["interruptResponse"]["interruptId"]
            for content in responses
            if content["interruptResponse"]["interruptId"] not in interrupt_state.interrupts
        )
        if unknown_ids:
            raise ServerError(
                error=InvalidParamsError(message=f"No pending interrupt matches id(s): {', '.join(unknown_ids)}")
            ) from None

    def _convert_a2a_parts_to_content_blocks(self, parts: list[Part]) -> list[ContentBlock]:
        """Convert A2A message parts to Strands ContentBlocks.

        Args:
            parts: List of A2A Part objects

        Returns:
            List of Strands ContentBlock objects
        """
        content_blocks: list[ContentBlock] = []

        for part in parts:
            try:
                part_root = part.root

                if isinstance(part_root, TextPart):
                    # Handle TextPart
                    content_blocks.append(ContentBlock(text=part_root.text))

                elif isinstance(part_root, FilePart):
                    # Handle FilePart
                    file_obj = part_root.file
                    mime_type = getattr(file_obj, "mime_type", None)
                    raw_file_name = getattr(file_obj, "name", "FileNameNotProvided")
                    file_name = self._strip_file_extension(raw_file_name)
                    file_type = self._get_file_type_from_mime_type(mime_type)
                    file_format = self._get_file_format_from_mime_type(mime_type, file_type)

                    # Handle FileWithBytes vs FileWithUri
                    bytes_data = getattr(file_obj, "bytes", None)
                    uri_data = getattr(file_obj, "uri", None)

                    if bytes_data:
                        try:
                            # A2A bytes are always base64-encoded strings
                            decoded_bytes = base64.b64decode(bytes_data)
                        except Exception as e:
                            raise ValueError(f"Failed to decode base64 data for file '{raw_file_name}': {e}") from e

                        if file_type == "image":
                            content_blocks.append(
                                ContentBlock(
                                    image=ImageContent(
                                        format=file_format,  # type: ignore
                                        source=ImageSource(bytes=decoded_bytes),
                                    )
                                )
                            )
                        elif file_type == "video":
                            content_blocks.append(
                                ContentBlock(
                                    video=VideoContent(
                                        format=file_format,  # type: ignore
                                        source=VideoSource(bytes=decoded_bytes),
                                    )
                                )
                            )
                        else:  # document or unknown
                            content_blocks.append(
                                ContentBlock(
                                    document=DocumentContent(
                                        format=file_format,  # type: ignore
                                        name=file_name,
                                        source=DocumentSource(bytes=decoded_bytes),
                                    )
                                )
                            )
                    # Handle FileWithUri
                    elif uri_data:
                        # For URI files, create a text representation since Strands ContentBlocks expect bytes
                        content_blocks.append(
                            ContentBlock(text=f"[File: {file_name} ({mime_type})] - Referenced file at: {uri_data}")
                        )
                elif isinstance(part_root, DataPart):
                    # Handle DataPart - convert structured data to JSON text
                    try:
                        data_text = json.dumps(part_root.data, indent=2)
                        content_blocks.append(ContentBlock(text=f"[Structured Data]\n{data_text}"))
                    except Exception:
                        logger.exception("Failed to serialize data part")
            except Exception:
                logger.exception("Error processing part")

        return content_blocks
