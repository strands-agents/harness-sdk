"""Bidirectional Agent for real-time streaming conversations.

Provides real-time audio and text interaction through persistent streaming connections.
Unlike traditional request-response patterns, this agent maintains long-running
conversations where users can barge in, provide additional input, and receive
continuous responses including audio output.

Key capabilities:

- Persistent conversation connections with concurrent processing
- Real-time audio input/output streaming
- Automatic barge-in detection and tool execution
- Event-driven communication with model providers
"""

import asyncio
import copy
import logging
import uuid
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING, Any, ClassVar, Literal, cast

from .... import _identifier
from ...._middleware import MiddlewareRegistry
from ....agent.state import AgentState
from ....hooks import (
    AgentInitializedEvent,
    HookCallback,
    HookOrder,
    HookProvider,
    HookRegistry,
    MessageAddedEvent,
    MessageUpdatedEvent,
)
from ....hooks.registry import TEvent
from ....interrupt import _InterruptState
from ....tools._caller import _ToolCaller
from ....tools.executors import ConcurrentToolExecutor
from ....tools.executors._executor import ToolExecutor
from ....tools.registry import ToolRegistry
from ....tools.tool_provider import ToolProvider
from ....tools.watcher import ToolWatcher
from ....types._snapshot import (
    BIDI_SNAPSHOT_FIELDS,
    BIDI_SNAPSHOT_PRESETS,
    SNAPSHOT_SCHEMA_VERSION,
    Snapshot,
    SnapshotField,
    SnapshotPreset,
    resolve_snapshot_fields,
)
from ....types.agent import LocalAgent
from ....types.content import (
    Message,
    Messages,
    SystemContentBlock,
    TextBlock,
    _ensure_tracking_id,
    split_system_prompt,
)
from ....types.exceptions import SnapshotException
from ....types.media import AudioContent, ImageBlock, ImageContent
from ....types.tools import AgentTool, ToolResultBlock
from .._async import _TaskGroup, stop_all
from ..models.model import BidiModel
from ..types.agent import BidiAgentInput
from ..types.content import BidiMessage
from ..types.events import BidiOutputEvent
from ..types.io import InputStream, OutputStream
from ..types.media import AudioDelta
from .loop import _AgentLoop

if TYPE_CHECKING:
    from ....session.session_manager import SessionManager

logger = logging.getLogger(__name__)

_DEFAULT_AGENT_NAME = "Strands Agents"
_DEFAULT_AGENT_ID = "default"


class BidiAgent(LocalAgent):
    """Agent for bidirectional streaming conversations.

    Enables real-time audio and text interaction with AI models through persistent
    connections. Supports concurrent tool execution and barge-in handling.
    """

    _is_strands_local_agent: ClassVar[Literal[True]] = True

    def __init__(
        self,
        model: BidiModel | str | None = None,
        tools: list[str | AgentTool | ToolProvider] | None = None,
        system_prompt: str | list[SystemContentBlock] | None = None,
        messages: Messages | None = None,
        record_direct_tool_call: bool = True,
        load_tools_from_directory: bool = False,
        agent_id: str | None = None,
        name: str | None = None,
        description: str | None = None,
        hooks: list[HookProvider] | None = None,
        state: AgentState | dict | None = None,
        session_manager: "SessionManager[LocalAgent] | None" = None,
        tool_executor: ToolExecutor | None = None,
        **kwargs: Any,
    ):
        """Initialize bidirectional agent.

        Args:
            model: BidiModel instance, Bedrock model ID string, or None to use Nova Sonic 2.
            tools: Optional list of tools with flexible format support.
            system_prompt: System prompt for conversations as a string or structured content blocks.
                Structured blocks are retained, while their text is passed to Bidi models as a string.
            messages: Optional conversation history to initialize with.
            record_direct_tool_call: Whether to record direct tool calls in message history.
            load_tools_from_directory: Whether to load and automatically reload tools in the `./tools/` directory.
            agent_id: Optional ID for the agent, useful for connection management and multi-agent scenarios.
            name: Name of the Agent.
            description: Description of what the Agent does.
            hooks: Optional list of hook providers to register for lifecycle events.
            state: Stateful information for the agent. Can be either an AgentState object, or a json serializable dict.
            session_manager: Manager for handling agent sessions including conversation history and state.
                If provided, enables session-based persistence and state management.
            tool_executor: Definition of tool execution strategy (e.g., sequential, concurrent, etc.).
            **kwargs: Additional configuration for future extensibility.

        Raises:
            ValueError: If model configuration is invalid or state is invalid type.
            TypeError: If model type is unsupported.
        """
        if isinstance(model, BidiModel):
            self.model = model
        elif isinstance(model, str):
            from ..models.bedrock import BedrockNovaSonicModel

            self.model = BedrockNovaSonicModel(model_id=model)
        elif model is None:
            from ..models.bedrock import BedrockNovaSonicModel

            self.model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0")
        else:
            raise TypeError("model must be a BidiModel, string, or None")

        _, self._system_prompt_content = split_system_prompt(system_prompt)
        self.messages = messages if messages is not None else []

        # Agent identification
        self.agent_id = _identifier.validate(agent_id or _DEFAULT_AGENT_ID, _identifier.Identifier.AGENT)
        self.name = name or _DEFAULT_AGENT_NAME
        self.description = description

        # Tool execution configuration
        self.record_direct_tool_call = record_direct_tool_call
        self.load_tools_from_directory = load_tools_from_directory

        # Initialize tool registry
        self.tool_registry = ToolRegistry()

        if tools is not None:
            self.tool_registry.process_tools(tools)

        self.tool_registry.initialize_tools(self.load_tools_from_directory)

        # Initialize tool watcher if directory loading is enabled
        if self.load_tools_from_directory:
            self.tool_watcher = ToolWatcher(tool_registry=self.tool_registry)

        # Initialize agent state management
        if state is not None:
            if isinstance(state, dict):
                self.state = AgentState(state)
            elif isinstance(state, AgentState):
                self.state = state
            else:
                raise ValueError("state must be an AgentState object or a dict")
        else:
            self.state = AgentState()

        # Initialize other components
        self._tool_caller = _ToolCaller(self)

        # Initialize tool executor
        self.tool_executor = tool_executor or ConcurrentToolExecutor()

        # Initialize hooks registry
        self.hooks = HookRegistry()
        if hooks:
            for hook in hooks:
                self.hooks.add_hook(hook)

        # Initialize session management functionality
        self._session_manager = session_manager
        if self._session_manager:
            self._session_id: str = getattr(self._session_manager, "session_id", None) or uuid.uuid4().hex[:8]
            self.hooks.add_hook(self._session_manager)
        else:
            self._session_id = uuid.uuid4().hex[:8]

        self._loop = _AgentLoop(self)

        # TODO: Determine if full support is required
        self._interrupt_state = _InterruptState()

        # Empty registry so the shared ToolExecutor can invoke ExecuteToolStage uniformly.
        # With no handlers registered, the chain fast-paths straight to the terminal, so
        # bidi tool execution is unaffected until middleware support is formally added.
        self._middleware_registry = MiddlewareRegistry()

        # Lock to ensure that paired messages are added to history in sequence without interference
        self._message_lock = asyncio.Lock()

        self._started = False

        self.hooks.invoke_callbacks(AgentInitializedEvent[LocalAgent](agent=self))

    @property
    def tool(self) -> _ToolCaller:
        """Call tool as a function.

        Returns:
            ToolCaller for method-style tool execution.

        Example:
            ```
            agent = BidiAgent(model=model, tools=[calculator])
            agent.tool.calculator(expression="2+2")
            ```
        """
        return self._tool_caller

    @property
    def tool_names(self) -> list[str]:
        """Get a list of all registered tool names.

        Returns:
            Names of all tools available to this agent.
        """
        all_tools = self.tool_registry.get_all_tools_config()
        return list(all_tools.keys())

    @property
    def system_prompt(self) -> str | None:
        """Get the system prompt as a string."""
        return split_system_prompt(self._system_prompt_content)[0]

    @system_prompt.setter
    def system_prompt(self, value: str | list[SystemContentBlock] | None) -> None:
        """Set the system prompt and retain its structured content representation."""
        _, self._system_prompt_content = split_system_prompt(value)

    @property
    def system_prompt_content(self) -> list[SystemContentBlock] | None:
        """Get the system prompt as structured content blocks."""
        return list(self._system_prompt_content) if self._system_prompt_content is not None else None

    @property
    def session_id(self) -> str:
        """Get the conversation session identifier."""
        return self._session_id

    def add_hook(
        self,
        callback: HookCallback[TEvent],
        event_type: type[TEvent] | list[type[TEvent]] | None = None,
        *,
        order: float = HookOrder.DEFAULT,
    ) -> None:
        """Register a callback function for a specific event type.

        This method supports multiple call patterns:
        1. ``add_hook(callback)`` - Event type inferred from callback's type hint
        2. ``add_hook(callback, event_type)`` - Event type specified explicitly
        3. ``add_hook(callback, [TypeA, TypeB])`` - Register for multiple event types

        When the callback's type hint is a union type (``A | B`` or ``Union[A, B]``),
        the callback is automatically registered for each event type in the union.

        Callbacks can be either synchronous or asynchronous functions.

        Args:
            callback: The callback function to invoke when events of this type occur.
            event_type: The class type(s) of events this callback should handle.
                Can be a single type, a list of types, or None to infer from
                the callback's first parameter type hint. If a list is provided,
                the callback is registered for each type in the list.
            order: Execution priority. Lower values execute first.
                Use a HookOrder constant such as SDK_FIRST (-100), DEFAULT (0),
                MODEL_ROUTING (50), or SDK_LAST (100).

        Raises:
            ValueError: If event_type is not provided and cannot be inferred from
                the callback's type hints, or if the event_type list is empty.
        """
        self.hooks.add_callback(event_type, callback, order=order)

    async def start(self, invocation_state: dict[str, Any] | None = None) -> None:
        """Start a persistent bidirectional conversation connection.

        Initializes the streaming connection and starts background tasks for processing
        model events, tool execution, and connection management.

        Args:
            invocation_state: Optional context shared by reference with tools and hooks until stop(),
                including across connection restarts. Tools access it through ToolContext.invocation_state.
                Defaults to a new empty dictionary.

        Raises:
            RuntimeError:
                If agent already started.

        Example:
            ```python
            await agent.start(invocation_state={
                "user_id": "user_123",
                "session_id": "session_456",
                "database": db_connection,
            })
            ```
        """
        if self._started:
            raise RuntimeError("agent already started | call stop before starting again")

        logger.debug("agent starting")
        await self._loop.start(invocation_state)
        self._started = True

    async def send(self, input_data: BidiAgentInput) -> None:
        """Send user content to the model.

        Strings are shorthand for text blocks. Lists of text and image blocks
        form one user message, preserving block order. Audio deltas are sent
        individually and are not added to conversation history. Tool results
        are sent by the agent's tool runner.

        Args:
            input_data: Can be:

                - str: Text message from user
                - TextBlock, AudioDelta, or ImageBlock: Text, streaming audio, or image input
                - BidiContentBlockData: A dictionary containing one text or image key
                - BidiContentDeltaData: A dictionary containing one audio_delta key
                - list: A non-empty list of strings, text or image blocks, or their dictionary forms

        Raises:
            RuntimeError: If start has not been called.
            TypeError: If the input has an unsupported type or invalid input arguments.
            ValueError: If the input contains a tool result, the input list is empty,
                or an input dictionary does not contain exactly one supported key.

        Example:
            await agent.send("Hello")
            await agent.send(AudioDelta(format="pcm", source={"bytes": audio_bytes}))
            await agent.send({"audio_delta": {"format": "pcm", "source": {"bytes": audio_bytes}}})
            await agent.send([TextBlock("Use these details."), TextBlock("Order number: 123.")])
        """
        if not self._started:
            raise RuntimeError("agent not started | call start before sending")

        match input_data:
            case AudioDelta():
                await self._loop.send(input_data)
                return
            case {"audio_delta": audio, **rest} if not rest:
                await self._loop.send(AudioDelta(**cast(AudioContent, audio)))
                return

        inputs = input_data if isinstance(input_data, list) else [input_data]
        message = BidiMessage(content=[])
        for item in inputs:
            match item:
                case ToolResultBlock() | {"toolResult": _}:
                    raise ValueError("invalid input | tool results cannot be sent through BidiAgent.send")
                case TextBlock() | ImageBlock():
                    message.content.append(item)
                case str():
                    message.content.append(TextBlock(item))
                case {"text": text, **rest} if not rest:
                    message.content.append(TextBlock(cast(str, text)))
                case {"image": image, **rest} if not rest:
                    message.content.append(ImageBlock(**cast(ImageContent, image)))
                case dict():
                    raise ValueError("invalid input | expected one text or image key")
                case _:
                    raise TypeError("invalid input | expected a string, TextBlock, or ImageBlock")

        if not message.content:
            raise ValueError("invalid input | input list cannot be empty")

        await self._loop.send(message)

    async def receive(self) -> AsyncGenerator[BidiOutputEvent, None]:
        """Receive events from the model including audio, text, and tool calls.

        Yields:
            Model output events processed by background tasks including audio output,
            text responses, tool calls, and connection updates.

        Raises:
            RuntimeError: If start has not been called.
        """
        if not self._started:
            raise RuntimeError("agent not started | call start before receiving")

        async for event in self._loop.receive():
            yield event

    async def stop(self) -> None:
        """End the conversation connection and cleanup all resources.

        Terminates the streaming connection, cancels background tasks, and
        closes the connection to the model provider.
        """
        self._started = False
        await self._loop.stop()

    def take_snapshot(
        self,
        *,
        preset: SnapshotPreset | None = None,
        include: list[SnapshotField] | None = None,
        exclude: list[SnapshotField] | None = None,
        app_data: dict[str, Any] | None = None,
    ) -> Snapshot:
        """Capture current agent state as an in-memory snapshot.

        Captures committed conversation history and application state. Live connection
        state, in-progress responses, and pending tool calls are not included.

        Args:
            preset: Named preset of fields to capture. Currently only "session" is supported,
                which captures messages and state.
            include: Additional fields to capture on top of the preset.
            exclude: Fields to remove after applying preset and include.
            app_data: Application-owned arbitrary JSON stored verbatim in the snapshot.

        Returns:
            A Snapshot containing the captured agent state.

        Raises:
            SnapshotException: If no fields are resolved or a field is invalid or unsupported.
        """
        for snapshot_field in [*(include or []), *(exclude or [])]:
            if snapshot_field not in BIDI_SNAPSHOT_FIELDS:
                raise SnapshotException(
                    f"Invalid snapshot field: {snapshot_field!r}. Valid fields: {sorted(BIDI_SNAPSHOT_FIELDS)}"
                )
        preset_fields = BIDI_SNAPSHOT_PRESETS[preset] if preset is not None else ()
        fields = resolve_snapshot_fields(include=[*preset_fields, *(include or [])], exclude=exclude)

        data: dict[str, Any] = {}
        if "messages" in fields:
            data["messages"] = copy.deepcopy(self.messages)
        if "state" in fields:
            data["state"] = self.state.get()
        if "system_prompt" in fields:
            # Store the content-block representation so round-trips preserve caching hints and
            # other block-level metadata.
            data["system_prompt"] = copy.deepcopy(self._system_prompt_content)

        return Snapshot(
            scope="agent",
            schema_version=SNAPSHOT_SCHEMA_VERSION,
            data=data,
            app_data=copy.deepcopy(app_data) if app_data else {},
        )

    def load_snapshot(self, snapshot: Snapshot) -> None:
        """Restore agent state from a previously captured snapshot.

        Only fields present in snapshot.data are restored; absent fields are left unchanged and
        fields this agent does not support are ignored. The restored history is sent to the model
        on the next start().

        Args:
            snapshot: The snapshot to restore from.

        Raises:
            SnapshotException: If snapshot.schema_version is not "1.0" or snapshot.scope is not "agent".
            RuntimeError: If the agent is started.
        """
        if self._started:
            raise RuntimeError("agent started | call stop before loading a snapshot")
        snapshot.validate()
        if snapshot.scope != "agent":
            raise SnapshotException(f"Expected snapshot scope 'agent', got {snapshot.scope!r}")

        data = snapshot.data

        if "messages" in data:
            self.messages = copy.deepcopy(data["messages"])
        if "state" in data:
            self.state = AgentState(data["state"])
        if "system_prompt" in data:
            self.system_prompt = copy.deepcopy(data["system_prompt"])

    async def __aenter__(self, invocation_state: dict[str, Any] | None = None) -> "BidiAgent":
        """Async context manager entry point.

        Automatically starts the bidirectional connection when entering the context.

        Args:
            invocation_state: Optional context to pass to tools during execution.
                This allows passing custom data (user_id, session_id, database connections, etc.)
                that tools can access via their invocation_state parameter.

        Returns:
            Self for use in the context.
        """
        logger.debug("context_manager=<enter> | starting agent")
        await self.start(invocation_state)
        return self

    async def __aexit__(self, *_: Any) -> None:
        """Async context manager exit point.

        Automatically ends the connection and cleans up resources including
        when exiting the context, regardless of whether an exception occurred.
        """
        logger.debug("context_manager=<exit> | stopping agent")
        await self.stop()

    async def run(
        self, inputs: list[InputStream], outputs: list[OutputStream], invocation_state: dict[str, Any] | None = None
    ) -> None:
        """Run the agent using provided I/O streams for bidirectional communication.

        Args:
            inputs: Streams that produce input for the agent.
            outputs: Streams that consume output events from the agent.
            invocation_state: Optional context shared by reference with tools and hooks for the duration of run(),
                including across connection restarts. Tools access it through ToolContext.invocation_state.
                Defaults to a new empty dictionary.

        Example:
            ```python
            # Using default audio settings:
            model = BedrockNovaSonicModel(model_id="amazon.nova-2-sonic-v1:0")
            audio_io = AudioIO()
            agent = BidiAgent(model=model, tools=[calculator])
            await agent.run(
                inputs=[audio_io.input()],
                outputs=[audio_io.output()],
                invocation_state={"user_id": "user_123"}
            )

            # Using custom audio config:
            model = BedrockNovaSonicModel(
                model_id="amazon.nova-2-sonic-v1:0",
                audio={
                    "input": {"sample_rate": 16000},
                    "output": {"sample_rate": 24000},
                }
            )
            audio_io = AudioIO()
            agent = BidiAgent(model=model, tools=[calculator])
            await agent.run(
                inputs=[audio_io.input()],
                outputs=[audio_io.output()],
            )
            ```
        """

        async def run_inputs() -> None:
            async def task(input_: InputStream) -> None:
                while True:
                    event = await input_()
                    await self.send(event)

            await asyncio.gather(*[task(input_) for input_ in inputs])

        async def run_outputs(inputs_task: asyncio.Task) -> None:
            async for event in self.receive():
                await asyncio.gather(*[output(event) for output in outputs])

            inputs_task.cancel()

        try:
            await self.start(invocation_state)

            input_starts = [input_.start for input_ in inputs if isinstance(input_, InputStream)]
            output_starts = [output.start for output in outputs if isinstance(output, OutputStream)]
            for start in [*input_starts, *output_starts]:
                await start(self)

            async with _TaskGroup() as task_group:
                inputs_task = task_group.create_task(run_inputs())
                task_group.create_task(run_outputs(inputs_task))

        finally:
            input_stops = [input_.stop for input_ in inputs if isinstance(input_, InputStream)]
            output_stops = [output.stop for output in outputs if isinstance(output, OutputStream)]

            await stop_all(*input_stops, *output_stops, self.stop)

    async def _append_messages(self, *messages: Message) -> None:
        """Append messages to history in sequence without interference.

        The message lock ensures that paired messages are added to history in sequence without interference. For
        example, tool use and tool result messages must be added adjacent to each other.

        Args:
            *messages: List of messages to add into history.
        """
        async with self._message_lock:
            for message in messages:
                _ensure_tracking_id(message)
                self.messages.append(message)
                await self.hooks.invoke_callbacks_async(MessageAddedEvent[LocalAgent](agent=self, message=message))

    async def _update_message(self, message: Message, *, strict: bool = True) -> None:
        """Replace a message by its tracking ID and notify hooks.

        Search newest messages first.

        Args:
            message: Replacement message carrying the original tracking ID.
            strict: Raise if the message is missing. Otherwise, log a warning.

        Raises:
            RuntimeError: If the message is missing and strict is True.
        """
        tracking_id = message["tracking_id"]
        async with self._message_lock:
            for index in range(len(self.messages) - 1, -1, -1):
                if self.messages[index].get("tracking_id") != tracking_id:
                    continue
                self.messages[index] = message
                break
            else:
                if strict:
                    raise RuntimeError(f"tracking_id=<{tracking_id}> | message not found in history")
                logger.warning("tracking_id=<%s> | message not found in history", tracking_id)
                return
        await self.hooks.invoke_callbacks_async(MessageUpdatedEvent[LocalAgent](self, tracking_id, message))
