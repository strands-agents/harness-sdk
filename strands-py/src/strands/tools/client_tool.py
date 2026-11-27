"""A tool that the caller executes outside the agent.

A :class:`ClientTool` has a spec but no body. When the model calls it, the agent stops with an
interrupt named :data:`CLIENT_TOOL_INTERRUPT_NAME` whose ``reason`` holds the tool name and input.
The caller runs the tool and resumes the agent with an ``interruptResponse``; that response becomes
the tool result.
"""

import json
from typing import Any

from pydantic import BaseModel, ValidationError
from pydantic_core import PydanticSerializationError
from typing_extensions import override

from ..interrupt import InterruptException
from ..types._events import ToolInterruptEvent, ToolResultEvent
from ..types.tools import AgentTool, JSONSchema, ToolContext, ToolGenerator, ToolResult, ToolSpec, ToolUse
from .decorator import FunctionToolMetadata

CLIENT_TOOL_INTERRUPT_NAME = "strands:client-tool"
"""Name of every interrupt a client tool raises (``Interrupt.name``)."""

_CONTENT_KEYS = {"text", "json", "image", "document"}


class ClientTool(AgentTool):
    """A tool whose execution is handed back to the caller through an interrupt.

    The interrupt's ``reason`` is ``{"toolUseId", "name", "input"}``. Resume with the tool's output as the
    interrupt response; a ``{"status": "success" | "error", "content": [...]}`` response is used as the tool
    result as-is, which lets the caller report a failure.

    Example:
        ```python
        agent = Agent(tools=[ClientTool(name="get_location", description="Get the user's location.")])
        result = agent("Where am I?")
        interrupt = result.interrupts[0]  # interrupt.reason["name"] == "get_location"
        agent([{"interruptResponse": {"interruptId": interrupt.id, "response": {"city": "Seattle"}}}])
        ```
    """

    def __init__(
        self,
        *,
        name: str,
        description: str,
        input_schema: type[BaseModel] | JSONSchema | None = None,
    ) -> None:
        """Create a client tool.

        Args:
            name: Tool name shown to the model.
            description: Tool description shown to the model.
            input_schema: A pydantic model, which also validates the model's input before the interrupt,
                or a JSON schema, passed through unvalidated. Defaults to an object with no properties.

        Raises:
            TypeError: If ``input_schema`` is neither a pydantic model class nor a dict.
        """
        super().__init__()
        self._input_model: type[BaseModel] | None = None
        if isinstance(input_schema, type) and issubclass(input_schema, BaseModel):
            self._input_model = input_schema
            schema = input_schema.model_json_schema()
            FunctionToolMetadata._clean_pydantic_schema(schema)
        elif isinstance(input_schema, dict):
            # Also accept the ``{"json": ...}`` wrapper that ``@tool(inputSchema=...)`` takes.
            schema = input_schema["json"] if input_schema.keys() == {"json"} else input_schema
        elif input_schema is None:
            schema = {"type": "object", "properties": {}, "additionalProperties": False}
        else:
            raise TypeError(f"input_schema must be a pydantic model class or a dict, got {type(input_schema).__name__}")

        self._tool_spec: ToolSpec = {"name": name, "description": description, "inputSchema": {"json": schema}}

    @property
    def tool_name(self) -> str:
        """The name of the tool."""
        return self._tool_spec["name"]

    @property
    def tool_spec(self) -> ToolSpec:
        """The tool specification."""
        return self._tool_spec

    @property
    def tool_type(self) -> str:
        """The type of the tool."""
        return "client"

    @override
    async def stream(self, tool_use: ToolUse, invocation_state: dict[str, Any], **kwargs: Any) -> ToolGenerator:
        """Interrupt the agent with the tool call, then return the caller's response as the tool result.

        Args:
            tool_use: The tool use requested by the model.
            invocation_state: Caller-provided kwargs passed to the agent invocation.
            **kwargs: Framework-supplied arguments, including ``_tool_context``.

        Yields:
            A tool interrupt event until the caller responds, then the tool result event.
        """
        tool_use_id = tool_use["toolUseId"]
        tool_input = tool_use["input"]
        if self._input_model is not None:
            try:
                tool_input = self._input_model.model_validate(tool_input).model_dump(mode="json")
            except ValidationError as e:
                error_result: ToolResult = {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": f"Error: {e}"}],
                }
                yield ToolResultEvent(error_result, exception=e)
                return

        tool_context: ToolContext = kwargs["_tool_context"]
        reason = {"toolUseId": tool_use_id, "name": self.tool_name, "input": tool_input}
        try:
            response = tool_context.interrupt(CLIENT_TOOL_INTERRUPT_NAME, reason=reason)
        except InterruptException as e:
            yield ToolInterruptEvent(tool_use, [e.interrupt])
            return

        yield ToolResultEvent(_to_tool_result(tool_use_id, response))


def _to_tool_result(tool_use_id: str, response: Any) -> ToolResult:
    if _is_tool_result(response):
        return {"toolUseId": tool_use_id, "status": response["status"], "content": response["content"]}
    if isinstance(response, str):
        text = response
    elif isinstance(response, BaseModel):
        try:
            text = response.model_dump_json()
        except PydanticSerializationError:
            text = str(response)
    else:
        try:
            text = json.dumps(response, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(response)
    return {"toolUseId": tool_use_id, "status": "success", "content": [{"text": text}]}


def _is_tool_result(value: Any) -> bool:
    if not isinstance(value, dict) or value.get("status") not in ("success", "error"):
        return False
    content = value.get("content")
    return (
        isinstance(content, list)
        and len(content) > 0
        and all(isinstance(item, dict) and item.keys() & _CONTENT_KEYS for item in content)
    )
