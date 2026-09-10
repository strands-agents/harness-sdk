"""Agent Interface.

This module implements the core Agent class that serves as the primary entry point for interacting with foundation
models and tools in the SDK.

The Agent interface supports two complementary interaction patterns:

1. Natural language for conversation: `agent("Analyze this data")`
2. Method-style for direct tool access: `agent.tool.tool_name(param1="value")`
"""

import asyncio
import copy
import logging
import threading
import uuid
import warnings
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from typing import (
    TYPE_CHECKING,
    Any,
    ClassVar,
    Literal,
    TypeVar,
    Union,
    cast,
    get_args,
)

from opentelemetry import trace as trace_api
from pydantic import BaseModel

from .. import _identifier
from .._async import run_async
from ..background_tasks import BackgroundTasksConfig
from ..event_loop._retry import ModelRetryStrategy
from ..event_loop.event_loop import INITIAL_DELAY, MAX_ATTEMPTS, MAX_DELAY, event_loop_cycle
from ..experimental.checkpoint import Checkpoint, CheckpointPosition
from ..tools._tool_helpers import generate_missing_tool_result_content
from ..types._snapshot import (
    SNAPSHOT_SCHEMA_VERSION,
    Snapshot,
    SnapshotField,
    SnapshotPreset,
    resolve_snapshot_fields,
)

if TYPE_CHECKING:
    from .._context_manager.context_manager import ContextManager
    from ..background_tasks._background_tasks import _BackgroundTasks
    from ..tools import ToolProvider
from .._middleware import MiddlewareRegistry
from .._middleware.stages import AgentStreamContext, AgentStreamStage
from ..handlers.callback_handler import PrintingCallbackHandler, null_callback_handler
from ..hooks import (
    AfterInvocationEvent,
    AgentInitializedEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    HookCallback,
    HookOrder,
    HookProvider,
    HookRegistry,
    MessageAddedEvent,
)
from ..hooks.registry import TEvent
from ..interrupt import InterruptException, _InterruptState
from ..interventions.handler import InterventionHandler
from ..interventions.registry import InterventionRegistry
from ..memory import MemoryManager, MemoryManagerConfig
from ..models.bedrock import BedrockModel
from ..models.model import Model, _ModelPlugin
from ..models.routing import ModelRouter
from ..plugins import Plugin
from ..plugins.registry import _PluginRegistry
from ..sandbox import Sandbox
from ..sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from ..session.session_manager import SessionManager
from ..storage import Storage
from ..telemetry.metrics import EventLoopMetrics
from ..telemetry.tracer import get_tracer, serialize
from ..tools._caller import _ToolCaller
from ..tools.executors import ConcurrentToolExecutor
from ..tools.executors._executor import ToolExecutor
from ..tools.registry import ToolRegistry
from ..tools.structured_output._structured_output_context import StructuredOutputContext
from ..tools.watcher import ToolWatcher
from ..types._events import AgentResultEvent, EventLoopStopEvent, InitEventLoopEvent, ModelStreamChunkEvent, TypedEvent
from ..types.agent import AgentInput, ConcurrentInvocationMode, Limits, LocalAgent
from ..types.content import (
    ContentBlock,
    Message,
    Messages,
    SystemContentBlock,
    _ensure_tracking_id,
    split_system_prompt,
)
from ..types.exceptions import ConcurrencyException, ContextWindowOverflowException
from ..types.tools import AgentTool
from ..types.traces import AttributeValue
from . import _continuation
from ._agent_as_tool import _AgentAsTool
from ._concurrency import _ConcurrencyController
from .agent_metadata import AgentMetadata
from .agent_result import AgentResult
from .base import AgentBase
from .conversation_manager import (
    ConversationManager,
    NullConversationManager,
    SlidingWindowConversationManager,
)
from .state import AgentState

logger = logging.getLogger(__name__)

# How often the watcher mirrors a caller-owned cancel signal onto the agent's internal one.
_CANCEL_POLL_INTERVAL = 0.05


async def _link_cancel_signal(external: threading.Event, internal: threading.Event) -> None:
    """Mirror a caller-owned cancellation event onto the agent's internal event.

    Args:
        external: Caller-owned event. Never set or cleared here.
        internal: The agent's event, which every cancellation checkpoint reads.
    """
    # threading.Event has no async notification hook. Poll on this loop rather than
    # running Event.wait() in an executor: cancelling that await cannot stop a worker
    # already blocked in Event.wait(), so completed invocations could strand worker threads.
    while not external.is_set():
        await asyncio.sleep(_CANCEL_POLL_INTERVAL)

    internal.set()


# TypeVar for generic structured output
T = TypeVar("T", bound=BaseModel)


# Sentinel class and object to distinguish between explicit None and default parameter value
class _DefaultCallbackHandlerSentinel:
    """Sentinel class to distinguish between explicit None and default parameter value."""

    pass


class _DefaultRetryStrategySentinel:
    """Sentinel class to distinguish between explicit None and default parameter value for retry_strategy."""

    pass


_DEFAULT_CALLBACK_HANDLER = _DefaultCallbackHandlerSentinel()
_DEFAULT_RETRY_STRATEGY = _DefaultRetryStrategySentinel()
_DEFAULT_AGENT_NAME = "Strands Agents"
_DEFAULT_AGENT_ID = "default"

ContextManagerStrategy = Literal["auto", "agentic"]
"""Supported values for the ``context_manager`` parameter.

- ``"auto"``: SummarizingConversationManager with proactive compression + ContextOffloader.
- ``"agentic"``: (Experimental) Lets the model drive context management via injected tools.
  This mode may change in future versions.
- ``ContextManager`` instance: Strategy-driven offloading with overflow recovery.
- ``False``: Explicitly disable all context management.
- ``None``: Uses the default (same as ``"auto"``).
"""

_CONTEXT_MANAGER_MAX_RESULT_TOKENS = 1_500
"""Benchmark-validated token threshold for offloading tool results."""

_AGENTIC_CONTEXT_MANAGER_MAX_RESULT_TOKENS = 8_000
"""Higher offload threshold for agentic mode - the model manages its own context, so we preserve more inline."""

_CONTEXT_MANAGER_PREVIEW_TOKENS = 750
"""Benchmark-validated preview token count for offloaded results."""

_CONTEXT_MANAGER_SUMMARY_RATIO = 0.3
"""Benchmark-validated ratio of messages to summarize on overflow."""

_CONTEXT_MANAGER_COMPRESSION_THRESHOLD = 0.85
"""Benchmark-validated context window ratio that triggers proactive compression."""


@dataclass
class _PassProgress:
    """What the event loop itself did during one ``AgentStreamStage`` pass.

    Middleware can produce a pass's result without the event loop running at all (a short-circuit),
    which resuming replays harmlessly. Only a result the event loop produced means a resume would
    call the model again.
    """

    event_loop_produced_result: bool = False


class Agent(AgentBase, LocalAgent):
    """Core Agent implementation.

    An agent orchestrates the following workflow:

    1. Receives user input
    2. Processes the input using a language model
    3. Decides whether to use tools to gather information or perform actions
    4. Executes those tools and receives results
    5. Continues reasoning with the new information
    6. Produces a final response
    """

    _is_strands_local_agent: ClassVar[Literal[True]] = True

    # For backwards compatibility
    ToolCaller = _ToolCaller

    def __init__(
        self,
        model: Model | str | ModelRouter | None = None,
        messages: Messages | None = None,
        tools: list[Union[str, dict[str, str], "ToolProvider", Any]] | None = None,
        system_prompt: str | list[SystemContentBlock] | None = None,
        structured_output_model: type[BaseModel] | None = None,
        callback_handler: Callable[..., Any] | _DefaultCallbackHandlerSentinel | None = _DEFAULT_CALLBACK_HANDLER,
        conversation_manager: ConversationManager | None = None,
        record_direct_tool_call: bool = True,
        load_tools_from_directory: bool = False,
        trace_attributes: Mapping[str, AttributeValue] | None = None,
        *,
        agent_id: str | None = None,
        name: str | None = None,
        description: str | None = None,
        state: AgentState | dict | None = None,
        context_manager: "ContextManagerStrategy | ContextManager | Literal[False] | None" = None,
        plugins: list[Plugin] | None = None,
        hooks: list[HookProvider | HookCallback] | None = None,
        interventions: list[InterventionHandler] | None = None,
        session_manager: SessionManager | None = None,
        memory_manager: MemoryManager | MemoryManagerConfig | None = None,
        structured_output_prompt: str | None = None,
        tool_executor: ToolExecutor | None = None,
        retry_strategy: ModelRetryStrategy | _DefaultRetryStrategySentinel | None = _DEFAULT_RETRY_STRATEGY,
        concurrent_invocation_mode: ConcurrentInvocationMode = ConcurrentInvocationMode.THROW,
        checkpointing: bool = False,
        sandbox: Sandbox | None = None,
        storage: Storage | None = None,
        background_tasks: bool | BackgroundTasksConfig | None = None,
    ):
        """Initialize the Agent with the specified configuration.

        Args:
            model: Provider for running inference or a string representing the model-id for Bedrock to use.
                May also be a ``ModelRouter``, whose first candidate is resolved to a concrete model and
                exposed as ``agent.model``. Defaults to strands.models.BedrockModel if None.
            messages: List of initial messages to pre-load into the conversation.
                Defaults to an empty list if None.
            tools: List of tools to make available to the agent.
                Can be specified as:

                - String tool names (e.g., "retrieve")
                - File paths (e.g., "/path/to/tool.py")
                - Imported Python modules (e.g., from strands_tools import current_time)
                - Dictionaries with name/path keys (e.g., {"name": "tool_name", "path": "/path/to/tool.py"})
                - ToolProvider instances for managed tool collections
                - Functions decorated with `@strands.tool` decorator
                - Agent instances (auto-wrapped via `agent.as_tool()` with defaults)

                If provided, only these tools will be available. If None, all tools will be available.
            system_prompt: System prompt to guide model behavior.
                Can be a string or a list of SystemContentBlock objects for advanced features like caching.
                If None, the model will behave according to its default settings.
            structured_output_model: Pydantic model type(s) for structured output.
                When specified, all agent calls will attempt to return structured output of this type.
                This can be overridden on the agent invocation.
                Defaults to None (no structured output).
            callback_handler: Callback for processing events as they happen during agent execution.
                If not provided (using the default), a new PrintingCallbackHandler instance is created.
                If explicitly set to None, null_callback_handler is used.
            conversation_manager: Manager for conversation history and context window.
                Defaults to strands.agent.conversation_manager.SlidingWindowConversationManager if None.
            record_direct_tool_call: Whether to record direct tool calls in message history.
                Defaults to True.
            load_tools_from_directory: Whether to load and automatically reload tools in the `./tools/` directory.
                Defaults to False.
            trace_attributes: Custom trace attributes to apply to the agent's trace span.
            agent_id: Optional ID for the agent, useful for session management and multi-agent scenarios.
                Defaults to "default".
            name: name of the Agent
                Defaults to "Strands Agents".
            description: description of what the Agent does
                Defaults to None.
            state: stateful information for the agent. Can be either an AgentState object, or a json serializable dict.
                Defaults to an empty AgentState object.
            context_manager: Context management strategy. When set to ``"auto"``, composes
                a ContextOffloader plugin (max_result_tokens=1500, preview_tokens=750) with a
                SummarizingConversationManager (summary_ratio=0.3, compression_threshold=0.85)
                using benchmark-validated defaults. If ``conversation_manager`` is also provided,
                the user's conversation manager is used instead. Defaults to None (no context management).

                Note: The offloader uses in-memory storage by default. When an agent-level
                ``storage`` is provided, the offloader uses that instead. Alternatively,
                provide an explicit ``ContextOffloader`` with its own storage via the
                ``plugins`` parameter.
            plugins: List of Plugin instances to extend agent functionality.
                Plugins are initialized with the agent instance after construction and can register hooks,
                modify agent attributes, or perform other setup tasks.
                Defaults to None.
            hooks: Hooks to be added to the agent hook registry. Accepts HookProvider instances
                or plain callable hook callbacks (functions with typed event parameters).
                Defaults to None.
            interventions: List of InterventionHandler instances for agent control.
                Handlers are evaluated in registration order at each lifecycle event.
                Cheapest handlers (authorization, guardrails) should be listed first;
                expensive ones (LLM steering) last. Deny short-circuits immediately,
                Guide feedback accumulates across handlers.
                Defaults to None.
            session_manager: Manager for handling agent sessions including conversation history and state.
                If provided, enables session-based persistence and state management.
            memory_manager: Cross-session memory manager, as a
                :class:`~strands.memory.MemoryManager` or a
                :class:`~strands.memory.MemoryManagerConfig` (auto-wrapped). Registers its
                memory tools; the synchronous ``Agent(...)`` entry point flushes pending
                extraction after each invocation. Defaults to None.
            structured_output_prompt: Custom prompt message used when forcing structured output.
                When using structured output, if the model doesn't automatically use the output tool,
                the agent sends a follow-up message to request structured formatting. This parameter
                allows customizing that message.
                Defaults to "You must format the previous response as structured output."
            tool_executor: Definition of tool execution strategy (e.g., sequential, concurrent, etc.).
            retry_strategy: Strategy for retrying model calls on throttling or other transient errors.
                Defaults to ModelRetryStrategy with max_attempts=6, initial_delay=4s, max_delay=240s.
                Implement a custom HookProvider for custom retry logic, or pass None to disable retries.
            concurrent_invocation_mode: Mode controlling concurrent invocation behavior.
                Defaults to "throw" which raises ConcurrencyException if concurrent invocation is attempted.
                Set to "unsafe_reentrant" to skip lock acquisition entirely, allowing concurrent invocations.
                Warning: "unsafe_reentrant" makes no guarantees about resulting behavior and is provided
                only for advanced use cases where the caller understands the risks.
            checkpointing: When True, the event loop pauses at cycle boundaries
                (after_model, after_tools) and returns ``stop_reason="checkpoint"``
                with a populated ``checkpoint`` field. Resume by passing the
                checkpoint back as ``{"checkpointResume": {"checkpoint": ...}}``.
                The SDK does not capture conversation state in the checkpoint;
                pair with a SessionManager for cross-process state continuity.
                Defaults to False. See :mod:`strands.experimental.checkpoint`.
            sandbox: Execution environment for running commands, code, and file operations.
                When provided, sandbox-aware tools route operations through it via
                ``context.agent.sandbox``. Defaults to ``None``, which falls back to a
                :class:`~strands.sandbox.NotASandboxLocalEnvironment` that runs on the host
                with no isolation.
            storage: Default storage backend for agent subsystems.
                When provided, subsystems that do not have their own explicit storage
                (e.g., ContextOffloader) resolve from this value. Each subsystem
                auto-namespaces under its own prefix (e.g., ``offloader/``) to avoid key
                collisions. Storage specified directly on a subsystem always takes
                precedence over this agent-level default. Defaults to None.
            background_tasks: Background tool execution configuration. Pass ``True`` or a
                :class:`~strands.background_tasks.BackgroundTasksConfig` to let the model run
                tools in the background and receive their results when they finish. Defaults to
                None (disabled).

        Raises:
            ValueError: If agent id contains path separators.
        """
        self._model_router: ModelRouter | None = None
        if isinstance(model, ModelRouter):
            self._model_router = model
            self.model = model.default_model
        elif not model:
            self.model = BedrockModel()
        elif isinstance(model, str):
            self.model = BedrockModel(model_id=model)
        else:
            self.model = model
        self.messages = messages if messages is not None else []
        if sandbox is not None and not isinstance(sandbox, Sandbox):
            raise TypeError(f"sandbox must be a Sandbox instance or None, got {type(sandbox).__name__}")
        # Resolve once: configured sandbox, or this agent's own host default (not shared across agents).
        self._sandbox: Sandbox = sandbox or NotASandboxLocalEnvironment()
        self._storage: Storage | None = storage
        # initializing self._system_prompt for backwards compatibility
        self._system_prompt, self._system_prompt_content = split_system_prompt(system_prompt)
        self._default_structured_output_model = structured_output_model
        self._structured_output_prompt = structured_output_prompt
        self.agent_id = _identifier.validate(agent_id or _DEFAULT_AGENT_ID, _identifier.Identifier.AGENT)
        self.name = name or _DEFAULT_AGENT_NAME
        self.description = description

        # If not provided, create a new PrintingCallbackHandler instance
        # If explicitly set to None, use null_callback_handler
        # Otherwise use the passed callback_handler
        self.callback_handler: Callable[..., Any] | PrintingCallbackHandler
        if isinstance(callback_handler, _DefaultCallbackHandlerSentinel):
            self.callback_handler = PrintingCallbackHandler()
        elif callback_handler is None:
            self.callback_handler = null_callback_handler
        else:
            self.callback_handler = callback_handler

        if self.model.stateful and (conversation_manager is not None or context_manager not in (None, False)):
            raise ValueError(
                "context_manager and conversation_manager cannot be used with a stateful model. "
                "The model manages conversation state server-side."
            )

        resolved_conversation_manager, resolved_plugins = self._resolve_context_manager(
            context_manager, conversation_manager, plugins
        )

        self.conversation_manager: ConversationManager
        if self.model.stateful:
            self.conversation_manager = NullConversationManager()
        elif resolved_conversation_manager:
            self.conversation_manager = resolved_conversation_manager
        elif conversation_manager:
            self.conversation_manager = conversation_manager
        else:
            self.conversation_manager = SlidingWindowConversationManager()

        # Process trace attributes to ensure they're of compatible types
        self.trace_attributes: dict[str, AttributeValue] = {}
        if trace_attributes:
            for k, v in trace_attributes.items():
                if isinstance(v, (str, int, float, bool)) or (
                    isinstance(v, list) and all(isinstance(x, (str, int, float, bool)) for x in v)
                ):
                    self.trace_attributes[k] = v

        self.record_direct_tool_call = record_direct_tool_call
        self.load_tools_from_directory = load_tools_from_directory

        # Create internal cancel signal for graceful cancellation using threading.Event
        self._cancel_signal = threading.Event()
        # Caller-owned external cancel signal for the current invocation, if any.
        self._external_cancel_signal: threading.Event | None = None

        self.tool_registry = ToolRegistry()

        # Process tool list if provided
        if tools is not None:
            self.tool_registry.process_tools(tools)

        # Inject the model-driven context-management tools when running in agentic mode.
        if context_manager == "agentic":
            from .._context_manager.modes.agentic.agentic_context import (
                pin_context,
                summarize_context,
                truncate_context,
            )

            self.tool_registry.process_tools([summarize_context, truncate_context, pin_context])

        # Initialize tools and configuration
        self.tool_registry.initialize_tools(self.load_tools_from_directory)
        if load_tools_from_directory:
            self.tool_watcher = ToolWatcher(tool_registry=self.tool_registry)

        # Register tools vended by the sandbox. The host default vends nothing. A tool
        # is skipped if the user already registered one with that name.
        for sandbox_tool in self._sandbox.get_tools():
            if sandbox_tool.tool_name in self.tool_registry.registry:
                logger.debug(
                    "tool_name=<%s> | sandbox-vended tool skipped, user already registered a tool with this name",
                    sandbox_tool.tool_name,
                )
            else:
                self.tool_registry.register_tool(sandbox_tool)

        self.event_loop_metrics = EventLoopMetrics()

        # Initialize tracer instance (no-op if not configured)
        self.tracer = get_tracer()
        self.trace_span: trace_api.Span | None = None

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

        self.tool_caller = _ToolCaller(self)

        self.hooks = HookRegistry()

        self._middleware_registry = MiddlewareRegistry()
        self._plugin_registry = _PluginRegistry(self)

        # Input handlers preserve registration order, so initialize routing before capability middleware.
        if self._model_router is not None:
            self._plugin_registry.add_and_init(self._model_router)

        # In agentic mode, surface live token usage to the model so it can decide when to compress.
        if context_manager == "agentic":
            from .._context_manager.modes.agentic.agentic_context import create_token_usage_middleware
            from .._middleware.stages import InvokeModelStage

            self._middleware_registry.add_middleware(InvokeModelStage.Input, create_token_usage_middleware())

        self._interrupt_state = _InterruptState()

        # Checkpointing: pause at cycle boundaries when enabled.
        self._checkpointing: bool = checkpointing
        self._checkpoint: Checkpoint | None = None
        self._checkpoint_cycle_index: int = 0
        self._checkpoint_resume_position: CheckpointPosition | None = None

        # Runtime state for model providers (e.g., server-side response ids)
        self._model_state: dict[str, Any] = {}

        self._concurrency = _ConcurrencyController(concurrent_invocation_mode)

        if (
            retry_strategy is not None
            and not isinstance(retry_strategy, _DefaultRetryStrategySentinel)
            and not isinstance(retry_strategy, ModelRetryStrategy)
        ):
            raise ValueError("retry_strategy must be an instance of ModelRetryStrategy")

        # If not provided (using the default), create a new ModelRetryStrategy instance
        # If explicitly set to None, disable retries (max_attempts=1 means no retries)
        # Otherwise use the passed retry_strategy
        if isinstance(retry_strategy, _DefaultRetryStrategySentinel):
            self._retry_strategy = ModelRetryStrategy(
                max_attempts=MAX_ATTEMPTS, max_delay=MAX_DELAY, initial_delay=INITIAL_DELAY
            )
        elif retry_strategy is None:
            # If no retry strategy is passed in, then we turn retries off
            self._retry_strategy = ModelRetryStrategy(max_attempts=1)
        else:
            self._retry_strategy = retry_strategy

        # Initialize session management functionality
        self._session_manager = session_manager
        if self._session_manager:
            self._session_id: str = getattr(self._session_manager, "session_id", None) or uuid.uuid4().hex[:8]
            self.hooks.add_hook(self._session_manager)
        else:
            self._session_id = uuid.uuid4().hex[:8]

        # Allow conversation_managers to subscribe to hooks
        self.hooks.add_hook(self.conversation_manager)

        # Register retry strategy as a hook
        self.hooks.add_hook(self._retry_strategy)

        self.tool_executor = tool_executor or ConcurrentToolExecutor()

        self._background_tasks: _BackgroundTasks | None = None
        if background_tasks is not None and background_tasks is not False:
            from ..background_tasks._background_tasks import _BackgroundTasks as _BackgroundTasksPlugin

            self._background_tasks = _BackgroundTasksPlugin({} if background_tasks is True else background_tasks)

        if hooks:
            for hook in hooks:
                if isinstance(hook, HookProvider):
                    self.hooks.add_hook(hook)
                elif callable(hook):
                    self.hooks.add_callback(None, hook)
                else:
                    raise ValueError(
                        f"Invalid hook: {hook!r}. Must be a HookProvider instance or a callable hook callback."
                    )

        # Register intervention handlers
        self._intervention_registry = InterventionRegistry(interventions or [], self.hooks)

        # Register built-in plugins
        self._plugin_registry.add_and_init(_ModelPlugin())

        plugins_to_register = resolved_plugins if resolved_plugins is not None else plugins
        if plugins_to_register:
            for plugin in plugins_to_register:
                self._plugin_registry.add_and_init(plugin)

        if self._background_tasks is not None:
            self._plugin_registry.add_and_init(self._background_tasks)

        has_agent_delegation = any(plugin.name == "strands:agent-delegation" for plugin in (plugins_to_register or []))
        if not has_agent_delegation:
            from ._agent_delegation import AgentDelegation

            self._plugin_registry.add_and_init(AgentDelegation())

        # Resolve and register the memory manager (a Plugin); keep a reference so the
        # synchronous entry point can flush pending extraction writes.
        self.memory_manager = self._resolve_memory_manager(memory_manager)
        if self.memory_manager is not None:
            if self.memory_manager.name in self._plugin_registry._plugins:
                raise ValueError(
                    "A MemoryManager is already registered via plugins; pass it through the "
                    "memory_manager parameter instead"
                )
            self._plugin_registry.add_and_init(self.memory_manager)

        self.hooks.invoke_callbacks(AgentInitializedEvent(agent=self))

    @staticmethod
    def _resolve_context_manager(
        context_manager: "ContextManagerStrategy | ContextManager | Literal[False] | None",
        conversation_manager: ConversationManager | None,
        plugins: list[Plugin] | None,
    ) -> tuple[ConversationManager | None, list[Plugin] | None]:
        """Resolve context_manager facade into concrete conversation_manager and plugins.

        When context_manager is None, returns (None, None) and no resolution occurs.
        When False, uses NullConversationManager (or user-provided).
        When a ContextManager instance, uses NullConversationManager and registers the plugin.
        When "auto", constructs a SummarizingConversationManager with proactive compression
        plus a ContextOffloader, using benchmark-validated defaults.
        When "agentic", constructs a SummarizingConversationManager *without* proactive
        compression (the model drives context management via injected tools; the conversation
        manager is only a reactive overflow safety net) plus a ContextOffloader with a higher
        offload threshold. In both cases a user-provided conversation_manager / offloader wins.

        Args:
            context_manager: The facade value ("auto", "agentic", ContextManager, False, or None).
            conversation_manager: User-provided conversation manager, takes precedence if set.
            plugins: User-provided plugin list; offloader is appended if not already present.

        Returns:
            Tuple of (resolved conversation manager, resolved plugins list).
            Both are None when context_manager is None.

        Raises:
            ValueError: If context_manager is not a supported value.
        """
        if context_manager is None:
            return None, None

        from .._context_manager.context_manager import ContextManager as _ContextManager
        from ..vended_plugins.context_offloader import ContextOffloader
        from .conversation_manager import NullConversationManager, SummarizingConversationManager

        if context_manager is False:
            resolved_cm = conversation_manager if conversation_manager is not None else NullConversationManager()
            return resolved_cm, list(plugins) if plugins else None

        if isinstance(context_manager, _ContextManager):
            resolved_plugins = list(plugins) if plugins else []
            resolved_plugins.append(context_manager)
            return NullConversationManager(), resolved_plugins

        if context_manager == "auto":
            offloader_max_result_tokens = _CONTEXT_MANAGER_MAX_RESULT_TOKENS
            default_conversation_manager = SummarizingConversationManager(
                summary_ratio=_CONTEXT_MANAGER_SUMMARY_RATIO,
                proactive_compression={"compression_threshold": _CONTEXT_MANAGER_COMPRESSION_THRESHOLD},
            )
        elif context_manager == "agentic":
            # No proactive compression: the model manages context via injected tools.
            offloader_max_result_tokens = _AGENTIC_CONTEXT_MANAGER_MAX_RESULT_TOKENS
            default_conversation_manager = SummarizingConversationManager(
                summary_ratio=_CONTEXT_MANAGER_SUMMARY_RATIO,
            )
        else:
            raise ValueError(
                f"Unsupported context_manager value: {context_manager!r}. "
                f"Supported values: {get_args(ContextManagerStrategy)}, ContextManager instance, or False"
            )

        resolved_plugins = list(plugins) if plugins else []

        has_offloader = any(isinstance(p, ContextOffloader) for p in resolved_plugins)
        if not has_offloader:
            resolved_plugins.append(
                ContextOffloader(
                    max_result_tokens=offloader_max_result_tokens,
                    preview_tokens=_CONTEXT_MANAGER_PREVIEW_TOKENS,
                )
            )

        resolved_conversation_manager = (
            conversation_manager if conversation_manager is not None else default_conversation_manager
        )

        return resolved_conversation_manager, resolved_plugins

    @staticmethod
    def _resolve_memory_manager(
        memory_manager: MemoryManager | MemoryManagerConfig | None,
    ) -> MemoryManager | None:
        """Resolve the ``memory_manager`` argument into a MemoryManager instance or None.

        A :class:`~strands.memory.MemoryManagerConfig` is wrapped into a
        :class:`~strands.memory.MemoryManager`; an instance passes through.
        """
        if memory_manager is None:
            return None

        if isinstance(memory_manager, MemoryManager):
            return memory_manager
        if isinstance(memory_manager, dict):
            return MemoryManager(**memory_manager)
        raise ValueError("memory_manager must be a MemoryManager or MemoryManagerConfig")

    def cancel(self) -> None:
        """Cancel the currently running agent invocation.

        This method is thread-safe and can be called from any context
        (e.g., another thread, web request handler, background task).

        The agent will stop gracefully at the next cancellation-safe point:
        - During model response streaming
        - Before tool execution
        - During MCP tool execution
        - After tool execution, before the next model call

        The agent will return a result with stop_reason="cancelled".

        For cancellation driven from outside the agent (a client disconnect, a request
        lifecycle, a timeout), pass a ``cancel_signal`` into the invocation instead. The agent
        observes both, so either cancels independently.

        Example:
            ```python
            agent = Agent(model=model)

            # Start agent in background
            task = asyncio.create_task(agent.invoke_async("Hello"))

            # Cancel from another context
            agent.cancel()

            result = await task
            assert result.stop_reason == "cancelled"
            ```

        Note:
            Multiple calls to cancel() are safe and idempotent.
        """
        self._cancel_signal.set()

    @property
    def cancel_signal(self) -> threading.Event:
        """The cancellation signal for the current invocation.

        Set by :meth:`cancel` and by a ``cancel_signal`` passed into the invocation. SDK-built tool
        contexts receive this same event as ``tool_context.cancel_signal``, and hooks can check
        ``event.agent.cancel_signal.is_set()``. Cleared when an invocation completes, so the agent
        stays reusable.

        Treat as read-only: call :meth:`cancel` to trigger cancellation. Setting or clearing this
        event directly is unsupported.
        """
        return self._cancel_signal

    @property
    def sandbox(self) -> Sandbox:
        """Execution environment for running commands, code, and file operations.

        Returns the configured sandbox, or a per-agent host default
        (:class:`~strands.sandbox.NotASandboxLocalEnvironment`, no isolation) when none was
        configured.
        """
        return self._sandbox

    @property
    def storage(self) -> Storage | None:
        """Default storage backend for agent subsystems."""
        return self._storage

    @property
    def session_id(self) -> str:
        """Identifier for the current conversation session.

        When a session manager is attached, returns its persistent, caller-supplied
        session ID. Otherwise, returns a random 8-character hex string generated at
        construction time (unique per agent instance but not persisted across restarts).
        """
        return self._session_id

    @property
    def _metadata(self) -> AgentMetadata:
        """Build the agent metadata view passed to the model on stream()."""
        session_id = getattr(self._session_manager, "session_id", None) or None
        return AgentMetadata(session_id=session_id)

    @property
    def system_prompt(self) -> str | None:
        """Get the system prompt as a string for backwards compatibility.

        Returns the system prompt as a concatenated string when it contains text content,
        or None if no text content is present. This maintains backwards compatibility
        with existing code that expects system_prompt to be a string.

        Returns:
            The system prompt as a string, or None if no text content exists.
        """
        return self._system_prompt

    @system_prompt.setter
    def system_prompt(self, value: str | list[SystemContentBlock] | None) -> None:
        """Set the system prompt and update internal content representation.

        Accepts either a string or list of SystemContentBlock objects.
        When set, both the backwards-compatible string representation and the internal
        content block representation are updated to maintain consistency.

        Args:
            value: System prompt as string, list of SystemContentBlock objects, or None.
                  - str: Simple text prompt (most common use case)
                  - list[SystemContentBlock]: Content blocks with features like caching
                  - None: Clear the system prompt
        """
        self._system_prompt, self._system_prompt_content = split_system_prompt(value)

    @property
    def system_prompt_content(self) -> list[SystemContentBlock] | None:
        """Get the system prompt as a list of content blocks.

        Returns the structured content block representation, preserving cache points
        and other non-text blocks. Returns None if no system prompt is set.

        Returns:
            The system prompt as a list of content blocks, or None if no system prompt is set.
        """
        return list(self._system_prompt_content) if self._system_prompt_content is not None else None

    @property
    def tool(self) -> _ToolCaller:
        """Call tool as a function.

        Returns:
            Tool caller through which user can invoke tool as a function.

        Example:
            ```
            agent = Agent(tools=[calculator])
            agent.tool.calculator(...)
            ```
        """
        return self.tool_caller

    @property
    def tool_names(self) -> list[str]:
        """Get a list of all registered tool names.

        Returns:
            Names of all tools available to this agent.
        """
        all_tools = self.tool_registry.get_all_tools_config()
        return list(all_tools.keys())

    @property
    def concurrent_invocation_mode(self) -> ConcurrentInvocationMode:
        """The concurrency posture this agent was configured with.

        Mirrors the ``concurrent_invocation_mode`` constructor argument.
        """
        return self._concurrency.mode

    def __call__(
        self,
        prompt: AgentInput = None,
        *,
        invocation_state: dict[str, Any] | None = None,
        structured_output_model: type[BaseModel] | None = None,
        structured_output_prompt: str | None = None,
        idempotency_token: Any = None,
        limits: Limits | None = None,
        cancel_signal: threading.Event | None = None,
        **kwargs: Any,
    ) -> AgentResult:
        """Process a natural language prompt through the agent's event loop.

        This method implements the conversational interface with multiple input patterns:
        - String input: `agent("hello!")`
        - ContentBlock list: `agent([{"text": "hello"}, {"image": {...}}])`
        - Message list: `agent([{"role": "user", "content": [{"text": "hello"}]}])`
        - No input: `agent()` - uses existing conversation history

        Args:
            prompt: User input in various formats:
                - str: Simple text input
                - list[ContentBlock]: Multi-modal content blocks
                - list[Message]: Complete messages with roles
                - None: Use existing conversation history
            invocation_state: Additional parameters to pass through the event loop.
            structured_output_model: Pydantic model type(s) for structured output (overrides agent default).
            structured_output_prompt: Custom prompt for forcing structured output (overrides agent default).
            idempotency_token: Dedup token for THROW mode (ignored in UNSAFE_REENTRANT). If a matching
                token is already inflight, this call blocks until the original finishes, then gets its
                final result — only the result, not the streamed events, though ``callback_handler``
                still fires once with it. Matched by ``==`` (any equatable object; need not be hashable).
                Raises ``IdempotencyAbortedError`` if the original is aborted before producing a result.
            limits: Per-invocation budget caps (turns / output_tokens / total_tokens).
                See :class:`~strands.types.agent.Limits`. When a cap is reached, the loop
                terminates gracefully at the next turn boundary with a corresponding
                ``stop_reason`` (e.g. ``"limit_turns"``); no exception is raised. Token
                caps are soft — a single oversized model response can overshoot the budget
                by one turn, since checks run at turn boundaries, not within a model call.
            cancel_signal: Caller-owned event that cancels this invocation. Use it when cancellation is
                driven from outside the agent — a client disconnect, a request lifecycle, a timeout. The
                agent observes both this event and ``cancel()``, so either cancels independently, and it
                never sets or clears the caller's event. An event that is already set cancels the
                invocation at its first checkpoint; that checkpoint sits inside model streaming, so
                the user turn is still recorded and one model request may be issued, then aborted.
                Clear the event before reusing it for another invocation. On cancellation the
                result carries ``stop_reason="cancelled"``. A duplicate call waiting on an
                ``idempotency_token`` does not observe this event; only the primary invocation
                does.
            **kwargs: Additional parameters to pass through the event loop.[Deprecating]

        Returns:
            Result object containing:

                - stop_reason: Why the event loop stopped (e.g., "end_turn", "max_tokens")
                - message: The final message from the model
                - metrics: Performance metrics from the event loop
                - state: The final state of the event loop
                - structured_output: Parsed structured output when structured_output_model was specified

        Raises:
            ConcurrencyException: If another invocation is already in progress on this agent instance.
            IdempotencyAbortedError: If this call is a duplicate of an inflight ``idempotency_token``
                whose primary invocation was aborted before producing a result.
            TypeError: If a value in ``limits`` is not a positive integer.
            Exception: Any exceptions from the agent invocation will be propagated to the caller.
        """
        return run_async(
            lambda: self._invoke_async_and_flush(
                prompt,
                invocation_state=invocation_state,
                structured_output_model=structured_output_model,
                structured_output_prompt=structured_output_prompt,
                idempotency_token=idempotency_token,
                limits=limits,
                cancel_signal=cancel_signal,
                **kwargs,
            )
        )

    async def _invoke_async_and_flush(self, prompt: AgentInput = None, **kwargs: Any) -> AgentResult:
        """Run ``invoke_async`` then flush the memory manager within this loop.

        The synchronous entry point runs each invocation in its own event loop, which would
        cancel background extraction saves on close. Flushing here persists them. The async
        path does not flush, leaving extraction on its trigger cadence.
        """
        try:
            return await self.invoke_async(prompt, **kwargs)
        finally:
            if self.memory_manager is not None:
                await self.memory_manager.flush()

    async def invoke_async(
        self,
        prompt: AgentInput = None,
        *,
        invocation_state: dict[str, Any] | None = None,
        structured_output_model: type[BaseModel] | None = None,
        structured_output_prompt: str | None = None,
        idempotency_token: Any = None,
        limits: Limits | None = None,
        cancel_signal: threading.Event | None = None,
        **kwargs: Any,
    ) -> AgentResult:
        """Process a natural language prompt through the agent's event loop.

        This method implements the conversational interface with multiple input patterns:
        - String input: Simple text input
        - ContentBlock list: Multi-modal content blocks
        - Message list: Complete messages with roles
        - No input: Use existing conversation history

        Args:
            prompt: User input in various formats:
                - str: Simple text input
                - list[ContentBlock]: Multi-modal content blocks
                - list[Message]: Complete messages with roles
                - None: Use existing conversation history
            invocation_state: Additional parameters to pass through the event loop.
            structured_output_model: Pydantic model type(s) for structured output (overrides agent default).
            structured_output_prompt: Custom prompt for forcing structured output (overrides agent default).
            idempotency_token: Dedup token for THROW mode (ignored in UNSAFE_REENTRANT). If a matching
                token is already inflight, this call blocks until the original finishes, then gets its
                final result — only the result, not the streamed events, though ``callback_handler``
                still fires once with it. Matched by ``==`` (any equatable object; need not be hashable).
                Raises ``IdempotencyAbortedError`` if the original is aborted before producing a result.
            limits: Per-invocation budget caps (turns / output_tokens / total_tokens).
                See :class:`~strands.types.agent.Limits`. When a cap is reached, the loop
                terminates gracefully at the next turn boundary with a corresponding
                ``stop_reason`` (e.g. ``"limit_turns"``); no exception is raised. Token
                caps are soft — a single oversized model response can overshoot the budget
                by one turn, since checks run at turn boundaries, not within a model call.
            cancel_signal: Caller-owned event that cancels this invocation. Use it when cancellation is
                driven from outside the agent — a client disconnect, a request lifecycle, a timeout. The
                agent observes both this event and ``cancel()``, so either cancels independently, and it
                never sets or clears the caller's event. An event that is already set cancels the
                invocation at its first checkpoint; that checkpoint sits inside model streaming, so
                the user turn is still recorded and one model request may be issued, then aborted.
                Clear the event before reusing it for another invocation. On cancellation the
                result carries ``stop_reason="cancelled"``. A duplicate call waiting on an
                ``idempotency_token`` does not observe this event; only the primary invocation
                does.
            **kwargs: Additional parameters to pass through the event loop.[Deprecating]

        Returns:
            Result: object containing:

                - stop_reason: Why the event loop stopped (e.g., "end_turn", "max_tokens")
                - message: The final message from the model
                - metrics: Performance metrics from the event loop
                - state: The final state of the event loop

        Raises:
            ConcurrencyException: If another invocation is already in progress on this agent instance.
            IdempotencyAbortedError: If this call is a duplicate of an inflight ``idempotency_token``
                whose primary invocation was aborted before producing a result.
            TypeError: If a value in ``limits`` is not a positive integer.
            Exception: Any exceptions from the agent invocation will be propagated to the caller.
        """
        events = self.stream_async(
            prompt,
            invocation_state=invocation_state,
            structured_output_model=structured_output_model,
            structured_output_prompt=structured_output_prompt,
            idempotency_token=idempotency_token,
            limits=limits,
            cancel_signal=cancel_signal,
            **kwargs,
        )
        async for event in events:
            _ = event

        return cast(AgentResult, event["result"])

    def structured_output(self, output_model: type[T], prompt: AgentInput = None) -> T:
        """This method allows you to get structured output from the agent.

        If you pass in a prompt, it will be used temporarily without adding it to the conversation history.
        If you don't pass in a prompt, it will use only the existing conversation history to respond.

        For smaller models, you may want to use the optional prompt to add additional instructions to explicitly
        instruct the model to output the structured data.

        Args:
            output_model: The output model (a JSON schema written as a Pydantic BaseModel)
                that the agent will use when responding.
            prompt: The prompt to use for the agent in various formats:
                - str: Simple text input
                - list[ContentBlock]: Multi-modal content blocks
                - list[Message]: Complete messages with roles
                - None: Use existing conversation history

        Raises:
            ValueError: If no conversation history or prompt is provided.
        """
        warnings.warn(
            "Agent.structured_output method is deprecated."
            " You should pass in `structured_output_model` directly into the agent invocation."
            " see: https://strandsagents.com/docs/user-guide/concepts/agents/structured-output/",
            category=DeprecationWarning,
            stacklevel=2,
        )

        return run_async(lambda: self.structured_output_async(output_model, prompt))

    async def structured_output_async(self, output_model: type[T], prompt: AgentInput = None) -> T:
        """This method allows you to get structured output from the agent.

        If you pass in a prompt, it will be used temporarily without adding it to the conversation history.
        If you don't pass in a prompt, it will use only the existing conversation history to respond.

        For smaller models, you may want to use the optional prompt to add additional instructions to explicitly
        instruct the model to output the structured data.

        Args:
            output_model: The output model (a JSON schema written as a Pydantic BaseModel)
                that the agent will use when responding.
            prompt: The prompt to use for the agent (will not be added to conversation history).

        Raises:
            ValueError: If no conversation history or prompt is provided.
        -
        """
        if self._interrupt_state.activated:
            raise RuntimeError("cannot call structured output during interrupt")

        warnings.warn(
            "Agent.structured_output_async method is deprecated."
            " You should pass in `structured_output_model` directly into the agent invocation."
            " see: https://strandsagents.com/docs/user-guide/concepts/agents/structured-output/",
            category=DeprecationWarning,
            stacklevel=2,
        )
        await self.hooks.invoke_callbacks_async(BeforeInvocationEvent(agent=self, invocation_state={}))
        with self.tracer.tracer.start_as_current_span(
            "execute_structured_output", kind=trace_api.SpanKind.CLIENT
        ) as structured_output_span:
            try:
                if not self.messages and not prompt:
                    raise ValueError("No conversation history or prompt provided")

                temp_messages: Messages = self.messages + await self._convert_prompt_to_messages(prompt)

                structured_output_span.set_attributes(
                    {
                        "gen_ai.system": "strands-agents",
                        "gen_ai.agent.name": self.name,
                        "gen_ai.agent.id": self.agent_id,
                        "gen_ai.operation.name": "execute_structured_output",
                    }
                )
                if self.system_prompt:
                    structured_output_span.add_event(
                        "gen_ai.system.message",
                        attributes={"role": "system", "content": serialize([{"text": self.system_prompt}])},
                    )
                for message in temp_messages:
                    structured_output_span.add_event(
                        f"gen_ai.{message['role']}.message",
                        attributes={"role": message["role"], "content": serialize(message["content"])},
                    )
                events = self.model.structured_output(output_model, temp_messages, system_prompt=self.system_prompt)
                async for event in events:
                    if isinstance(event, TypedEvent):
                        event.prepare(invocation_state={})
                        if event.is_callback_event:
                            self.callback_handler(**event.as_dict())

                structured_output_span.add_event(
                    "gen_ai.choice", attributes={"message": serialize(event["output"].model_dump())}
                )
                return event["output"]

            finally:
                await self.hooks.invoke_callbacks_async(AfterInvocationEvent(agent=self, invocation_state={}))

    def as_tool(
        self,
        *,
        name: str | None = None,
        description: str | None = None,
        preserve_context: bool = False,
        delegate: bool = False,
    ) -> AgentTool:
        r"""Convert this agent into a tool for use by another agent.

        Args:
            name: Tool name. Must match the pattern ``[a-zA-Z0-9_\\-]{1,64}``.
                Defaults to the agent's name.
            description: Tool description. Defaults to the agent's description, or a
                generic description if the agent has no description set.
            preserve_context: Whether to preserve the agent's conversation history across
                invocations. When False, the agent's messages and state are reset to the
                values they had at construction time before each call, ensuring every
                invocation starts from the same baseline regardless of any external
                interactions with the agent. Defaults to False.
            delegate: When True, the orchestrator treats this tool's result as the final
                response and exits without an additional model call. The tool's description
                is automatically suffixed with an instruction telling the model that this
                tool should be the only tool called in the turn. Defaults to False.

        Returns:
            A tool wrapping this agent.

        Example:
            ```python
            researcher = Agent(name="researcher", description="Finds information")
            writer = Agent(name="writer", tools=[researcher.as_tool()])
            writer("Write about AI agents")

            # Delegation: sub-agent response is returned directly as the final answer
            billing = Agent(name="billing", description="Handles billing questions")
            orchestrator = Agent(tools=[billing.as_tool(delegate=True)])
            orchestrator("What is my balance?")
            ```
        """
        if not name:
            name = self.name
        return _AgentAsTool(
            self, name=name, description=description, preserve_context=preserve_context, delegate=delegate
        )

    def cleanup(self) -> None:
        """Clean up resources used by the agent.

        This method cleans up all tool providers that require explicit cleanup,
        such as MCP clients. It should be called when the agent is no longer needed
        to ensure proper resource cleanup.

        Note: This method uses a "belt and braces" approach with automatic cleanup
        through finalizers as a fallback, but explicit cleanup is recommended.
        """
        self.tool_registry.cleanup()

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

        Example:
            ```python
            def log_model_call(event: BeforeModelCallEvent) -> None:
                print(f"Calling model for agent: {event.agent.name}")

            agent = Agent()

            # With event type inferred from type hint
            agent.add_hook(log_model_call)

            # With explicit event type
            agent.add_hook(log_model_call, BeforeModelCallEvent)

            # With union type hint (registers for all types)
            def log_event(event: BeforeModelCallEvent | AfterModelCallEvent) -> None:
                print(f"Event: {type(event).__name__}")
            agent.add_hook(log_event)

            # With list of event types
            def multi_handler(event) -> None:
                print(f"Event: {type(event).__name__}")
            agent.add_hook(multi_handler, [BeforeModelCallEvent, AfterModelCallEvent])
            ```
        Docs:
            https://strandsagents.com/docs/user-guide/concepts/agents/hooks/
        """
        self.hooks.add_callback(event_type, callback, order=order)

    def __del__(self) -> None:
        """Clean up resources when agent is garbage collected."""
        # __del__ is called even when an exception is thrown in the constructor,
        # so there is no guarantee tool_registry was set..
        if hasattr(self, "tool_registry"):
            self.tool_registry.cleanup()

    def _observe_cancellation(self) -> bool:
        """Report whether the current invocation is cancelled.

        Mirrors a linked external signal synchronously before reading, so a cancellation
        checkpoint never misses an external cancel that landed between watcher polls.
        """
        external = self._external_cancel_signal
        if external is not None and external.is_set():
            self._cancel_signal.set()
        return self._cancel_signal.is_set()

    def _start_cancel_watcher(self, cancel_signal: threading.Event | None) -> "asyncio.Task[None] | None":
        """Mirror a caller-owned cancellation event onto the internal one for this invocation.

        A signal that is already set is applied synchronously: the watcher task does not run until
        the loop yields, and the first cancellation checkpoint sits inside the model stream.

        Args:
            cancel_signal: Caller-owned event, or None when the caller supplied none.

        Returns:
            The watcher task to tear down when the invocation ends, or None when there is
            nothing to watch.
        """
        if cancel_signal is None:
            return None

        if cancel_signal.is_set():
            self._cancel_signal.set()
            return None

        return asyncio.create_task(_link_cancel_signal(cancel_signal, self._cancel_signal))

    async def stream_async(
        self,
        prompt: AgentInput = None,
        *,
        invocation_state: dict[str, Any] | None = None,
        structured_output_model: type[BaseModel] | None = None,
        structured_output_prompt: str | None = None,
        idempotency_token: Any = None,
        limits: Limits | None = None,
        cancel_signal: threading.Event | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[Any]:
        """Process a natural language prompt and yield events as an async iterator.

        This method provides an asynchronous interface for streaming agent events with multiple input patterns:
        - String input: Simple text input
        - ContentBlock list: Multi-modal content blocks
        - Message list: Complete messages with roles
        - No input: Use existing conversation history

        Args:
            prompt: User input in various formats:
                - str: Simple text input
                - list[ContentBlock]: Multi-modal content blocks
                - list[Message]: Complete messages with roles
                - None: Use existing conversation history
            invocation_state: Additional parameters to pass through the event loop.
            structured_output_model: Pydantic model type(s) for structured output (overrides agent default).
            structured_output_prompt: Custom prompt for forcing structured output (overrides agent default).
            idempotency_token: Dedup token for THROW mode (ignored in UNSAFE_REENTRANT). If a matching
                token is already inflight, this call blocks until the original finishes, then gets its
                final result — only the result, not the streamed events, though ``callback_handler``
                still fires once with it. Matched by ``==`` (any equatable object; need not be hashable).
                Raises ``IdempotencyAbortedError`` if the original is aborted before producing a result.
            limits: Per-invocation budget caps (turns / output_tokens / total_tokens).
                See :class:`~strands.types.agent.Limits`. When a cap is reached, the loop
                terminates gracefully at the next turn boundary with a corresponding
                ``stop_reason`` (e.g. ``"limit_turns"``); no exception is raised. Token
                caps are soft — a single oversized model response can overshoot the budget
                by one turn, since checks run at turn boundaries, not within a model call.
            cancel_signal: Caller-owned event that cancels this invocation. Use it when cancellation is
                driven from outside the agent — a client disconnect, a request lifecycle, a timeout. The
                agent observes both this event and ``cancel()``, so either cancels independently, and it
                never sets or clears the caller's event. An event that is already set cancels the
                invocation at its first checkpoint; that checkpoint sits inside model streaming, so
                the user turn is still recorded and one model request may be issued, then aborted.
                Clear the event before reusing it for another invocation. On cancellation the
                result carries ``stop_reason="cancelled"``. A duplicate call waiting on an
                ``idempotency_token`` does not observe this event; only the primary invocation
                does.
            **kwargs: Additional parameters to pass to the event loop.[Deprecating]

        Yields:
            An async iterator that yields events. Each event is a dictionary containing
                information about the current state of processing, such as:

                - data: Text content being generated
                - complete: Whether this is the final chunk
                - current_tool_use: Information about tools being executed
                - And other event data provided by the callback handler

        Raises:
            ConcurrencyException: If another invocation is already in progress on this agent instance.
            IdempotencyAbortedError: If this call is a duplicate of an inflight ``idempotency_token``
                whose primary invocation was aborted before producing a result.
            TypeError: If a value in ``limits`` is not a positive integer.
            Exception: Any exceptions from the agent invocation will be propagated to the caller.

        Example:
            ```python
            async for event in agent.stream_async("Analyze this data"):
                if "data" in event:
                    yield event["data"]
            ```
        """
        self._validate_limits(limits)

        begin = self._concurrency.begin(idempotency_token)

        if begin.waiting_on is not None:
            logger.debug("idempotency_token=<%s> | duplicate request detected, waiting for original", idempotency_token)
            await begin.waiting_on.register_waiter()
            if begin.waiting_on.error is not None:
                raise begin.waiting_on.error
            if begin.waiting_on.result is not None:
                dup_result = begin.waiting_on.result
                # Mirror the primary path: drive this caller's callback_handler with the
                # deduplicated result before yielding, so callback consumers don't miss it.
                dup_callback_handler = self.callback_handler
                if kwargs:
                    dup_callback_handler = kwargs.get("callback_handler", self.callback_handler)
                dup_callback_handler(result=dup_result)
                yield AgentResultEvent(result=dup_result).as_dict()
            return

        if not begin.lock_acquired:
            exc = ConcurrencyException(
                "Agent is already processing a request. Concurrent invocations are not supported."
            )
            self._concurrency.complete(begin.registered_token, error=exc)
            raise exc

        result: AgentResult | None = None
        cancel_watcher: asyncio.Task[None] | None = None

        try:
            self._external_cancel_signal = cancel_signal
            cancel_watcher = self._start_cancel_watcher(cancel_signal)

            self._interrupt_state.resume(prompt)

            self.event_loop_metrics.reset_usage_metrics()

            # Reset invocation-scoped checkpoint state. On resume, the event loop's
            # priming step re-derives the cycle index from the resumed checkpoint,
            # so this reset only affects the fresh-prompt path.
            self._checkpoint_cycle_index = 0
            self._checkpoint_resume_position = None

            merged_state = {}
            if kwargs:
                warnings.warn("`**kwargs` parameter is deprecating, use `invocation_state` instead.", stacklevel=2)
                merged_state.update(kwargs)
                if invocation_state is not None:
                    merged_state["invocation_state"] = invocation_state
            else:
                if invocation_state is not None:
                    merged_state = invocation_state

            callback_handler = self.callback_handler
            if kwargs:
                callback_handler = kwargs.get("callback_handler", self.callback_handler)

            # Process input and get message to add (if any)
            messages = await self._convert_prompt_to_messages(prompt)

            self.trace_span = self._start_agent_trace_span(messages)

            with trace_api.use_span(self.trace_span):
                try:
                    events = self._run_loop(
                        messages, merged_state, structured_output_model, structured_output_prompt, limits
                    )

                    # The result is the last EventLoopStopEvent, not the last event overall:
                    # AgentStreamStage middleware may yield trailing events after the stop event.
                    stop_event: EventLoopStopEvent | None = None
                    try:
                        async for event in events:
                            event.prepare(invocation_state=merged_state)

                            if isinstance(event, EventLoopStopEvent):
                                stop_event = event

                            if event.is_callback_event:
                                as_dict = event.as_dict()
                                callback_handler(**as_dict)
                                yield as_dict

                        if stop_event is None:
                            raise RuntimeError(
                                "Agent stream produced no result event. AgentStreamStage middleware must "
                                "forward events from next() and must not drop the terminal stop event."
                            )

                        result = AgentResult(*stop_event["stop"])
                        callback_handler(result=result)
                        yield AgentResultEvent(result=result).as_dict()

                        self._end_agent_trace_span(response=result)
                    finally:
                        await events.aclose()

                except Exception as e:
                    self._end_agent_trace_span(error=e)
                    self._concurrency.complete(begin.registered_token, error=e)
                    raise
                except BaseException as cancellation:
                    # Waiter settlement deferred to the finally block (aborted path) — propagating
                    # CancelledError into unrelated waiters would be incorrect.
                    self._end_agent_trace_span(cancellation=cancellation)
                    raise

        finally:
            if cancel_watcher is not None:
                # cancel() is enough: a cancelled task never resumes into internal.set(). Awaiting
                # here would let a second cancellation skip the cleanup below and wedge the agent.
                cancel_watcher.cancel()
            self._external_cancel_signal = None

            # Clear cancel signal to allow agent reuse after cancellation
            self._cancel_signal.clear()

            self._concurrency.complete(begin.registered_token, result=result)
            if self._concurrency.mode == ConcurrentInvocationMode.THROW:
                self._concurrency.release_lock()

    async def _run_loop(
        self,
        messages: Messages,
        invocation_state: dict[str, Any],
        structured_output_model: type[BaseModel] | None = None,
        structured_output_prompt: str | None = None,
        limits: Limits | None = None,
    ) -> AsyncGenerator[TypedEvent, None]:
        """Execute the agent's event loop with the given message and parameters.

        Args:
            messages: The input messages to add to the conversation.
            invocation_state: Additional parameters to pass to the event loop.
            structured_output_model: Optional Pydantic model type for structured output.
            structured_output_prompt: Optional custom prompt for forcing structured output.
            limits: Optional per-invocation budget caps. See :class:`~strands.types.agent.Limits`.

        Yields:
            Events from the event loop cycle.
        """
        current_messages: Messages | None = messages
        continuation_event: AfterInvocationEvent | None = None

        while current_messages is not None:
            try:
                before_invocation_event, _interrupts = await self.hooks.invoke_callbacks_async(
                    BeforeInvocationEvent(agent=self, invocation_state=invocation_state, messages=current_messages)
                )
            except BaseException:
                await _continuation.abandon(
                    continuation_event,
                    RuntimeError("Agent stream closed before continuation input was incorporated into agent history"),
                )
                raise

            if before_invocation_event.cancel:
                cancel_text = (
                    before_invocation_event.cancel
                    if isinstance(before_invocation_event.cancel, str)
                    else "invocation denied by hook"
                )
                cancel_message: Message = {"role": "assistant", "content": [{"text": cancel_text}]}
                await self._append_messages(cancel_message)
                yield EventLoopStopEvent(
                    "end_turn", cancel_message, self.event_loop_metrics, invocation_state.get("request_state", {})
                )
                await _continuation.abandon(
                    continuation_event, RuntimeError("Continuation was not incorporated into agent history")
                )
                after_invocation_event = AfterInvocationEvent(agent=self, invocation_state=invocation_state)
                try:
                    await self.hooks.invoke_callbacks_async(after_invocation_event)
                except BaseException as error:
                    await _continuation.abandon(after_invocation_event, error)
                    raise
                await _continuation.abandon(
                    after_invocation_event,
                    RuntimeError("Agent stream closed before continuation input was incorporated into agent history"),
                )
                return

            current_messages = (
                before_invocation_event.messages if before_invocation_event.messages is not None else current_messages
            )

            agent_result: AgentResult | None = None
            caught_error: BaseException | None = None
            try:
                yield InitEventLoopEvent()

                # Backfill ids for any messages that entered history outside the append chokepoint
                # (e.g. a caller doing agent.messages.append(...) directly, or a legacy session
                # restored without ids), so every message carries one before the model is called.
                for message in self.messages:
                    _ensure_tracking_id(message)

                if continuation_event is None:
                    await self._append_messages(*current_messages)

                structured_output_context = StructuredOutputContext(
                    structured_output_model or self._default_structured_output_model,
                    structured_output_prompt=structured_output_prompt or self._structured_output_prompt,
                )

                pass_progress = _PassProgress()
                middleware_context = AgentStreamContext(
                    agent=self,
                    messages=current_messages,
                    invocation_state=invocation_state,
                    # Snapshot interrupts before the pass so a gate's re-read after next_fn
                    # survives the tool cycle clearing the live dict. Empty when not activated,
                    # so a dead cycle's retained response cannot resolve a fresh gate.
                    _interrupts=dict(self._interrupt_state.interrupts) if self._interrupt_state.activated else {},
                )
                try:
                    async for event in self._middleware_registry.invoke(
                        AgentStreamStage,
                        middleware_context,
                        self._make_agent_stream_terminal(
                            structured_output_context,
                            limits,
                            pass_progress,
                            continuation_event,
                        ),
                    ):
                        if isinstance(event, EventLoopStopEvent):
                            agent_result = AgentResult(*event["stop"])
                        yield event

                    # A resumed AgentStreamStage interrupt that finished without tool execution
                    # never hits the tool path's deactivate(), so clear the interrupt state here.
                    if (
                        self._interrupt_state.activated
                        and (agent_result is None or agent_result.stop_reason != "interrupt")
                        and self._interrupt_state.pending_tool_execution is None
                    ):
                        self._interrupt_state.deactivate()
                except InterruptException as interrupt_exception:
                    # Refuse a late interrupt — resuming would re-call the model
                    # and corrupt history.
                    if (
                        pass_progress.event_loop_produced_result
                        and self._interrupt_state.pending_tool_execution is None
                    ):
                        self._interrupt_state.deactivate()
                        raise RuntimeError(
                            f"interrupt_name=<{interrupt_exception.interrupt.name}> | agent-stream middleware "
                            "interrupted after the pass produced its result | interrupt before the pass "
                            "produces its assistant turn"
                        ) from interrupt_exception

                    registered = self._interrupt_state.interrupts.get(interrupt_exception.interrupt.id)
                    if registered is None or registered.response is not None:
                        self._interrupt_state.interrupts[interrupt_exception.interrupt.id] = (
                            interrupt_exception.interrupt
                        )
                    self._interrupt_state.activate()
                    interrupt_message: Message = (
                        self.messages[-1]
                        if self.messages
                        else {"role": "assistant", "content": [{"text": "Interrupted"}]}
                    )
                    # Surface all unanswered interrupts so the caller can build a complete resume payload.
                    unanswered = [
                        interrupt
                        for interrupt in self._interrupt_state.interrupts.values()
                        if interrupt.response is None
                    ]
                    stop_event = EventLoopStopEvent(
                        "interrupt",
                        interrupt_message,
                        self.event_loop_metrics,
                        invocation_state.get("request_state", {}),
                        unanswered,
                    )
                    agent_result = AgentResult(*stop_event["stop"])
                    yield stop_event
            except BaseException as error:
                caught_error = error
                raise
            finally:
                if not self._interrupt_state.activated:
                    self._interrupt_state.end_interrupt_cycle()

                self.conversation_manager.apply_management(self)
                await _continuation.abandon(
                    continuation_event, RuntimeError("Continuation was not incorporated into agent history")
                )
                after_invocation_event = AfterInvocationEvent(
                    agent=self, invocation_state=invocation_state, result=agent_result
                )
                continuation_event = after_invocation_event
                try:
                    await self.hooks.invoke_callbacks_async(after_invocation_event)
                except BaseException as error:
                    await _continuation.abandon(after_invocation_event, error)
                    continuation_event = None
                    raise
                if caught_error is not None:
                    await _continuation.abandon(after_invocation_event, caught_error)
                    continuation_event = None

            stop_reason = agent_result.stop_reason if agent_result is not None else None
            if stop_reason not in (None, "end_turn", "stop_sequence", "interrupt"):
                await _continuation.abandon(
                    after_invocation_event,
                    RuntimeError(f"Continuation abandoned after {stop_reason}"),
                )

            try:
                continuation_messages = await _continuation.prepare(
                    after_invocation_event,
                    self._convert_prompt_to_messages,
                    stop_reason,
                )
                has_continuation = continuation_messages is not None
                continuation_event = after_invocation_event if has_continuation else None

                if has_continuation or after_invocation_event.resume is not None:
                    current_messages = []
                    if after_invocation_event.resume is not None:
                        logger.debug("resume=<True> | hook requested agent resume with new input")
                        # If in interrupt state, process interrupt responses before continuing.
                        # This mirrors the _interrupt_state.resume() call in stream_async and will
                        # raise TypeError if the resume input is not valid interrupt responses.
                        self._interrupt_state.resume(after_invocation_event.resume)
                        current_messages = await self._convert_prompt_to_messages(after_invocation_event.resume)
                else:
                    current_messages = None
            except BaseException as error:
                await _continuation.abandon(continuation_event, error)
                continuation_event = None
                raise

    def _make_agent_stream_terminal(
        self,
        structured_output_context: StructuredOutputContext,
        limits: Limits | None,
        pass_progress: _PassProgress,
        continuation_event: AfterInvocationEvent | None,
    ) -> Callable[["AgentStreamContext"], AsyncGenerator[TypedEvent, None]]:
        """Build the terminal for the AgentStreamStage middleware chain.

        The terminal drives the event loop cycle for one invocation pass — the core work the
        AgentStreamStage middleware wraps. It reads ``invocation_state`` from the context it
        receives (not a captured value), so an Input/wrap handler that transforms the context
        via ``dataclasses.replace()`` actually reaches the event loop. It also handles
        guardrail-driven user-content redaction inline so that behavior runs whether or not
        middleware is registered.

        Args:
            structured_output_context: Structured output context for this pass.
            limits: Optional per-invocation budget caps.
            pass_progress: Records whether the event loop produced this pass's result, which
                determines whether resuming the pass would call the model again.
            continuation_event: Event owning input that must be appended only if the middleware
                chain reaches the terminal.

        Returns:
            An async generator function yielding the pass's events, ending with an
            ``EventLoopStopEvent``.
        """

        async def terminal(ctx: "AgentStreamContext") -> AsyncGenerator[TypedEvent, None]:
            if continuation_event is not None:
                messages = _continuation.combine(continuation_event, ctx.messages)
                await self._append_continuation_messages(messages, continuation_event)

            # Execute the event loop cycle with retry logic for context limits
            events = self._execute_event_loop_cycle(ctx.invocation_state, structured_output_context, limits)
            async for event in events:
                if isinstance(event, EventLoopStopEvent):
                    pass_progress.event_loop_produced_result = True

                # Signal from the model provider that the message sent by the user should be redacted,
                # likely due to a guardrail.
                if (
                    isinstance(event, ModelStreamChunkEvent)
                    and event.chunk
                    and event.chunk.get("redactContent")
                    and event.chunk["redactContent"].get("redactUserContentMessage")
                ):
                    self.messages[-1]["content"] = self._redact_user_content(
                        self.messages[-1]["content"],
                        str(event.chunk["redactContent"]["redactUserContentMessage"]),
                    )
                    if self._session_manager:
                        self._session_manager.redact_latest_message(self.messages[-1], self)
                yield event

        return terminal

    async def _execute_event_loop_cycle(
        self,
        invocation_state: dict[str, Any],
        structured_output_context: StructuredOutputContext | None = None,
        limits: Limits | None = None,
    ) -> AsyncGenerator[TypedEvent, None]:
        """Execute the event loop cycle with retry logic for context window limits.

        This internal method handles the execution of the event loop cycle and implements
        retry logic for handling context window overflow exceptions by reducing the
        conversation context and retrying.

        Args:
            invocation_state: Additional parameters to pass to the event loop.
            structured_output_context: Optional structured output context for this invocation.
            limits: Optional per-invocation budget caps. See :class:`~strands.types.agent.Limits`.

        Yields:
            Events of the loop cycle.
        """
        # Add `Agent` to invocation_state to keep backwards-compatibility
        invocation_state["agent"] = self

        if structured_output_context:
            structured_output_context.register_tool(self.tool_registry)

        try:
            events = event_loop_cycle(
                agent=self,
                invocation_state=invocation_state,
                structured_output_context=structured_output_context,
                limits=limits,
            )
            async for event in events:
                yield event

        except ContextWindowOverflowException as e:
            # Try reducing the context size and retrying
            self.conversation_manager.reduce_context(self, e=e)

            # Sync agent after reduce_context to keep conversation_manager_state up to date in the session
            if self._session_manager:
                self._session_manager.sync_agent(self)

            events = self._execute_event_loop_cycle(invocation_state, structured_output_context, limits)
            async for event in events:
                yield event

        finally:
            if structured_output_context:
                structured_output_context.cleanup(self.tool_registry)

    def _try_consume_checkpoint_resume(self, prompt: Any) -> bool:
        """Consume a ``checkpointResume`` prompt block, returning True if found.

        The block is a dict of the form ``{"checkpointResume": {"checkpoint": ...}}``.
        A missing ``checkpoint`` key raises ``KeyError``; ``checkpointing=False``
        raises ``ValueError``; a schema mismatch raises ``CheckpointException``.
        """
        if not (isinstance(prompt, dict) and "checkpointResume" in prompt):
            return False

        if not self._checkpointing:
            raise ValueError(
                "Received checkpointResume block but agent was created with checkpointing=False. "
                "Pass checkpointing=True when constructing the Agent."
            )

        payload = prompt["checkpointResume"]
        if not isinstance(payload, dict) or "checkpoint" not in payload:
            raise KeyError("checkpoint | missing required key in checkpointResume block")

        self._checkpoint = Checkpoint.from_dict(payload["checkpoint"])
        return True

    async def _convert_prompt_to_messages(self, prompt: AgentInput) -> Messages:
        if self._interrupt_state.activated:
            return []

        if self._try_consume_checkpoint_resume(prompt):
            return []

        messages: Messages | None = None
        if prompt is not None:
            # Check if the latest message is toolUse
            if len(self.messages) > 0 and any("toolUse" in content for content in self.messages[-1]["content"]):
                # Add toolResult message after to have a valid conversation
                logger.info(
                    "Agents latest message is toolUse, appending a toolResult message to have valid conversation."
                )
                tool_use_ids = [
                    content["toolUse"]["toolUseId"] for content in self.messages[-1]["content"] if "toolUse" in content
                ]
                await self._append_messages(
                    {
                        "role": "user",
                        "content": generate_missing_tool_result_content(tool_use_ids),
                    }
                )
            if isinstance(prompt, str):
                # String input - convert to user message
                messages = [{"role": "user", "content": [{"text": prompt}]}]
            elif isinstance(prompt, list):
                if len(prompt) == 0:
                    # Empty list
                    messages = []
                # Check if all item in input list are dictionaries
                elif all(isinstance(item, dict) for item in prompt):
                    # Check if all items are messages
                    if all(all(key in item for key in Message.__required_keys__) for item in prompt):
                        # Messages input - add all messages to conversation
                        messages = cast(Messages, prompt)

                    # Check if all items are content blocks
                    elif all(any(key in ContentBlock.__annotations__.keys() for key in item) for item in prompt):
                        # Treat as List[ContentBlock] input - convert to user message
                        # This allows invalid structures to be passed through to the model
                        messages = [{"role": "user", "content": cast(list[ContentBlock], prompt)}]

                    # Check if all items are interrupt responses
                    elif all("interruptResponse" in item for item in prompt):
                        raise ValueError(
                            "Received interrupt responses but agent is not in interrupt state. "
                            "Ensure the agent instance is preserved between calls, or use session "
                            "management to persist interrupt state across requests."
                        )
        else:
            messages = []
        if messages is None:
            raise ValueError("Input prompt must be of type: `str | list[Contentblock] | Messages | None`.")
        return messages

    def _start_agent_trace_span(self, messages: Messages) -> trace_api.Span:
        """Starts a trace span for the agent.

        Args:
            messages: The input messages.
        """
        model_id = self.model.config.get("model_id") if hasattr(self.model, "config") else None
        return self.tracer.start_agent_span(
            messages=messages,
            agent_name=self.name,
            model_id=model_id,
            tools=self.tool_names,
            system_prompt=self.system_prompt,
            system_prompt_content=self.system_prompt_content,
            custom_trace_attributes=self.trace_attributes,
            tools_config=self.tool_registry.get_all_tools_config(),
        )

    def _end_agent_trace_span(
        self,
        response: AgentResult | None = None,
        error: Exception | None = None,
        cancellation: BaseException | None = None,
    ) -> None:
        """Ends a trace span for the agent.

        Args:
            response: Response to record as a trace attribute.
            error: Error to record as a trace attribute.
            cancellation: BaseException that cancelled the invocation (e.g. CancelledError).
        """
        if self.trace_span:
            if cancellation is not None:
                self.tracer.end_span_with_cancellation(self.trace_span, cancellation)
                return

            trace_attributes: dict[str, Any] = {
                "span": self.trace_span,
            }

            if response:
                trace_attributes["response"] = response
            if error:
                trace_attributes["error"] = error

            self.tracer.end_agent_span(**trace_attributes)

    @staticmethod
    def _validate_limits(limits: Limits | None) -> None:
        """Validate per-invocation budget caps before any model work begins.

        Each cap, when set, must be a positive ``int``. Booleans are rejected because
        ``bool`` is a subclass of ``int`` in Python and ``True``/``False`` would
        otherwise pass through as ``1``/``0``, silently no-op'ing or tripping
        immediately.

        Args:
            limits: The caps to validate, or ``None`` to skip.

        Raises:
            TypeError: If any value is not a positive int.
        """
        if not limits:
            return
        for key in ("turns", "output_tokens", "total_tokens"):
            if key not in limits:
                continue
            value = limits[key]
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise TypeError(f"limits[{key!r}] must be a positive int, got {value!r}")

    async def _append_messages(self, *messages: Message) -> None:
        """Appends messages to history and invoke the callbacks for the MessageAddedEvent.

        Assigns a durable tracking id to any message that does not already have one.
        """
        for message in messages:
            _ensure_tracking_id(message)
            self.messages.append(message)
            await self.hooks.invoke_callbacks_async(MessageAddedEvent(agent=self, message=message))

    async def _append_continuation_messages(
        self,
        messages: Messages,
        continuation_event: AfterInvocationEvent | BeforeModelCallEvent,
    ) -> None:
        added_messages: Messages = []
        for message in messages:
            last_message = self.messages[-1] if self.messages else None
            if last_message is None or last_message["role"] != message["role"]:
                _ensure_tracking_id(message)
                self.messages.append(message)
                added_messages.append(message)
                continue

            appended_message = copy.copy(last_message)
            appended_message["content"] = [*last_message["content"], *message["content"]]
            _ensure_tracking_id(appended_message)
            self.messages[-1] = appended_message

            if added_messages and added_messages[-1] is last_message:
                added_messages[-1] = appended_message
            else:
                added_messages.append(appended_message)

        await _continuation.mark_appended(continuation_event)
        for message in added_messages:
            await self.hooks.invoke_callbacks_async(MessageAddedEvent(agent=self, message=message))

    def take_snapshot(
        self,
        *,
        preset: SnapshotPreset | None = None,
        include: list[SnapshotField] | None = None,
        exclude: list[SnapshotField] | None = None,
        app_data: dict[str, Any] | None = None,
    ) -> Snapshot:
        """Capture current agent state as an in-memory snapshot.

        Args:
            preset: Named preset of fields to capture. Currently only "session" is supported,
                which captures messages, state, conversation_manager_state, and interrupt_state.
            include: Additional fields to capture on top of the preset.
            exclude: Fields to remove after applying preset and include.
            app_data: Application-owned arbitrary JSON stored verbatim in the snapshot.

        Returns:
            A Snapshot containing the captured agent state.

        Raises:
            SnapshotException: If no fields are resolved or an invalid field name is provided.
        """
        fields = resolve_snapshot_fields(preset=preset, include=include, exclude=exclude)

        data: dict[str, Any] = {}
        if "messages" in fields:
            data["messages"] = copy.deepcopy(self.messages)
        if "state" in fields:
            data["state"] = self.state.get()
        if "conversation_manager_state" in fields:
            data["conversation_manager_state"] = self.conversation_manager.get_state()
        if "interrupt_state" in fields:
            data["interrupt_state"] = self._interrupt_state.to_dict()
        if "system_prompt" in fields:
            # Store the content-block representation so round-trips preserve caching hints and
            # other block-level metadata.
            data["system_prompt"] = copy.deepcopy(self._system_prompt_content)
        if "model_state" in fields:
            data["model_state"] = copy.deepcopy(self._model_state)

        return Snapshot(
            scope="agent",
            schema_version=SNAPSHOT_SCHEMA_VERSION,
            data=data,
            app_data=copy.deepcopy(app_data) if app_data else {},
        )

    def load_snapshot(self, snapshot: Snapshot) -> None:
        """Restore agent state from a previously captured snapshot.

        Only fields present in snapshot.data are restored; absent fields are left unchanged.

        Args:
            snapshot: The snapshot to restore from.

        Raises:
            SnapshotException: If snapshot.schema_version is not "1.0".
            RuntimeError: If background tasks are still tracked.
        """
        if self._background_tasks is not None:
            self._background_tasks.assert_can_load_snapshot()
        snapshot.validate()

        data = snapshot.data

        if "messages" in data:
            self.messages = copy.deepcopy(data["messages"])
        if "state" in data:
            self.state = AgentState(data["state"])
        if "conversation_manager_state" in data:
            self.conversation_manager.restore_from_session(data["conversation_manager_state"])
        if "interrupt_state" in data:
            self._interrupt_state = _InterruptState.from_dict(data["interrupt_state"])
        if "system_prompt" in data:
            self.system_prompt = copy.deepcopy(data["system_prompt"])
        if "model_state" in data:
            self._model_state = copy.deepcopy(data["model_state"])
        if self._background_tasks is not None and "state" in data:
            self._background_tasks.load_state()

    def _redact_user_content(self, content: list[ContentBlock], redact_message: str) -> list[ContentBlock]:
        """Redact user content preserving toolResult blocks.

        Args:
            content: content blocks to be redacted
            redact_message: redact message to be replaced

        Returns:
            Redacted content, as follows:
            - if the message contains at least a toolResult block,
                all toolResult blocks(s) are kept, redacting only the result content;
            - otherwise, the entire content of the message is replaced
                with a single text block with the redact message.
        """
        redacted_content = []
        for block in content:
            if "toolResult" in block:
                block["toolResult"]["content"] = [{"text": redact_message}]
                redacted_content.append(block)

        if not redacted_content:
            # Text content is added only if no toolResult blocks were found
            redacted_content = [{"text": redact_message}]

        return redacted_content
