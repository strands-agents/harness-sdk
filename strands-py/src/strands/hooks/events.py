"""Hook events emitted as part of invoking Agents.

This module defines the events that are emitted as Agents run through the lifecycle of a request.
"""

import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from typing_extensions import override

if TYPE_CHECKING:
    from ..agent.agent_result import AgentResult

from ..types.agent import AgentInput
from ..types.content import ContentBlock, Message, Messages
from ..types.event_loop import AuxiliaryModelCallSource, Usage
from ..types.interrupt import _Interruptible
from ..types.streaming import StopReason
from ..types.tools import AgentTool, ToolResult, ToolUse
from .registry import BaseHookEvent, HookEvent, _LocalAgentT

if TYPE_CHECKING:
    from ..multiagent.base import MultiAgentBase


@dataclass
class AgentInitializedEvent(HookEvent):
    """Event triggered when an agent has finished initialization.

    This event is fired after the agent has been fully constructed and all
    built-in components have been initialized. Hook providers can use this
    event to perform setup tasks that require a fully initialized agent.
    """

    pass


@dataclass
class BeforeInvocationEvent(HookEvent):
    """Event triggered at the beginning of a new agent request.

    This event is fired before the agent begins processing a new user request,
    before any model inference or tool execution occurs. Hook providers can
    use this event to perform request-level setup, logging, or validation.

    This event is triggered at the beginning of the following api calls:
      - Agent.__call__
      - Agent.stream_async
      - Agent.structured_output

    Attributes:
        invocation_state: State and configuration passed through the agent invocation.
            This can include shared context for multi-agent coordination, request tracking,
            and dynamic configuration.
        messages: The input messages for this invocation. Can be modified by hooks
            to redact or transform content before processing.
        cancel: When set, cancels the invocation. If a string, used as the cancellation message.
            If True, a default message is used.
    """

    invocation_state: dict[str, Any] = field(default_factory=dict)
    messages: Messages | None = None
    cancel: bool | str = False

    def _can_write(self, name: str) -> bool:
        return name in ["messages", "cancel"]


@dataclass
class AfterInvocationEvent(HookEvent):
    """Event triggered at the end of an agent request.

    This event is fired after the agent has completed processing a request,
    regardless of whether it completed successfully or encountered an error.
    Hook providers can use this event for cleanup, logging, or state persistence.

    Note: This event uses reverse callback ordering, meaning callbacks registered
    later will be invoked first during cleanup.

    This event is triggered at the end of the following api calls:
      - Agent.__call__
      - Agent.stream_async
      - Agent.structured_output

    Resume:
        When ``resume`` is set to a non-None value by a hook callback, the agent will
        automatically re-invoke itself with the provided input. This enables hooks to
        implement autonomous looping patterns where the agent continues processing
        based on its previous result. The resume triggers a full new invocation cycle
        including ``BeforeInvocationEvent``.

    Attributes:
        invocation_state: State and configuration passed through the agent invocation.
            This can include shared context for multi-agent coordination, request tracking,
            and dynamic configuration.
        result: The result of the agent invocation, if available.
            This will be None when invoked from structured_output methods, as those return typed output directly rather
            than AgentResult.
        resume: When set to a non-None agent input by a hook callback, the agent will
            re-invoke itself with this input. The value can be any valid AgentInput
            (str, content blocks, messages, etc.). Defaults to None (no resume).
    """

    invocation_state: dict[str, Any] = field(default_factory=dict)
    result: "AgentResult | None" = None
    resume: AgentInput = None

    def _can_write(self, name: str) -> bool:
        return name == "resume"

    @property
    def should_reverse_callbacks(self) -> bool:
        """True to invoke callbacks in reverse order."""
        return True


@dataclass
class MessageAddedEvent(HookEvent):
    """Event triggered when a message is added to the agent's conversation.

    This event is fired whenever the agent adds a new message to its internal
    message history, including user messages, assistant responses, and tool
    results. Hook providers can use this event for logging, monitoring, or
    implementing custom message processing logic.

    Note: This event is only triggered for messages added by the framework
    itself, not for messages manually added by tools or external code.

    Attributes:
        message: The message that was added to the conversation history.
    """

    message: Message


@dataclass
class BeforeToolsEvent(HookEvent, _Interruptible):
    """Event triggered before executing tools.

    This event is fired when the model returns tool use blocks that need to be executed.
    Hook callbacks can set ``cancel`` to prevent all tools from executing. Fires once per
    cycle, so may fire more than once per assistant message when a per-tool interrupt
    splits the batch.

    Attributes:
        message: The assistant message containing tool use requests.
        invocation_state: State and configuration passed through the agent invocation.
        cancel: When set, cancels all tool calls. If a string, used as the tool result
            error message. If True, a default message is used.
    """

    message: Message
    invocation_state: dict[str, Any]
    cancel: bool | str = False

    def _can_write(self, name: str) -> bool:
        return name == "cancel"

    @override
    def _interrupt_id(self, name: str) -> str:
        """Unique id for the interrupt.

        Args:
            name: User defined name for the interrupt.

        Returns:
            Interrupt id.
        """
        return f"v1:before_tools:{uuid.uuid5(uuid.NAMESPACE_OID, name)}"


@dataclass
class AfterToolsEvent(HookEvent):
    """Event triggered after all tools complete execution.

    This event is fired after tool results are collected and ready to be added to conversation.
    Paired with a preceding ``BeforeToolsEvent`` when the batch proceeds past the
    pre-execution phase (cancel, interrupt, and error paths included). Fires once per
    cycle, so may fire more than once per assistant message when a per-tool interrupt
    splits the batch.

    Note: This event uses reverse callback ordering, meaning callbacks registered
    later will be invoked first during cleanup.

    Attributes:
        message: The user-role message containing the tool results.
        invocation_state: State and configuration passed through the agent invocation.
        end_turn: When set, the agent loop halts after this tool batch without calling the
            model again. A string becomes the final assistant text. A list of content blocks
            becomes the final assistant message content. If True, a default message
            is used. In any case, the stop_reason is "end_turn".
    """

    message: Message
    invocation_state: dict[str, Any]
    end_turn: bool | str | list[ContentBlock] = False

    def _can_write(self, name: str) -> bool:
        return name == "end_turn"

    @property
    def should_reverse_callbacks(self) -> bool:
        """True to invoke callbacks in reverse order."""
        return True


@dataclass
class BeforeToolCallEvent(HookEvent[_LocalAgentT], _Interruptible):
    """Event triggered before a tool is invoked.

    This event is fired just before the agent executes a tool, allowing hook
    providers to inspect, modify, or replace the tool that will be executed.
    The selected_tool can be modified by hook callbacks to change which tool
    gets executed.

    Attributes:
        selected_tool: The tool that will be invoked. Can be modified by hooks
            to change which tool gets executed. This may be None if tool lookup failed.
        tool_use: The tool parameters that will be passed to selected_tool.
        invocation_state: Keyword arguments that will be passed to the tool.
        cancel_tool: A user defined message that when set, will cancel the tool call.
            The message will be placed into a tool result with an error status. If set to `True`, Strands will cancel
            the tool call and use a default cancel message.
    """

    selected_tool: AgentTool | None
    tool_use: ToolUse
    invocation_state: dict[str, Any]
    cancel_tool: bool | str = False

    def _can_write(self, name: str) -> bool:
        return name in ["cancel_tool", "selected_tool", "tool_use"]

    @override
    def _interrupt_id(self, name: str) -> str:
        """Unique id for the interrupt.

        Args:
            name: User defined name for the interrupt.

        Returns:
            Interrupt id.
        """
        return f"v1:before_tool_call:{self.tool_use['toolUseId']}:{uuid.uuid5(uuid.NAMESPACE_OID, name)}"


@dataclass
class AfterToolCallEvent(HookEvent[_LocalAgentT]):
    """Event triggered after a tool invocation completes.

    This event is fired after the agent has finished executing a tool,
    regardless of whether the execution was successful or resulted in an error.
    Hook providers can use this event for cleanup, logging, or post-processing.

    Note: This event uses reverse callback ordering, meaning callbacks registered
    later will be invoked first during cleanup.

    Tool Retrying:
        When ``retry`` is set to True by a hook callback, the tool executor will
        discard the current tool result and invoke the tool again. This has important
        implications for streaming consumers:

        - ToolStreamEvents (intermediate streaming events) from the discarded tool execution
          will have already been emitted to callers before the retry occurs. Agent invokers
          consuming streamed events should be prepared to handle this scenario, potentially
          by tracking retry state or implementing idempotent event processing
        - ToolResultEvent is NOT emitted for discarded attempts - only the final attempt's
          result is emitted and added to the conversation history

    Attributes:
        selected_tool: The tool that was invoked. It may be None if tool lookup failed.
        tool_use: The tool parameters that were passed to the tool invoked.
        invocation_state: Keyword arguments that were passed to the tool
        result: The result of the tool invocation. Either a ToolResult on success
            or an Exception if the tool execution failed.
        cancel_message: The cancellation message if the user cancelled the tool call.
        duration: Elapsed time in seconds spent executing the tool. Starts after
            BeforeToolCallEvent returns and stops before AfterToolCallEvent is constructed.
            None when the tool call was cancelled by a BeforeToolCallEvent hook
            before execution.
        retry: Whether to retry the tool invocation. Can be set by hook callbacks
            to trigger a retry. When True, the current result is discarded and the
            tool is called again. Defaults to False.
    """

    selected_tool: AgentTool | None
    tool_use: ToolUse
    invocation_state: dict[str, Any]
    result: ToolResult
    exception: Exception | None = None
    cancel_message: str | None = None
    duration: float | None = None
    retry: bool = False

    def _can_write(self, name: str) -> bool:
        return name in ["result", "retry"]

    @property
    def should_reverse_callbacks(self) -> bool:
        """True to invoke callbacks in reverse order."""
        return True


@dataclass
class BeforeModelCallEvent(HookEvent):
    """Event triggered before the model is invoked.

    This event is fired just before the agent calls the model for inference,
    allowing hook providers to inspect or modify the messages and configuration
    that will be sent to the model.

    Note: This event is not fired for invocations to structured_output.

    Attributes:
        invocation_state: State and configuration passed through the agent invocation.
            This can include shared context for multi-agent coordination, request tracking,
            and dynamic configuration.
        projected_input_tokens: Projected input token count for the upcoming model call.
            Computed by the agent loop from message metadata and token estimation.
            Available for hooks and plugins (e.g. conversation managers) to make
            proactive decisions about context management. None if estimation failed.
        cancel: When set, cancels the model call. If a string, used as the cancellation message.
            If True, a default message is used.
    """

    invocation_state: dict[str, Any] = field(default_factory=dict)
    projected_input_tokens: int | None = None
    cancel: bool | str = False

    def _can_write(self, name: str) -> bool:
        return name == "cancel"


@dataclass
class AfterModelCallEvent(HookEvent):
    """Event triggered after the model invocation completes.

    This event is fired after the agent has finished calling the model,
    regardless of whether the invocation was successful or resulted in an error.
    Hook providers can use this event for cleanup, logging, or post-processing.

    Note: This event uses reverse callback ordering, meaning callbacks registered
    later will be invoked first during cleanup.

    Note: This event is not fired for invocations to structured_output.

    Model Retrying:
        When ``retry`` is set to True by a hook callback, the agent will discard
        the current model response and invoke the model again. This has important
        implications for streaming consumers:

        - Streaming events from the discarded response will have already been emitted
          to callers before the retry occurs. Agent invokers consuming streamed events
          should be prepared to handle this scenario, potentially by tracking retry state
          or implementing idempotent event processing
        - The original model message is thrown away internally and not added to the
          conversation history

    Attributes:
        invocation_state: State and configuration passed through the agent invocation.
            This can include shared context for multi-agent coordination, request tracking,
            and dynamic configuration.
        stop_response: The model response data if invocation was successful, None if failed.
        exception: Exception if the model invocation failed, None if successful.
        retry: Whether to retry the model invocation. Can be set by hook callbacks
            to trigger a retry. When True, the current response is discarded and the
            model is called again. Defaults to False.
    """

    @dataclass
    class ModelStopResponse:
        """Model response data from successful invocation.

        Attributes:
            stop_reason: The reason the model stopped generating.
            message: The generated message from the model.
        """

        message: Message
        stop_reason: StopReason

    invocation_state: dict[str, Any] = field(default_factory=dict)
    stop_response: ModelStopResponse | None = None
    exception: Exception | None = None
    retry: bool = False

    def _can_write(self, name: str) -> bool:
        return name == "retry"

    @property
    def should_reverse_callbacks(self) -> bool:
        """True to invoke callbacks in reverse order."""
        return True


@dataclass
class BeforeAuxiliaryModelCallEvent(HookEvent):
    """Event triggered before an SDK-internal (non-main-loop) model call.

    Auxiliary model calls are calls the SDK makes on the user's behalf outside the
    agent's main event loop — summarizing conversation history, classifying a request
    to route between models, extracting memories, analyzing a fetched web page, or the
    built-in classifiers and judges (HITL risk, goal, steering). They do not fire
    :class:`BeforeModelCallEvent`, which keeps meaning "the agent's turn"; a consumer that
    wants to observe auxiliary calls opts in by subscribing to this event.

    Note: Only the SDK's built-in auxiliary features fire this event pair. A custom
    component (e.g. a user-written conversation manager or extractor) that calls a
    model directly is not covered, so subscribers must not assume the pair is an
    exhaustive record of every non-main-loop model call.

    Note: Depending on the auxiliary feature, this event may fire outside an active
    agent invocation (e.g. background memory extraction), and possibly on a different
    event loop than the agent's (e.g. summarization triggered from a synchronous
    caller).

    Attributes:
        source: The auxiliary feature making the call. May gain values in minor
            releases; treat unknown values as opaque rather than exhaustive-match on
            them.
        messages: The messages sent to the model.
        system_prompt: The system prompt sent to the model, when the call site provides
            one (e.g. the summarization or extraction instruction). None otherwise.
        invocation_state: State and configuration passed through the agent invocation,
            when the call site has access to it.
    """

    source: AuxiliaryModelCallSource
    messages: Messages
    system_prompt: str | None = None
    invocation_state: dict[str, Any] = field(default_factory=dict)


@dataclass
class AfterAuxiliaryModelCallEvent(HookEvent):
    """Event triggered after an SDK-internal (non-main-loop) model call completes.

    Fired after every :class:`BeforeAuxiliaryModelCallEvent`, whether the call succeeded
    or raised. See :class:`BeforeAuxiliaryModelCallEvent` for what counts as an auxiliary
    model call.

    Note: This event uses reverse callback ordering, meaning callbacks registered
    later will be invoked first during cleanup.

    Attributes:
        source: The auxiliary feature that made the call. See
            :attr:`BeforeAuxiliaryModelCallEvent.source`.
        invocation_state: State and configuration passed through the agent invocation,
            when the call site has access to it.
        stop_response: The model response data if the call succeeded and reported a
            stop event, None otherwise.
        exception: Exception if the call failed, None if it succeeded. This is a
            ``BaseException`` because the event also fires when the call is cancelled
            mid-stream (e.g. ``asyncio.CancelledError`` from a timeout).
    """

    @dataclass
    class ModelStopResponse:
        """Model response data from a successful auxiliary call.

        Attributes:
            message: The generated message from the model.
            stop_reason: The reason the model stopped generating.
            usage: Token usage reported for the call.
        """

        message: Message
        stop_reason: StopReason
        usage: Usage

    source: AuxiliaryModelCallSource
    invocation_state: dict[str, Any] = field(default_factory=dict)
    stop_response: ModelStopResponse | None = None
    exception: BaseException | None = None

    @property
    def should_reverse_callbacks(self) -> bool:
        """True to invoke callbacks in reverse order."""
        return True


# Multiagent hook events start here
@dataclass
class MultiAgentInitializedEvent(BaseHookEvent):
    """Event triggered when multi-agent orchestrator initialized.

    Attributes:
        source: The multi-agent orchestrator instance
        invocation_state: Configuration that user passes in
    """

    source: "MultiAgentBase"
    invocation_state: dict[str, Any] | None = None


@dataclass
class BeforeNodeCallEvent(BaseHookEvent, _Interruptible):
    """Event triggered before individual node execution starts.

    Attributes:
        source: The multi-agent orchestrator instance
        node_id: ID of the node about to execute
        invocation_state: Configuration that user passes in
        cancel_node: A user defined message that when set, will cancel the node execution with status FAILED.
            The message will be emitted under a MultiAgentNodeCancel event. If set to `True`, Strands will cancel the
            node using a default cancel message.
    """

    source: "MultiAgentBase"
    node_id: str
    invocation_state: dict[str, Any] | None = None
    cancel_node: bool | str = False

    def _can_write(self, name: str) -> bool:
        return name in ["cancel_node"]

    @override
    def _interrupt_id(self, name: str) -> str:
        """Unique id for the interrupt.

        Args:
            name: User defined name for the interrupt.

        Returns:
            Interrupt id.
        """
        node_id = uuid.uuid5(uuid.NAMESPACE_OID, self.node_id)
        call_id = uuid.uuid5(uuid.NAMESPACE_OID, name)
        return f"v1:before_node_call:{node_id}:{call_id}"


@dataclass
class AfterNodeCallEvent(BaseHookEvent):
    """Event triggered after individual node execution completes.

    Attributes:
        source: The multi-agent orchestrator instance
        node_id: ID of the node that just completed execution
        invocation_state: Configuration that user passes in
    """

    source: "MultiAgentBase"
    node_id: str
    invocation_state: dict[str, Any] | None = None

    @property
    def should_reverse_callbacks(self) -> bool:
        """True to invoke callbacks in reverse order."""
        return True


@dataclass
class BeforeMultiAgentInvocationEvent(BaseHookEvent):
    """Event triggered before orchestrator execution starts.

    Attributes:
        source: The multi-agent orchestrator instance
        invocation_state: Configuration that user passes in
    """

    source: "MultiAgentBase"
    invocation_state: dict[str, Any] | None = None


@dataclass
class AfterMultiAgentInvocationEvent(BaseHookEvent):
    """Event triggered after orchestrator execution completes.

    Attributes:
        source: The multi-agent orchestrator instance
        invocation_state: Configuration that user passes in
    """

    source: "MultiAgentBase"
    invocation_state: dict[str, Any] | None = None

    @property
    def should_reverse_callbacks(self) -> bool:
        """True to invoke callbacks in reverse order."""
        return True
