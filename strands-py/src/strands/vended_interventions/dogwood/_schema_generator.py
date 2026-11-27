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
        ValueError: If the generated schema is not in the shape the rewrites below read.
    """
    specs = specs_of(tools)
    unconstrained = [_drop_enum_constraints(spec) for spec in specs]
    return _allow_absent_input(_rename_resource(mcp_to_cedar_schema(unconstrained)), specs)


def specs_of(tools: list[AgentTool | ToolSpec]) -> list[ToolSpec]:
    """The specs of ``tools``, which may be the tools themselves or already their specs.

    Args:
        tools: The tools to read specs from.

    Returns:
        One spec per tool, in order.
    """
    return [tool.tool_spec if isinstance(tool, AgentTool) else tool for tool in tools]


def decimal_parameters(specs: list[ToolSpec]) -> dict[str, frozenset[str]]:
    """The parameters a generated schema declares ``decimal``, by tool name.

    Only a tool's own parameters: a parameter nested in an object is generated as an entity type,
    which a raw JSON argument never matches whatever its numbers are.

    Args:
        specs: The tool specs the schema was generated from.

    Returns:
        Tool name to its ``number`` parameter names, omitting the tools that declare none.
    """
    by_tool = {}
    for spec in specs:
        properties = _input_schema(spec).get("properties") or {}
        names = frozenset(name for name, declared in properties.items() if _declares_number(declared))
        if names:
            by_tool[spec["name"]] = names
    return by_tool


def _declares_number(declared: Any) -> bool:
    """Whether a parameter declaration is a JSON Schema ``number``, or an array of them."""
    if not isinstance(declared, dict):
        return False
    if declared.get("type") == "number":
        return True
    return declared.get("type") == "array" and _declares_number(declared.get("items"))


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

    declaration = f"namespace {GENERATED_NAMESPACE} {{"
    _assert_rewritable(schema, declaration, expected=1)
    # Qualified references first — an object parameter is generated as its own entity type and
    # referenced qualified — so renaming the declaration does not have to exclude itself.
    requalified = schema.replace(f"{GENERATED_NAMESPACE}::", "" if namespace is None else f"{namespace}::")
    if namespace is not None:
        return requalified.replace(declaration, f"namespace {namespace} {{", 1)

    unwrapped = requalified.replace(declaration, "", 1)
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

    Raises:
        ValueError: If the generated schema does not declare the resource entity, or no action
            applies to it.
    """
    declaration = f"entity {GENERATED_RESOURCE};"
    reference = f"resource: [{GENERATED_RESOURCE}]"
    _assert_rewritable(schema, declaration, expected=1)
    _assert_rewritable(schema, reference)
    # Only the declaration and the action references: a tool or parameter whose own name contains
    # `Gateway` must keep it, or the action it declares becomes unreachable.
    renamed = schema.replace(declaration, f"entity {RESOURCE};", 1)
    return renamed.replace(reference, f"resource: [{RESOURCE}]")


def _assert_rewritable(schema: str, text: str, expected: int | None = None) -> None:
    """Assert the generated schema carries text a rewrite below replaces.

    A rewrite is a plain string replacement, so a generator that stops emitting the text would
    otherwise leave the schema declaring one name while policies are validated against another.

    Args:
        schema: Generated Cedar action schema text.
        text: The text a rewrite replaces.
        expected: The exact number of occurrences required, or None for at least one.

    Raises:
        ValueError: If the count does not match, which means the installed Dogwood emits a shape
            this handler cannot rewrite.
    """
    found = schema.count(text)
    if found == expected or (expected is None and found > 0):
        return

    wanted = "at least one" if expected is None else str(expected)
    raise ValueError(
        f"expected {wanted} `{text}` in the generated schema, found {found}; the installed "
        f"`dogwood-aws` emits a shape this handler cannot rewrite"
    )


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


def _input_schema(spec: ToolSpec) -> dict[str, Any]:
    """A tool's JSON Schema, reading either input-schema shape the converter takes."""
    input_schema = spec.get("inputSchema") or {}
    json_schema: dict[str, Any] = input_schema.get("json", input_schema)
    return json_schema


def _required_parameters(spec: ToolSpec) -> list[str]:
    """The parameters a tool requires, empty when every one is optional."""
    return _input_schema(spec).get("required") or []


def _drop_enum_constraints(spec: ToolSpec | dict[str, Any]) -> dict[str, Any]:
    """Drop every ``enum`` constraint from a tool spec, so a Cedar condition can compare the value.

    An ``enum`` parameter is generated as an entity type, so comparing it to a string type-checks
    and then never fires; without the constraint it generates ``String``. Dogwood's own generator
    config turns this off and ``mcp_to_cedar_schema`` takes no config argument, so the spec is
    rewritten on the way in instead.

    Args:
        spec: A tool spec.

    Returns:
        A copy of the spec, carrying no ``enum`` constraint.
    """
    dropped: dict[str, Any] = {}
    for key, value in spec.items():
        # Only a list-valued `enum`, so a parameter *named* `enum` is untouched.
        if key == "enum" and isinstance(value, list):
            continue
        if isinstance(value, dict):
            dropped[key] = _drop_enum_constraints(value)
        elif isinstance(value, list):
            dropped[key] = [_drop_enum_constraints(item) if isinstance(item, dict) else item for item in value]
        else:
            dropped[key] = value
    return dropped
