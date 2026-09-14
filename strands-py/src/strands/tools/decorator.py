"""Tool decorator for SDK.

This module provides the @tool decorator that transforms Python functions into SDK Agent tools with automatic metadata
extraction and validation.

The @tool decorator performs several functions:

1. Extracts function metadata (name, description, parameters) from docstrings and type hints
2. Generates a JSON schema for input validation
3. Handles two different calling patterns:
   - Standard function calls (func(arg1, arg2))
   - Tool use calls (agent.my_tool(param1="hello", param2=123))
4. Provides error handling and result formatting
5. Works with both standalone functions and class methods

Example:
    ```python
    from strands import Agent, tool

    @tool
    def my_tool(param1: str, param2: int = 42) -> dict:
        '''
        Tool description - explain what it does.

        #Args:
            param1: Description of first parameter.
            param2: Description of second parameter (default: 42).

        #Returns:
            A dictionary with the results.
        '''
        result = do_something(param1, param2)
        return {
            "status": "success",
            "content": [{"text": f"Result: {result}"}]
        }

    agent = Agent(tools=[my_tool])
    agent.tool.my_tool(param1="hello", param2=123)
    ```
"""

import asyncio
import functools
import inspect
import json
import logging
import threading
from collections.abc import Callable
from typing import (
    Annotated,
    Any,
    Generic,
    ParamSpec,
    TypeVar,
    cast,
    get_args,
    get_origin,
    get_type_hints,
    overload,
)

import docstring_parser
from pydantic import BaseModel, Field, create_model
from pydantic.fields import FieldInfo
from pydantic_core import PydanticSerializationError
from typing_extensions import override

from ..interrupt import InterruptException
from ..types._events import ToolInterruptEvent, ToolResultEvent, ToolStreamEvent
from ..types.tools import AgentTool, JSONSchema, ToolContext, ToolGenerator, ToolResult, ToolSpec, ToolUse

logger = logging.getLogger(__name__)


# Type for wrapped function
T = TypeVar("T", bound=Callable[..., Any])


class FunctionToolMetadata:
    """Helper class to extract and manage function metadata for tool decoration.

    This class handles the extraction of metadata from Python functions including:

    - Function name and description from docstrings
    - Parameter names, types, and descriptions
    - Return type information
    - Creation of Pydantic models for input validation

    The extracted metadata is used to generate a tool specification that can be used by Strands Agent to understand and
    validate tool usage.
    """

    def __init__(self, func: Callable[..., Any], context_param: str | None = None) -> None:
        """Initialize with the function to process.

        Args:
            func: The function to extract metadata from.
                 Can be a standalone function or a class method.
            context_param: Name of the context parameter to inject, if any.
        """
        self.func = func
        self.signature = inspect.signature(func)
        self.type_hints = get_type_hints(func, include_extras=True)
        self._context_param = context_param

        self._validate_signature()

        # Parse the docstring with docstring_parser
        doc_str = inspect.getdoc(func) or ""
        self.doc = docstring_parser.parse(doc_str)
        self.param_descriptions: dict[str, str] = {
            param.arg_name: param.description or f"Parameter {param.arg_name}" for param in self.doc.params
        }

        # Create a Pydantic model for validation
        self.input_model = self._create_input_model()

    def _extract_annotated_metadata(
        self, annotation: Any, param_name: str, param_default: Any
    ) -> tuple[Any, FieldInfo]:
        """Extracts type and a simple string description from an Annotated type hint.

        Returns:
            A tuple of (actual_type, field_info), where field_info is a new, simple
            Pydantic FieldInfo instance created from the extracted metadata.
        """
        actual_type = annotation
        description: str | None = None

        if get_origin(annotation) is Annotated:
            args = get_args(annotation)
            actual_type = args[0]

            # Look through metadata for a string description or a FieldInfo object
            for meta in args[1:]:
                if isinstance(meta, str):
                    description = meta
                elif isinstance(meta, FieldInfo):
                    # --- Future Contributor Note ---
                    # We are explicitly blocking the use of `pydantic.Field` within `Annotated`
                    # because of the complexities of Pydantic v2's immutable Core Schema.
                    #
                    # Once a Pydantic model's schema is built, its `FieldInfo` objects are
                    # effectively frozen. Attempts to mutate a `FieldInfo` object after
                    # creation (e.g., by copying it and setting `.description` or `.default`)
                    # are unreliable because the underlying Core Schema does not see these changes.
                    #
                    # The correct way to support this would be to reliably extract all
                    # constraints (ge, le, pattern, etc.) from the original FieldInfo and
                    # rebuild a new one from scratch. However, these constraints are not
                    # stored as public attributes, making them difficult to inspect reliably.
                    #
                    # Deferring this complexity until there is clear demand and a robust
                    # pattern for inspecting FieldInfo constraints is established.
                    raise NotImplementedError(
                        "Using pydantic.Field within Annotated is not yet supported for tool decorators. "
                        "Please use a simple string for the description, or define constraints in the function's "
                        "docstring."
                    )

        # Determine the final description with a clear priority order
        # Priority: 1. Annotated string -> 2. Docstring -> 3. Fallback
        final_description = description
        if final_description is None:
            final_description = self.param_descriptions.get(param_name) or f"Parameter {param_name}"
        if isinstance(param_default, FieldInfo):
            if param_default.description is None:
                final_field = FieldInfo.merge_field_infos(param_default, FieldInfo(description=final_description))
            else:
                final_field = param_default
        else:
            final_field = Field(default=param_default, description=final_description)

        return actual_type, final_field

    def _validate_signature(self) -> None:
        """Verify that ToolContext is used correctly in the function signature."""
        for param in self.signature.parameters.values():
            annotation = self.type_hints.get(param.name)
            if annotation is ToolContext or get_origin(annotation) is ToolContext:
                if self._context_param is None:
                    raise ValueError("@tool(context) must be set if passing in ToolContext param")

                if param.name != self._context_param:
                    raise ValueError(
                        f"param_name=<{param.name}> | ToolContext param must be named '{self._context_param}'"
                    )
                # Found the parameter, no need to check further
                break

    def _create_input_model(self) -> type[BaseModel]:
        """Create a Pydantic model from function signature for input validation.

        This method analyzes the function's signature, type hints, and docstring to create a Pydantic model that can
        validate input data before passing it to the function.

        Special parameters that can be automatically injected are excluded from the model.

        Returns:
            A Pydantic BaseModel class customized for the function's parameters.
        """
        field_definitions: dict[str, Any] = {}

        for name, param in self.signature.parameters.items():
            # Skip parameters that will be automatically injected
            if self._is_special_parameter(name):
                continue

            # Handle PEP 563 (from __future__ import annotations):
            # - When PEP 563 is active, param.annotation is a string literal that needs resolution
            # - When PEP 563 is not active, param.annotation is the actual type object (may include Annotated)
            # We check if param.annotation is a string to determine if we need type hint resolution.
            # This preserves Annotated metadata correctly in both cases and is consistent across Python versions.
            if isinstance(param.annotation, str):
                # PEP 563 active: resolve string annotation
                param_type = self.type_hints.get(name, param.annotation)
            else:
                # PEP 563 not active: use the actual type object directly
                param_type = param.annotation
            if param_type is inspect.Parameter.empty:
                param_type = Any
            default = ... if param.default is inspect.Parameter.empty else param.default

            actual_type, field_info = self._extract_annotated_metadata(param_type, name, default)
            field_definitions[name] = (actual_type, field_info)

        model_name = f"{self.func.__name__.capitalize()}Tool"

        if field_definitions:
            return create_model(model_name, **field_definitions)
        else:
            return create_model(model_name)

    def _extract_description_from_docstring(self) -> str:
        """Extract the docstring excluding only the Args section.

        This method uses the parsed docstring to extract everything except
        the Args/Arguments/Parameters section, preserving Returns, Raises,
        Examples, and other sections.

        Returns:
            The description text, or the function name if no description is available.
        """
        func_name = self.func.__name__

        # Fallback: try to extract manually from raw docstring
        raw_docstring = inspect.getdoc(self.func)
        if raw_docstring:
            lines = raw_docstring.strip().split("\n")
            result_lines = []
            skip_args_section = False

            for line in lines:
                stripped_line = line.strip()

                # Check if we're starting the Args section
                if stripped_line.lower().startswith(("args:", "arguments:", "parameters:", "param:", "params:")):
                    skip_args_section = True
                    continue

                # Check if we're starting a new section (not Args)
                elif (
                    stripped_line.lower().startswith(("returns:", "return:", "yields:", "yield:"))
                    or stripped_line.lower().startswith(("raises:", "raise:", "except:", "exceptions:"))
                    or stripped_line.lower().startswith(("examples:", "example:", "note:", "notes:"))
                    or stripped_line.lower().startswith(("see also:", "seealso:", "references:", "ref:"))
                ):
                    skip_args_section = False
                    result_lines.append(line)
                    continue

                # If we're not in the Args section, include the line
                if not skip_args_section:
                    result_lines.append(line)

            # Join and clean up the description
            description = "\n".join(result_lines).strip()
            if description:
                return description

        # Final fallback: use function name
        return func_name

    def extract_metadata(self) -> ToolSpec:
        """Extract metadata from the function to create a tool specification.

        This method analyzes the function to create a standardized tool specification that Strands Agent can use to
        understand and interact with the tool.

        The specification includes:

        - name: The function name (or custom override)
        - description: The function's docstring description (excluding Args)
        - inputSchema: A JSON schema describing the expected parameters

        Returns:
            A dictionary containing the tool specification.
        """
        func_name = self.func.__name__

        # Extract function description from parsed docstring, excluding Args section and beyond
        description = self._extract_description_from_docstring()

        # Get schema directly from the Pydantic model
        input_schema = self.input_model.model_json_schema()

        # Clean up Pydantic-specific schema elements
        self._clean_pydantic_schema(input_schema)

        # Create tool specification
        tool_spec: ToolSpec = {"name": func_name, "description": description, "inputSchema": {"json": input_schema}}

        return tool_spec

    def _clean_pydantic_schema(self, schema: dict[str, Any]) -> None:
        """Clean up Pydantic schema to match Strands' expected format.

        Pydantic's JSON schema output includes several elements that aren't needed for Strands Agent tools and could
        cause validation issues. This method removes those elements and simplifies complex type structures.

        Key operations:

        1. Remove Pydantic-specific metadata (title, $defs, etc.)
        2. Process complex types like Union and Optional to simpler formats
        3. Handle nested property structures recursively

        Args:
            schema: The Pydantic-generated JSON schema to clean up (modified in place).
        """
        # Remove Pydantic metadata
        keys_to_remove = ["title", "additionalProperties"]
        for key in keys_to_remove:
            if key in schema:
                del schema[key]

        # Process properties to clean up anyOf and similar structures
        required_fields = schema.get("required", [])
        if "properties" in schema:
            for prop_name, prop_schema in schema["properties"].items():
                # Handle anyOf constructs (common for Optional types)
                if "anyOf" in prop_schema:
                    any_of = prop_schema["anyOf"]
                    # Handle Optional[Type] case (represented as anyOf[Type, null])
                    # Only simplify when the field is not required; required nullable
                    # fields need anyOf preserved so the model can pass null.
                    if (
                        prop_name not in required_fields
                        and len(any_of) == 2
                        and any(item.get("type") == "null" for item in any_of)
                    ):
                        # Find the non-null type
                        for item in any_of:
                            if item.get("type") != "null":
                                # Copy the non-null properties to the main schema
                                for k, v in item.items():
                                    prop_schema[k] = v
                                # Remove the anyOf construct
                                del prop_schema["anyOf"]
                                break

                # Clean up nested properties recursively
                if "properties" in prop_schema:
                    self._clean_pydantic_schema(prop_schema)

                # Remove any remaining Pydantic metadata from properties
                for key in keys_to_remove:
                    if key in prop_schema:
                        del prop_schema[key]

    def validate_input(self, input_data: dict[str, Any]) -> dict[str, Any]:
        """Validate input data using the Pydantic model.

        This method ensures that the input data meets the expected schema before it's passed to the actual function. It
        converts the data to the correct types when possible and raises informative errors when not.

        Args:
            input_data: A dictionary of parameter names and values to validate.

        Returns:
            A dictionary with validated and converted parameter values.

        Raises:
            ValueError: If the input data fails validation, with details about what failed.
        """
        try:
            # Validate with Pydantic model
            validated = self.input_model(**input_data)

            # Return as dict
            return validated.model_dump()
        except Exception as e:
            # Re-raise with more detailed error message
            error_msg = str(e)
            raise ValueError(f"Validation failed for input parameters: {error_msg}") from e

    def inject_special_parameters(
        self,
        validated_input: dict[str, Any],
        tool_use: ToolUse,
        invocation_state: dict[str, Any],
        tool_context: ToolContext | None = None,
    ) -> None:
        """Inject special framework-provided parameters into the validated input.

        This method automatically provides framework-level context to tools that request it
        through their function signature.

        Args:
            validated_input: The validated input parameters (modified in place).
            tool_use: The tool use request containing tool invocation details.
            invocation_state: Caller-provided kwargs that were passed to the agent when it was invoked (agent(),
                              agent.invoke_async(), etc.).
            tool_context: Framework-supplied context to inject as-is (e.g. a background task's context);
                          when omitted, one is derived from ``invocation_state``.
        """
        if self._context_param and self._context_param in self.signature.parameters:
            if tool_context is None:
                agent = invocation_state["agent"]
                tool_context = ToolContext(
                    tool_use=tool_use,
                    agent=agent,
                    invocation_state=invocation_state,
                    # A BidiAgent has no cancellation signal; fall back to an inert event so tool
                    # authors never have to guard the field.
                    cancel_signal=getattr(agent, "cancel_signal", threading.Event()),
                )
            validated_input[self._context_param] = tool_context

        # Inject agent if requested (backward compatibility)
        if "agent" in self.signature.parameters and "agent" in invocation_state:
            validated_input["agent"] = invocation_state["agent"]

    def _is_special_parameter(self, param_name: str) -> bool:
        """Check if a parameter should be automatically injected by the framework or is a standard Python method param.

        Special parameters include:
        - Standard Python method parameters: self, cls
        - Framework-provided context parameters: agent, and configurable context parameter (defaults to tool_context)

        Args:
            param_name: The name of the parameter to check.

        Returns:
            True if the parameter should be excluded from input validation and
            handled specially during tool execution.
        """
        special_params = {"self", "cls", "agent"}

        # Add context parameter if configured
        if self._context_param:
            special_params.add(self._context_param)

        return param_name in special_params


P = ParamSpec("P")  # Captures all parameters
R = TypeVar("R")  # Return type


class DecoratedFunctionTool(AgentTool, Generic[P, R]):
    """An AgentTool that wraps a function that was decorated with @tool.

    This class adapts Python functions decorated with @tool to the AgentTool interface. It handles both direct
    function calls and tool use invocations, maintaining the function's
    original behavior while adding tool capabilities.

    The class is generic over the function's parameter types (P) and return type (R) to maintain type safety.
    """

    _tool_name: str
    _tool_spec: ToolSpec
    _tool_func: Callable[P, R]
    _metadata: FunctionToolMetadata

    def __init__(
        self,
        tool_name: str,
        tool_spec: ToolSpec,
        tool_func: Callable[P, R],
        metadata: FunctionToolMetadata,
    ):
        """Initialize the decorated function tool.

        Args:
            tool_name: The name to use for the tool (usually the function name).
            tool_spec: The tool specification containing metadata for Agent integration.
            tool_func: The original function being decorated.
            metadata: The FunctionToolMetadata object with extracted function information.
        """
        super().__init__()

        self._tool_name = tool_name
        self._tool_spec = tool_spec
        self._tool_func = tool_func
        self._metadata = metadata

        functools.update_wrapper(wrapper=self, wrapped=self._tool_func)

    def __get__(self, instance: Any, obj_type: type | None = None) -> "DecoratedFunctionTool[P, R]":
        """Descriptor protocol implementation for proper method binding.

        This method enables the decorated function to work correctly when used as a class method.
        It binds the instance to the function call when accessed through an instance.

        Args:
            instance: The instance through which the descriptor is accessed, or None when accessed through the class.
            obj_type: The class through which the descriptor is accessed.

        Returns:
            A new DecoratedFunctionTool with the instance bound to the function if accessed through an instance,
            otherwise returns self.

        Example:
            ```python
            class MyClass:
                @tool
                def my_tool():
                    ...

            instance = MyClass()
            # instance of DecoratedFunctionTool that works as you'd expect
            tool = instance.my_tool
            ```
        """
        if instance is not None and not inspect.ismethod(self._tool_func):
            # Create a bound method
            tool_func = self._tool_func.__get__(instance, instance.__class__)
            return DecoratedFunctionTool(self._tool_name, self._tool_spec, tool_func, self._metadata)

        return self

    def __call__(self, *args: P.args, **kwargs: P.kwargs) -> R:
        """Call the original function with the provided arguments.

        This method enables the decorated function to be called directly with its original signature,
        preserving the normal function call behavior.

        Args:
            *args: Positional arguments to pass to the function.
            **kwargs: Keyword arguments to pass to the function.

        Returns:
            The result of the original function call.
        """
        return self._tool_func(*args, **kwargs)

    @property
    def tool_name(self) -> str:
        """Get the name of the tool.

        Returns:
            The tool name as a string.
        """
        return self._tool_name

    @property
    def tool_spec(self) -> ToolSpec:
        """Get the tool specification.

        Returns:
            The tool specification dictionary containing metadata for Agent integration.
        """
        return self._tool_spec

    @tool_spec.setter
    def tool_spec(self, value: ToolSpec) -> None:
        """Set the tool specification.

        This allows runtime modification of the tool's schema, enabling dynamic
        tool configurations based on feature flags or other runtime conditions.

        Args:
            value: The new tool specification.

        Raises:
            ValueError: If the spec fails structural validation (wrong name or
                missing required field).
        """
        if value.get("name") != self._tool_name:
            raise ValueError(
                f"cannot change tool name via tool_spec (expected '{self._tool_name}', got '{value.get('name')}')"
            )

        for field in ("description", "inputSchema"):
            if field not in value:
                raise ValueError(f"tool_spec must contain '{field}'")

        self._tool_spec = value

    @property
    def tool_type(self) -> str:
        """Get the type of the tool.

        Returns:
            The string "function" indicating this is a function-based tool.
        """
        return "function"

    @override
    async def stream(self, tool_use: ToolUse, invocation_state: dict[str, Any], **kwargs: Any) -> ToolGenerator:
        """Stream the tool with a tool use specification.

        This method handles tool use streams from a Strands Agent. It validates the input,
        calls the function, and formats the result according to the expected tool result format.

        Key operations:

        1. Extract tool use ID and input parameters
        2. Validate input against the function's expected parameters
        3. Call the function with validated input
        4. Format the result as a standard tool result
        5. Handle and format any errors that occur

        Args:
            tool_use: The tool use specification from the Agent.
            invocation_state: Caller-provided kwargs that were passed to the agent when it was invoked (agent(),
                              agent.invoke_async(), etc.).
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Tool events with the last being the tool result.
        """
        # This is a tool use call - process accordingly
        tool_use_id = tool_use.get("toolUseId", "unknown")
        tool_input: dict[str, Any] = tool_use.get("input", {})
        tool_context = cast(ToolContext | None, kwargs.get("_tool_context"))

        try:
            # Validate input against the Pydantic model
            validated_input = self._metadata.validate_input(tool_input)

            # Inject special framework-provided parameters
            self._metadata.inject_special_parameters(validated_input, tool_use, invocation_state, tool_context)

            # Note: "Too few arguments" expected for the _tool_func calls, hence the type ignore

            # Async-generators, yield streaming events and final tool result
            if inspect.isasyncgenfunction(self._tool_func):
                sub_events = self._tool_func(**validated_input)  # type: ignore
                async for sub_event in sub_events:
                    yield ToolStreamEvent(tool_use, sub_event)

                # The last event is the result
                yield self._wrap_tool_result(tool_use_id, sub_event)

            # Async functions, yield only the result
            elif inspect.iscoroutinefunction(self._tool_func):
                result = await self._tool_func(**validated_input)  # type: ignore
                yield self._wrap_tool_result(tool_use_id, result)

            # Other functions, yield only the result
            else:
                result = await asyncio.to_thread(self._tool_func, **validated_input)  # type: ignore
                yield self._wrap_tool_result(tool_use_id, result)

        except InterruptException as e:
            yield ToolInterruptEvent(tool_use, [e.interrupt])
            return

        except ValueError as e:
            # Special handling for validation errors
            error_msg = str(e)
            yield self._wrap_tool_result(
                tool_use_id,
                {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": f"Error: {error_msg}"}],
                },
                exception=e,
            )
        except Exception as e:
            # Return error result with exception details for any other error
            error_type = type(e).__name__
            error_msg = str(e)
            yield self._wrap_tool_result(
                tool_use_id,
                {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": f"Error: {error_type} - {error_msg}"}],
                },
                exception=e,
            )

    def _wrap_tool_result(self, tool_use_d: str, result: Any, exception: Exception | None = None) -> ToolResultEvent:
        # FORMAT THE RESULT for Strands Agent
        if isinstance(result, dict) and "status" in result and "content" in result:
            # Result is already in the expected format, just add toolUseId
            result["toolUseId"] = tool_use_d
            return ToolResultEvent(cast(ToolResult, result), exception=exception)
        else:
            # Wrap any other return value in the standard format
            # Serialize to JSON for consistent, parseable output (except strings)
            if isinstance(result, str):
                text = result
            elif isinstance(result, BaseModel):
                try:
                    text = result.model_dump_json()
                except PydanticSerializationError:
                    text = str(result)
            else:
                try:
                    text = json.dumps(result, ensure_ascii=False)
                except (TypeError, ValueError):
                    text = str(result)

            return ToolResultEvent(
                {
                    "toolUseId": tool_use_d,
                    "status": "success",
                    "content": [{"text": text}],
                },
                exception=exception,
            )

    @property
    def supports_hot_reload(self) -> bool:
        """Check if this tool supports automatic reloading when modified.

        Returns:
            Always true for function-based tools.
        """
        return True

    @override
    def get_display_properties(self) -> dict[str, str]:
        """Get properties to display in UI representations.

        Returns:
            Function properties (e.g., function name).
        """
        properties = super().get_display_properties()
        properties["Function"] = self._tool_func.__name__
        return properties


# Handle @decorator
@overload
def tool(__func: Callable[P, R]) -> DecoratedFunctionTool[P, R]: ...
# Handle @decorator()
@overload
def tool(
    description: str | None = None,
    inputSchema: JSONSchema | None = None,
    name: str | None = None,
    context: bool | str = False,
) -> Callable[[Callable[P, R]], DecoratedFunctionTool[P, R]]: ...
# Suppressing the type error because we want callers to be able to use both `tool` and `tool()` at the
# call site, but the actual implementation handles that and it's not representable via the type-system
def tool(  # type: ignore
    func: Callable[P, R] | None = None,
    description: str | None = None,
    inputSchema: JSONSchema | None = None,
    name: str | None = None,
    context: bool | str = False,
) -> DecoratedFunctionTool[P, R] | Callable[[Callable[P, R]], DecoratedFunctionTool[P, R]]:
    """Decorator that transforms a Python function into a Strands tool.

    This decorator seamlessly enables a function to be called both as a regular Python function and as a Strands tool.
    It extracts metadata from the function's signature, docstring, and type hints to generate an OpenAPI-compatible tool
    specification.

    When decorated, a function:

    1. Still works as a normal function when called directly with arguments
    2. Processes tool use API calls when provided with a tool use dictionary
    3. Validates inputs against the function's type hints and parameter spec
    4. Formats return values according to the expected Strands tool result format
    5. Provides automatic error handling and reporting

    The decorator can be used in two ways:
    - As a simple decorator: `@tool`
    - With parameters: `@tool(name="custom_name", description="Custom description")`

    Args:
        func: The function to decorate. When used as a simple decorator, this is the function being decorated.
            When used with parameters, this will be None.
        description: Optional custom description to override the function's docstring.
        inputSchema: Optional custom JSON schema to override the automatically generated schema.
        name: Optional custom name to override the function's name.
        context: When provided, places an object in the designated parameter. If True, the param name
            defaults to 'tool_context', or if an override is needed, set context equal to a string to designate
            the param name.

    Returns:
        An AgentTool that also mimics the original function when invoked

    Example:
        ```python
        @tool
        def my_tool(name: str, count: int = 1) -> str:
            # Does something useful with the provided parameters.
            #
            # Parameters:
            #   name: The name to process
            #   count: Number of times to process (default: 1)
            #
            # Returns:
            #   A message with the result
            return f"Processed {name} {count} times"

        agent = Agent(tools=[my_tool])
        agent.my_tool(name="example", count=3)
        # Returns: {
        #   "toolUseId": "123",
        #   "status": "success",
        #   "content": [{"text": "Processed example 3 times"}]
        # }
        ```

    Example with parameters:
        ```python
        @tool(name="custom_tool", description="A tool with a custom name and description", context=True)
        def my_tool(name: str, count: int = 1, tool_context: ToolContext) -> str:
            tool_id = tool_context["tool_use"]["toolUseId"]
            return f"Processed {name} {count} times with tool ID {tool_id}"
        ```
    """

    def decorator(f: T) -> "DecoratedFunctionTool[P, R]":
        # Resolve context parameter name
        if isinstance(context, bool):
            context_param = "tool_context" if context else None
        else:
            context_param = context.strip()
            if not context_param:
                raise ValueError("Context parameter name cannot be empty")

        # Create function tool metadata
        tool_meta = FunctionToolMetadata(f, context_param)
        tool_spec = tool_meta.extract_metadata()
        if name is not None:
            tool_spec["name"] = name
        if description is not None:
            tool_spec["description"] = description
        if inputSchema is not None:
            tool_spec["inputSchema"] = inputSchema

        tool_name = tool_spec.get("name", f.__name__)

        if not isinstance(tool_name, str):
            raise ValueError(f"Tool name must be a string, got {type(tool_name)}")

        return DecoratedFunctionTool(tool_name, tool_spec, f, tool_meta)

    # Handle both @tool and @tool() syntax
    if func is None:
        # Need to ignore type-checking here since it's hard to represent the support
        # for both flows using the type system
        return decorator

    return decorator(func)
