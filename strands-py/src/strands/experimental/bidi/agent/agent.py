"""Bidirectional Agent for real-time streaming conversations.

Provides real-time audio and text interaction through persistent streaming connections.
Unlike traditional request-response patterns, this agent maintains long-running
conversations where users can interrupt, provide additional input, and receive
continuous responses including audio output.

Key capabilities:

- Persistent conversation connections with concurrent processing
- Real-time audio input/output streaming
- Automatic interruption detection and tool execution
- Event-driven communication with model providers
"""

import asyncio
import logging
import uuid
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING, Any, ClassVar, Literal

from .... import _identifier
from ...._middleware import MiddlewareRegistry
from ....agent.state import AgentState
from ....hooks import HookCallback, HookOrder, HookProvider, HookRegistry
from ....hooks.registry import TEvent
from ....interrupt import _InterruptState
from ....tools._caller import _ToolCaller
from ....tools.executors import ConcurrentToolExecutor
from ....tools.executors._executor import ToolExecutor
from ....tools.registry import ToolRegistry
from ....tools.tool_provider import ToolProvider
from ....tools.watcher import ToolWatcher
from ....types.agent import LocalAgent
from ....types.content import Message, Messages, SystemContentBlock, _ensure_tracking_id, split_system_prompt
from ....types.tools import AgentTool
from ...hooks.events import BidiAgentInitializedEvent, BidiMessageAddedEvent
from .._async import _TaskGroup, stop_all
from ..models.model import BidiModel
from ..types.agent import BidiAgentInput
from ..types.events import (
    BidiAudioInputEvent,
    BidiImageInputEvent,
    BidiInputEvent,
    BidiOutputEvent,
    BidiTextInputEvent,
)
from ..types.io import BidiInput, BidiOutput
from .loop import _BidiAgentLoop

if TYPE_CHECKING:
    from ....session.session_manager import SessionManager

logger = logging.getLogger(__name__)

_DEFAULT_AGENT_NAME = "Strands Agents"
_DEFAULT_AGENT_ID = "default"


class BidiAgent(LocalAgent):
    """Agent for bidirectional streaming conversations.

    Enables real-time audio and text interaction with AI models through persistent
    connections. Supports concurrent tool execution and interruption handling.
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
            model: BidiModel instance, string model_id, or None for default detection.
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

            self.model = BedrockNovaSonicModel()
        else:
            raise TypeError("model must be a BidiModel, string, or None")

        self._system_prompt, self._system_prompt_content = split_system_prompt(system_prompt)
        self.messages = messages or []

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

        self._loop = _BidiAgentLoop(self)

        # Emit initialization event
        self.hooks.invoke_callbacks(BidiAgentInitializedEvent(agent=self))

        # TODO: Determine if full support is required
        self._interrupt_state = _InterruptState()

        # Empty registry so the shared ToolExecutor can invoke ExecuteToolStage uniformly.
        # With no handlers registered, the chain fast-paths straight to the terminal, so
        # bidi tool execution is unaffected until middleware support is formally added.
        self._middleware_registry = MiddlewareRegistry()

        # Lock to ensure that paired messages are added to history in sequence without interference
        self._message_lock = asyncio.Lock()

        self._started = False

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
        return self._system_prompt

    @system_prompt.setter
    def system_prompt(self, value: str | list[SystemContentBlock] | None) -> None:
        """Set the system prompt and retain its structured content representation."""
        self._system_prompt, self._system_prompt_content = split_system_prompt(value)

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
            invocation_state: Optional context to pass to tools during execution.
                This allows passing custom data (user_id, session_id, database connections, etc.)
                that tools can access via their invocation_state parameter.

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

    async def send(self, input_data: BidiAgentInput | dict[str, Any]) -> None:
        """Send input to the model (text, audio, image, or event dict).

        Unified method for sending text, audio, and image input to the model during
        an active conversation session. Accepts TypedEvent instances or plain dicts
        (e.g., from WebSocket clients) which are automatically reconstructed.

        Args:
            input_data: Can be:

                - str: Text message from user
                - BidiInputEvent: TypedEvent
                - dict: Event dictionary (will be reconstructed to TypedEvent)

        Raises:
            RuntimeError: If start has not been called.
            ValueError: If invalid input type.

        Example:
            await agent.send("Hello")
            await agent.send(BidiAudioInputEvent(audio="base64...", format="pcm", ...))
            await agent.send({"type": "bidirectional_text_input", "text": "Hello", "role": "user"})
        """
        if not self._started:
            raise RuntimeError("agent not started | call start before sending")

        input_event: BidiInputEvent

        if isinstance(input_data, str):
            input_event = BidiTextInputEvent(text=input_data)

        elif isinstance(input_data, BidiInputEvent):
            input_event = input_data

        elif isinstance(input_data, dict) and "type" in input_data:
            input_type = input_data["type"]
            input_data = {key: value for key, value in input_data.items() if key != "type"}
            if input_type == "bidi_text_input":
                input_event = BidiTextInputEvent(**input_data)
            elif input_type == "bidi_audio_input":
                input_event = BidiAudioInputEvent(**input_data)
            elif input_type == "bidi_image_input":
                input_event = BidiImageInputEvent(**input_data)
            else:
                raise ValueError(f"input_type=<{input_type}> | input type not supported")

        else:
            raise ValueError("invalid input | must be str, BidiInputEvent, or event dict")

        await self._loop.send(input_event)

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
        self, inputs: list[BidiInput], outputs: list[BidiOutput], invocation_state: dict[str, Any] | None = None
    ) -> None:
        """Run the agent using provided IO channels for bidirectional communication.

        Args:
            inputs: Input callables to read data from a source
            outputs: Output callables to receive events from the agent
            invocation_state: Optional context to pass to tools during execution.
                This allows passing custom data (user_id, session_id, database connections, etc.)
                that tools can access via their invocation_state parameter.

        Example:
            ```python
            # Using model defaults:
            model = BedrockNovaSonicModel()
            audio_io = BidiAudioIO()
            text_io = BidiTextIO()
            agent = BidiAgent(model=model, tools=[calculator])
            await agent.run(
                inputs=[audio_io.input()],
                outputs=[audio_io.output(), text_io.output()],
                invocation_state={"user_id": "user_123"}
            )

            # Using custom audio config:
            model = BedrockNovaSonicModel(
                audio={
                    "input_rate": 48000,
                    "output_rate": 24000,
                }
            )
            audio_io = BidiAudioIO()
            agent = BidiAgent(model=model, tools=[calculator])
            await agent.run(
                inputs=[audio_io.input()],
                outputs=[audio_io.output()],
            )
            ```
        """

        async def run_inputs() -> None:
            async def task(input_: BidiInput) -> None:
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

            input_starts = [input_.start for input_ in inputs if isinstance(input_, BidiInput)]
            output_starts = [output.start for output in outputs if isinstance(output, BidiOutput)]
            for start in [*input_starts, *output_starts]:
                await start(self)

            async with _TaskGroup() as task_group:
                inputs_task = task_group.create_task(run_inputs())
                task_group.create_task(run_outputs(inputs_task))

        finally:
            input_stops = [input_.stop for input_ in inputs if isinstance(input_, BidiInput)]
            output_stops = [output.stop for output in outputs if isinstance(output, BidiOutput)]

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
                await self.hooks.invoke_callbacks_async(BidiMessageAddedEvent(agent=self, message=message))
