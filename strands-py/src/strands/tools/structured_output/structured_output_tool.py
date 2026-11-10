"""Structured output tool implementation.

This module provides a real tool implementation for structured output that integrates
with the existing tool execution and error handling infrastructure.
"""

import logging
from copy import deepcopy
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ValidationError
from typing_extensions import override

from ...types._events import ToolResultEvent
from ...types.tools import AgentTool, ToolGenerator, ToolResult, ToolSpec, ToolUse
from .structured_output_utils import convert_pydantic_to_tool_spec

logger = logging.getLogger(__name__)

_TOOL_SPEC_CACHE: dict[type[BaseModel], ToolSpec] = {}

if TYPE_CHECKING:
    from ._structured_output_context import StructuredOutputContext


class StructuredOutputTool(AgentTool):
    """Tool implementation for structured output validation."""

    def __init__(self, structured_output_model: type[BaseModel]) -> None:
        """Initialize a structured output tool.

        Args:
            structured_output_model: The Pydantic model class that defines the expected output structure.
        """
        super().__init__()
        self._structured_output_type = structured_output_model
        self._tool_spec = self._get_tool_spec(structured_output_model)
        self._tool_spec["description"] = (
            "IMPORTANT: This StructuredOutputTool should only be invoked as the last and final tool "
            f"before returning the completed result to the caller. "
            f"<description>{self._tool_spec.get('description', '')}</description>"
        )
        self._tool_name = self._tool_spec.get("name", "StructuredOutputTool")

    @classmethod
    def _get_tool_spec(cls, structured_output_model: type[BaseModel]) -> ToolSpec:
        """Get a cached tool spec for the given output type.

        Args:
            structured_output_model: The Pydantic model class that defines the expected output structure.

        Returns:
            Cached tool specification for the output type.
        """
        if structured_output_model not in _TOOL_SPEC_CACHE:
            _TOOL_SPEC_CACHE[structured_output_model] = convert_pydantic_to_tool_spec(structured_output_model)
        return deepcopy(_TOOL_SPEC_CACHE[structured_output_model])

    @property
    def tool_name(self) -> str:
        """Get the name of the tool.

        Returns:
            The name of the tool (same as the Pydantic model class name).
        """
        return self._tool_name

    @property
    def tool_spec(self) -> ToolSpec:
        """Get the tool specification for this structured output tool.

        Returns:
            The tool specification generated from the Pydantic model.
        """
        return self._tool_spec

    @property
    def tool_type(self) -> str:
        """Identifies this as a structured output tool implementation.

        Returns:
            "structured_output".
        """
        return "structured_output"

    @property
    def structured_output_model(self) -> type[BaseModel]:
        """Get the Pydantic model type for this tool.

        Returns:
            The Pydantic model class.
        """
        return self._structured_output_type

    @override
    async def stream(self, tool_use: ToolUse, invocation_state: dict[str, Any], **kwargs: Any) -> ToolGenerator:
        """Validate the structured output and return appropriate result.

        Args:
            tool_use: The tool use request containing the data to validate.
            invocation_state: Context for the tool invocation (kept for compatibility).
            **kwargs: Additional keyword arguments, including structured_output_context.

        Yields:
            Tool events with the last being the tool result (success or error).
        """
        tool_input: dict[str, Any] = tool_use.get("input", {})
        tool_use_id = str(tool_use.get("toolUseId", ""))

        context: StructuredOutputContext = kwargs.get("structured_output_context")  # type: ignore
        try:
            validated_object = self._structured_output_type(**tool_input)
            logger.debug("tool_name=<%s> | structured output validated", self._tool_name)
            context.store_result(tool_use_id, validated_object)

            result: ToolResult = {
                "toolUseId": tool_use_id,
                "status": "success",
                "content": [{"text": f"Successfully validated {self._tool_name} structured output"}],
            }

            yield ToolResultEvent(result)

        except ValidationError as e:
            error_details = []
            for error in e.errors():
                field_path = " -> ".join(str(loc) for loc in error["loc"]) if error["loc"] else "root"
                error_details.append(f"Field '{field_path}': {error['msg']}")

            error_message = f"Validation failed for {self._tool_name}. Please fix the following errors:\n" + "\n".join(
                f"- {detail}" for detail in error_details
            )
            logger.debug(
                "tool_name=<%s> | structured output validation failed | error_message=<%s>",
                self._tool_name,
                error_message,
            )

            # Create error result that will be sent back to the LLM so it can decide if it needs to retry
            validation_error_result: ToolResult = {
                "toolUseId": tool_use_id,
                "status": "error",
                "content": [{"text": error_message}],
            }

            yield ToolResultEvent(validation_error_result)

        except Exception as e:
            error_message = f"Unexpected error validating {self._tool_name}: {str(e)}"
            logger.exception(error_message)

            exception_result: ToolResult = {
                "toolUseId": tool_use_id,
                "status": "error",
                "content": [{"text": error_message}],
            }

            yield ToolResultEvent(exception_result)
