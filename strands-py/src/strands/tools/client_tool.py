"""A tool that the caller executes outside the agent.

A :class:`ClientTool` has a spec but no body. When the model calls it, the agent stops with an
interrupt named :data:`CLIENT_TOOL_INTERRUPT_NAME` whose ``reason`` holds the tool name and input.
The caller runs the tool and resumes the agent with an ``interruptResponse``; that response becomes
the tool result.
"""

import json
from typing import Any

from pydantic import BaseModel, ValidationError
from typing_extensions import override

from ..types._events import ToolResultEvent
from ..types.tools import AgentTool, JSONSchema, ToolContext, ToolGenerator, ToolResult, ToolSpec, ToolUse
from .structured_output import convert_pydantic_to_tool_spec

CLIENT_TOOL_INTERRUPT_NAME = "strands:client-tool"
"""Name of every interrupt a client tool raises (``Interrupt.name``)."""


class ClientTool(AgentTool):
    """A tool whose execution is handed back to the caller through an interrupt.

    Example:
        ```python
        agent = Agent(tools=[ClientTool(name="get_location", description="Get the user's location.")])
        result = agent("Where am I?")
        interrupt = result.interrupts[0]  # interrupt.reason == {"name": "get_location", "input": {}}
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
        """
        super().__init__()
        self._input_model: type[BaseModel] | None = None
        if isinstance(input_schema, type) and issubclass(input_schema, BaseModel):
            self._input_model = input_schema
            schema = convert_pydantic_to_tool_spec(input_schema)["inputSchema"]["json"]
        else:
            schema = input_schema if input_schema is not None else {"type": "object", "properties": {}}

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
            The tool result event.

        Raises:
            InterruptException: Until the caller responds to the interrupt.
        """
        tool_use_id = tool_use["toolUseId"]
        if self._input_model is not None:
            try:
                self._input_model.model_validate(tool_use["input"])
            except ValidationError as e:
                yield ToolResultEvent(_error_result(tool_use_id, e), exception=e)
                return

        tool_context: ToolContext = kwargs["_tool_context"]
        response = tool_context.interrupt(
            CLIENT_TOOL_INTERRUPT_NAME, reason={"name": self.tool_name, "input": tool_use["input"]}
        )
        yield ToolResultEvent(_to_tool_result(tool_use_id, response))


def _error_result(tool_use_id: str, error: Exception) -> ToolResult:
    return {"toolUseId": tool_use_id, "status": "error", "content": [{"text": f"Error: {error}"}]}


def _to_tool_result(tool_use_id: str, response: Any) -> ToolResult:
    if isinstance(response, dict) and "status" in response and "content" in response:
        return {**response, "toolUseId": tool_use_id}  # type: ignore[typeddict-item]
    text = response if isinstance(response, str) else json.dumps(response, ensure_ascii=False)
    return {"toolUseId": tool_use_id, "status": "success", "content": [{"text": text}]}
