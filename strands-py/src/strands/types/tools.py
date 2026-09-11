"""Tool-related type definitions for the SDK.

These types are modeled after the Bedrock API.

- Bedrock docs: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Types_Amazon_Bedrock_Runtime.html
"""

import threading
import uuid
from abc import ABC, abstractmethod
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Generic, Literal, Protocol

from typing_extensions import NotRequired, TypedDict, TypeVar

from .interrupt import _Interruptible
from .media import DocumentContent, ImageContent

if TYPE_CHECKING:
    from .agent import LocalAgent

JSONSchema = dict
"""Type alias for JSON Schema dictionaries."""

_LocalAgentT = TypeVar("_LocalAgentT", bound="LocalAgent", default=Any)
"""Local agent type exposed through ToolContext."""


class ToolSpec(TypedDict):
    """Specification for a tool that can be used by an agent.

    Attributes:
        description: A human-readable description of what the tool does.
        inputSchema: JSON Schema defining the expected input parameters.
        name: The unique name of the tool.
        outputSchema: Optional JSON Schema defining the expected output format.
            Note: Not all model providers support this field. Providers that don't
            support it should filter it out before sending to their API.
        annotations: Optional metadata describing tool behavior (e.g. MCP tool
            annotations such as `readOnlyHint` or `destructiveHint`). Distinct
            from content-level annotations on tool results.
            Annotations are untrusted hints from the tool provider, not
            guarantees; consumers such as permission layers must not treat them
            as a security boundary. A missing key means unknown, not False:
            per MCP spec `destructiveHint` and `openWorldHint` default to True
            when absent (`readOnlyHint` and `idempotentHint` default to False),
            and this field is absent entirely for non-MCP tools. This field is
            not sent to model provider APIs.
    """

    description: str
    inputSchema: JSONSchema
    name: str
    outputSchema: NotRequired[JSONSchema]
    annotations: NotRequired[dict[str, object]]


class Tool(TypedDict):
    """A tool that can be provided to a model.

    This type wraps a tool specification for inclusion in a model request.

    Attributes:
        toolSpec: The specification of the tool.
    """

    toolSpec: ToolSpec


class ToolUse(TypedDict):
    """A request from the model to use a specific tool with the provided input.

    Attributes:
        input: The input parameters for the tool.
            Can be any JSON-serializable type.
        name: The name of the tool to invoke.
        toolUseId: A unique identifier for this specific tool use request.
        reasoningSignature: Token that ties the model's reasoning to this tool call.
    """

    input: Any
    name: str
    toolUseId: str
    reasoningSignature: NotRequired[str]


class ToolResultContent(TypedDict, total=False):
    """Content returned by a tool execution.

    Attributes:
        document: Document content returned by the tool.
        image: Image content returned by the tool.
        json: JSON-serializable data returned by the tool.
        text: Text content returned by the tool.
    """

    document: DocumentContent
    image: ImageContent
    json: Any
    text: str


ToolResultStatus = Literal["success", "error"]
"""Status of a tool execution result."""


class ToolResult(TypedDict):
    """Result of a tool execution.

    Attributes:
        content: List of result content returned by the tool.
        status: The status of the tool execution ("success" or "error").
        toolUseId: The unique identifier of the tool use request that produced this result.
    """

    content: list[ToolResultContent]
    status: ToolResultStatus
    toolUseId: str


class ToolChoiceAuto(TypedDict):
    """Configuration for automatic tool selection.

    This represents the configuration for automatic tool selection, where the model decides whether and which tool to
    use based on the context.
    """

    pass


class ToolChoiceAny(TypedDict):
    """Configuration indicating that the model must request at least one tool."""

    pass


class ToolChoiceTool(TypedDict):
    """Configuration for forcing the use of a specific tool.

    Attributes:
        name: The name of the tool that the model must use.
    """

    name: str


@dataclass
class ToolContext(_Interruptible, Generic[_LocalAgentT]):
    """Context object containing framework-provided data for decorated tools.

    This object provides access to framework-level information that may be useful
    for tool implementations.

    Attributes:
        tool_use: The complete ToolUse object containing tool invocation details.
        agent: The Agent or BidiAgent instance executing this tool, providing access to conversation history,
               model configuration, and other agent state.
        invocation_state: Caller-provided kwargs that were passed to the agent when it was invoked (agent(),
                          agent.invoke_async(), etc.).
        cancel_signal: Cancellation signal for this tool call. Poll ``cancel_signal.is_set()`` between
                       steps, or forward it to an API that accepts one (e.g.
                       :meth:`~strands.tools.mcp.mcp_client.MCPClient.call_tool_async`). A tool that
                       ignores it runs to completion. Treat as read-only: setting or clearing it
                       from a tool is unsupported.

    Note:
        This class is intended to be instantiated by the SDK. Direct construction by users
        is not supported and may break in future versions as new fields are added.
    """

    tool_use: ToolUse
    agent: _LocalAgentT
    invocation_state: dict[str, Any]
    # Defaulted so a directly-constructed context stays valid; the SDK always supplies the
    # invoking agent's signal. Kept out of repr and equality: an Event carries no useful text
    # and compares by identity.
    cancel_signal: threading.Event = field(default_factory=threading.Event, repr=False, compare=False)

    def _interrupt_id(self, name: str) -> str:
        """Unique id for the interrupt.

        Args:
            name: User defined name for the interrupt.

        Returns:
            Interrupt id.
        """
        return f"v1:tool_call:{self.tool_use['toolUseId']}:{uuid.uuid5(uuid.NAMESPACE_OID, name)}"


# Individual ToolChoice type aliases
ToolChoiceAutoDict = dict[Literal["auto"], ToolChoiceAuto]
ToolChoiceAnyDict = dict[Literal["any"], ToolChoiceAny]
ToolChoiceToolDict = dict[Literal["tool"], ToolChoiceTool]

ToolChoice = ToolChoiceAutoDict | ToolChoiceAnyDict | ToolChoiceToolDict
"""
Configuration for how the model should choose tools.

- "auto": The model decides whether to use tools based on the context
- "any": The model must use at least one tool (any tool)
- "tool": The model must use the specified tool
"""

RunToolHandler = Callable[[ToolUse], AsyncGenerator[dict[str, Any], None]]
"""Callback that runs a single tool and streams back results."""

ToolGenerator = AsyncGenerator[Any, None]
"""Generator of tool events with the last being the tool result."""


class ToolConfig(TypedDict):
    """Configuration for tools in a model request.

    Attributes:
        tools: List of tools available to the model.
        toolChoice: Configuration for how the model should choose tools.
    """

    tools: list[Tool]
    toolChoice: ToolChoice


class ToolFunc(Protocol):
    """Function signature for Python decorated and module based tools."""

    __name__: str

    def __call__(self, *args: Any, **kwargs: Any) -> ToolResult | Awaitable[ToolResult]:
        """Function signature for Python decorated and module based tools.

        Returns:
            Tool result or awaitable tool result.
        """
        ...


class AgentTool(ABC):
    """Abstract base class for all SDK tools.

    This class defines the interface that all tool implementations must follow. Each tool must provide its name,
    specification, and implement a stream method that executes the tool's functionality.
    """

    _is_dynamic: bool

    def __init__(self) -> None:
        """Initialize the base agent tool with default dynamic state."""
        self._is_dynamic = False

    @property
    @abstractmethod
    # pragma: no cover
    def tool_name(self) -> str:
        """The unique name of the tool used for identification and invocation."""
        pass

    @property
    @abstractmethod
    # pragma: no cover
    def tool_spec(self) -> ToolSpec:
        """Tool specification that describes its functionality and parameters."""
        pass

    @property
    @abstractmethod
    # pragma: no cover
    def tool_type(self) -> str:
        """The type of the tool implementation (e.g., 'python', 'javascript', 'lambda').

        Used for categorization and appropriate handling.
        """
        pass

    @property
    def supports_hot_reload(self) -> bool:
        """Whether the tool supports automatic reloading when modified.

        Returns:
            False by default.
        """
        return False

    @abstractmethod
    # pragma: no cover
    def stream(self, tool_use: ToolUse, invocation_state: dict[str, Any], **kwargs: Any) -> ToolGenerator:
        """Stream tool events and return the final result.

        Args:
            tool_use: The tool use request containing tool ID and parameters.
            invocation_state: Caller-provided kwargs that were passed to the agent when it was invoked (agent(),
                              agent.invoke_async(), etc.).
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Tool events with the last being the tool result.
        """
        ...

    @property
    def is_dynamic(self) -> bool:
        """Whether the tool was dynamically loaded during runtime.

        Dynamic tools may have different lifecycle management.

        Returns:
            True if loaded dynamically, False otherwise.
        """
        return self._is_dynamic

    def mark_dynamic(self) -> None:
        """Mark this tool as dynamically loaded."""
        self._is_dynamic = True

    def get_display_properties(self) -> dict[str, str]:
        """Get properties to display in UI representations of this tool.

        Subclasses can extend this to include additional properties.

        Returns:
            Dictionary of property names and their string values.
        """
        return {
            "Name": self.tool_name,
            "Type": self.tool_type,
        }
