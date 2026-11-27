"""Cedar action schema generation from Strands tool specs, via Dogwood's MCP converter.

An action schema is Cedar schema text, which Dogwood consumes as-is, so the names and the
namespace rules here are Cedar's.
"""

import re
from typing import Any

from dogwood import mcp_to_cedar_schema

from ...types.tools import AgentTool, ToolSpec

GENERATED_NAMESPACE = "Drupe"
"""The namespace Dogwood's generator emits, from the MCP-gateway template it bundles
(``dogwood-language/configuration/mcp-template.cedarschema``). It takes no namespace of its own."""

GENERATED_RESOURCE = "Gateway"
"""The resource entity Dogwood's generator emits, from the same template."""

RESOURCE = "Resource"
"""The resource entity a schema declares, matching ``CedarAuthorization``."""

_CEDAR_NAMESPACE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$")
"""A Cedar namespace: one or more ``::``-separated identifiers."""

_CEDAR_RESERVED = frozenset({"true", "false", "if", "then", "else", "in", "is", "like", "has"})
"""Identifiers Cedar's grammar admits as a namespace and its parser then rejects."""

_CEDAR_INTERNAL_PREFIX = "__cedar"
"""Cedar reserves this prefix for its own types."""


def generate_action_schema(tools: list[AgentTool | ToolSpec]) -> str:
    """Generate a Cedar action schema from tool specs.

    Args:
        tools: The tools the actions are generated from, as tools or their specs.

    Returns:
        Cedar action schema text, declared under :data:`GENERATED_NAMESPACE`.

    Raises:
        DogwoodError: If a tool spec is not a manifest the converter accepts.
        ValueError: If the generated schema is not in the shape :func:`_allow_absent_input` reads.
    """
    specs = [tool.tool_spec if isinstance(tool, AgentTool) else tool for tool in tools]
    retyped = [_retype_for_raw_arguments(spec) for spec in specs]
    return _allow_absent_input(_rename_resource(mcp_to_cedar_schema(retyped)), specs)


def apply_namespace(schema: str, namespace: str | None) -> str:
    """Redeclare a generated schema under ``namespace``, or at the top level when there is none.

    Args:
        schema: Generated Cedar action schema text.
        namespace: The namespace to declare, or None for the top level.

    Returns:
        The schema, requalified.
    """
    if namespace == GENERATED_NAMESPACE:
        return schema

    # Qualified references first — an object parameter is generated as its own entity type and
    # referenced qualified — so renaming the declaration does not have to exclude itself.
    requalified = schema.replace(f"{GENERATED_NAMESPACE}::", "" if namespace is None else f"{namespace}::")
    if namespace is not None:
        return requalified.replace(f"namespace {GENERATED_NAMESPACE} {{", f"namespace {namespace} {{", 1)

    unwrapped = requalified.replace(f"namespace {GENERATED_NAMESPACE} {{", "", 1)
    return re.sub(r"\}\s*$", "", unwrapped)


def assert_cedar_namespace(namespace: str | None) -> None:
    """Reject a namespace Cedar will not parse, which otherwise surfaces as a schema parse error.

    Args:
        namespace: The configured namespace, or None when there is none.

    Raises:
        ValueError: If the namespace is not ``::``-separated Cedar identifiers, or any segment is
            one Cedar reserves.
    """
    if namespace is None:
        return

    segments = namespace.split("::")
    reserved = any(segment in _CEDAR_RESERVED or segment.startswith(_CEDAR_INTERNAL_PREFIX) for segment in segments)
    if reserved or not _CEDAR_NAMESPACE.match(namespace):
        raise ValueError(f"`namespace` must be `::`-separated Cedar identifiers, none of them reserved: '{namespace}'")


def namespace_prefix_of(actions: list[str]) -> str:
    """The namespace the schema's actions live in, as a prefix ready to concatenate.

    Args:
        actions: The fully qualified action ids the schema declares.

    Returns:
        The namespace with its trailing ``::``, or an empty string for a top-level schema.
    """
    if not actions:
        return ""

    marker = "::Action::"
    # Last, so a namespace with an `Action` segment of its own stays whole.
    index = actions[0].rfind(marker)
    return actions[0][: index + 2] if index > 0 else ""


def _rename_resource(schema: str) -> str:
    """Rename the generator's resource entity to the one ``CedarAuthorization`` uses.

    A policy naming the resource then reads the same against either handler.
    """
    # Only the declaration and the action references: a tool or parameter whose own name contains
    # `Gateway` must keep it, or the action it declares becomes unreachable.
    renamed = schema.replace(f"entity {GENERATED_RESOURCE};", f"entity {RESOURCE};", 1)
    return renamed.replace(f"resource: [{GENERATED_RESOURCE}]", f"resource: [{RESOURCE}]")


def _allow_absent_input(schema: str, specs: list[ToolSpec]) -> str:
    """Declare ``input`` optional for every tool whose arguments are all optional.

    Dogwood drops an empty record from an event, so a tool the model calls with no arguments
    arrives with no ``input`` group at all, and the required group generation declares then denies
    the call. A tool with a required parameter keeps it required: an empty call there is a genuine
    mismatch.

    Args:
        schema: Generated Cedar action schema text.
        specs: The tool specs the schema was generated from.

    Returns:
        The schema, with ``input`` optional on the actions whose arguments may be absent.

    Raises:
        ValueError: If a tool's ``input`` declaration is not found exactly once, which means the
            installed Dogwood generates a shape this does not recognize.
    """
    for name in [spec["name"] for spec in specs if not _required_parameters(spec)]:
        # Matched whole: `input: aInput` is also a prefix of a tool named `aInput`'s own
        # `input: aInputInput`, and relaxing that one would admit a call missing a required argument.
        schema, found = re.subn(rf"\binput: {re.escape(name)}Input(?=[,\s])", f"input?: {name}Input", schema)
        if found != 1:
            raise ValueError(
                f"expected one `input: {name}Input` declaration in the generated schema for tool '{name}', "
                f"found {found}; the installed `dogwood-aws` generates a shape this handler cannot relax"
            )
    return schema


def _required_parameters(spec: ToolSpec) -> list[str]:
    """The parameters a tool requires, reading either input-schema shape the converter takes."""
    input_schema = spec.get("inputSchema") or {}
    return input_schema.get("json", input_schema).get("required") or []


def _retype_for_raw_arguments(spec: ToolSpec | dict[str, Any]) -> dict[str, Any]:
    """Retype a tool spec so a Cedar condition can compare the raw JSON arguments a model sends.

    Two of the generated types never match one:

    - A parameter with an ``enum`` constraint is generated as an entity type, so comparing it to a
      string type-checks and then never fires. Dropping the constraint generates ``String``.
    - A ``number`` parameter is generated as ``decimal``, which rejects ``<`` and ``>``. Declaring
      it ``integer`` generates ``Long``, which accepts them.

    Dogwood's own generator config turns both on and ``mcp_to_cedar_schema`` takes no config
    argument, so the spec is rewritten on the way in instead.

    Args:
        spec: A tool spec.

    Returns:
        A copy of the spec, retyped.
    """
    retyped: dict[str, Any] = {}
    for key, value in spec.items():
        # Only a list-valued `enum` and the exact string `number`, so a parameter *named* `enum` or
        # `type` is untouched.
        if key == "enum" and isinstance(value, list):
            continue
        if key == "type" and value == "number":
            retyped[key] = "integer"
        elif isinstance(value, dict):
            retyped[key] = _retype_for_raw_arguments(value)
        elif isinstance(value, list):
            retyped[key] = [_retype_for_raw_arguments(item) if isinstance(item, dict) else item for item in value]
        else:
            retyped[key] = value
    return retyped
