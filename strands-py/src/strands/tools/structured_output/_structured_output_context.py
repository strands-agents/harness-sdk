"""Context management for structured output in the event loop."""

import logging
from typing import TYPE_CHECKING

from pydantic import BaseModel

from ...types.tools import ToolChoice, ToolSpec, ToolUse
from .structured_output_tool import StructuredOutputTool

if TYPE_CHECKING:
    from ..registry import ToolRegistry

logger = logging.getLogger(__name__)

DEFAULT_STRUCTURED_OUTPUT_PROMPT = "You must format the previous response as structured output."
DEFAULT_STRUCTURED_OUTPUT_MAX_ATTEMPTS = 6


class StructuredOutputContext:
    """Per-invocation context for structured output execution."""

    def __init__(
        self,
        structured_output_model: type[BaseModel] | None = None,
        structured_output_prompt: str | None = None,
    ):
        """Initialize a new structured output context.

        Args:
            structured_output_model: Optional Pydantic model type for structured output.
            structured_output_prompt: Optional custom prompt message to use when forcing structured output.
                Defaults to "You must format the previous response as structured output."
        """
        self.results: dict[str, BaseModel] = {}
        self.structured_output_model: type[BaseModel] | None = structured_output_model
        self.structured_output_tool: StructuredOutputTool | None = None
        self.forced_mode: bool = False
        self.force_attempted: bool = False
        self.tool_choice: ToolChoice | None = None
        self.stop_loop: bool = False
        self.validation_failure_count: int = 0
        self.expected_tool_name: str | None = None
        self.structured_output_prompt: str = structured_output_prompt or DEFAULT_STRUCTURED_OUTPUT_PROMPT

        if structured_output_model:
            self.structured_output_tool = StructuredOutputTool(structured_output_model)
            self.expected_tool_name = self.structured_output_tool.tool_name

    @property
    def is_enabled(self) -> bool:
        """Check if structured output is enabled for this context.

        Returns:
            True if a structured output model is configured, False otherwise.
        """
        return self.structured_output_model is not None

    def store_result(self, tool_use_id: str, result: BaseModel) -> None:
        """Store a validated structured output result.

        Args:
            tool_use_id: Unique identifier for the tool use.
            result: Validated Pydantic model instance.
        """
        self.results[tool_use_id] = result

    def get_result(self, tool_use_id: str) -> BaseModel | None:
        """Retrieve a stored structured output result.

        Args:
            tool_use_id: Unique identifier for the tool use.

        Returns:
            The validated Pydantic model instance, or None if not found.
        """
        return self.results.get(tool_use_id)

    def set_forced_mode(self, tool_choice: dict | None = None) -> None:
        """Mark this context as being in forced structured output mode.

        Args:
            tool_choice: Optional tool choice configuration.
        """
        if not self.is_enabled:
            return
        self.forced_mode = True
        self.force_attempted = True
        self.tool_choice = tool_choice or {"any": {}}

    def has_structured_output_tool(self, tool_uses: list[ToolUse]) -> bool:
        """Check if any tool uses are for the structured output tool.

        Args:
            tool_uses: List of tool use dictionaries to check.

        Returns:
            True if any tool use matches the expected structured output tool name,
            False if no structured output tool is present or expected.
        """
        if not self.expected_tool_name:
            return False
        return any(tool_use.get("name") == self.expected_tool_name for tool_use in tool_uses)

    def get_tool_spec(self) -> ToolSpec | None:
        """Get the tool specification for structured output.

        Returns:
            Tool specification, or None if no structured output model.
        """
        if self.structured_output_tool:
            return self.structured_output_tool.tool_spec
        return None

    def extract_result(self, tool_uses: list[ToolUse]) -> BaseModel | None:
        """Extract and remove structured output result from stored results.

        Args:
            tool_uses: List of tool use dictionaries from the current execution cycle.

        Returns:
            The structured output result if found, or None if no result available.
        """
        if not self.has_structured_output_tool(tool_uses):
            return None

        for tool_use in tool_uses:
            if tool_use.get("name") == self.expected_tool_name:
                tool_use_id = str(tool_use.get("toolUseId", ""))
                result = self.results.pop(tool_use_id, None)
                if result is not None:
                    logger.debug("Extracted structured output for %s", tool_use.get("name"))
                    return result
        return None

    def register_tool(self, registry: "ToolRegistry") -> None:
        """Register the structured output tool with the registry.

        Args:
            registry: The tool registry to register the tool with.
        """
        if self.structured_output_tool and self.structured_output_tool.tool_name not in registry.dynamic_tools:
            registry.register_dynamic_tool(self.structured_output_tool)
            logger.debug("Registered structured output tool: %s", self.structured_output_tool.tool_name)

    def cleanup(self, registry: "ToolRegistry") -> None:
        """Clean up the registered structured output tool from the registry.

        Args:
            registry: The tool registry to clean up the tool from.
        """
        if self.structured_output_tool and self.structured_output_tool.tool_name in registry.dynamic_tools:
            del registry.dynamic_tools[self.structured_output_tool.tool_name]
            logger.debug("Cleaned up structured output tool: %s", self.structured_output_tool.tool_name)
