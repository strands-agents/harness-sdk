"""Tools for converting Pydantic models to structured-output tool specifications."""

from copy import deepcopy
from typing import Any

from pydantic import BaseModel

from ...types.tools import ToolSpec


def convert_pydantic_to_tool_spec(
    model: type[BaseModel],
    description: str | None = None,
) -> ToolSpec:
    """Convert a Pydantic model to a structured-output tool specification.

    Preserves Pydantic's JSON Schema and uses model docstrings for the tool description.

    Args:
        model: The Pydantic model class to convert.
        description: Optional description of the tool's purpose.

    Returns:
        The structured-output tool specification.

    Raises:
        ValueError: If a top-level schema reference cannot be resolved.
    """
    name = model.__name__
    input_schema = _inline_root_reference(model.model_json_schema())
    model_description = description or (model.__doc__.strip() if model.__doc__ else None)

    return ToolSpec(
        name=name,
        description=model_description or f"{name} structured output tool",
        inputSchema={"json": input_schema},
    )


def _inline_root_reference(schema: dict[str, Any]) -> dict[str, Any]:
    """Inline a top-level Pydantic definition while preserving its reference scope.

    Args:
        schema: The JSON Schema returned by the Pydantic model.

    Returns:
        A top-level object schema with internal definitions preserved.
    """
    root_reference = schema.get("$ref")
    if not isinstance(root_reference, str):
        return schema

    prefix = "#/$defs/"
    definitions = schema.get("$defs")
    if not root_reference.startswith(prefix) or not isinstance(definitions, dict):
        raise ValueError(f"Unsupported top-level JSON Schema reference: {root_reference}")

    definition_name = root_reference.removeprefix(prefix).replace("~1", "/").replace("~0", "~")
    root_definition = definitions.get(definition_name)
    if not isinstance(root_definition, dict):
        raise ValueError(f"Missing top-level JSON Schema definition: {definition_name}")

    inlined_schema = deepcopy(root_definition)
    inlined_schema["$defs"] = deepcopy(definitions)
    return inlined_schema
