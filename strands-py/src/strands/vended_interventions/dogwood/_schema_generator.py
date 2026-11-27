"""Cedar action schema generation from Strands tool specs, via Dogwood's MCP converter."""

from __future__ import annotations

import re
from typing import Any

from dogwood import mcp_to_cedar_schema

from ...types.tools import AgentTool, ToolSpec

GENERATED_NAMESPACE = "Drupe"
"""The namespace Dogwood's schema generator emits. It takes no namespace of its own."""

GENERATED_RESOURCE = "Gateway"
"""The resource entity Dogwood's schema generator emits, from its MCP-gateway template."""

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
    """Declare a generated schema under ``namespace``, or at the top level when there is none.

    Generation hardcodes :data:`GENERATED_NAMESPACE` and takes no namespace of its own, so the
    name is rewritten after the fact.

    An object parameter is generated as its own entity type and referenced qualified, so those
    references move with the declaration. They are rewritten first, so the rename does not have
    to exclude the declaration itself.

    Args:
        schema: Generated Cedar action schema text.
        namespace: The namespace to declare, or None for the top level.

    Returns:
        The schema, requalified.
    """
    if namespace == GENERATED_NAMESPACE:
        return schema

    requalified = schema.replace(f"{GENERATED_NAMESPACE}::", "" if namespace is None else f"{namespace}::")
    if namespace is not None:
        return requalified.replace(f"namespace {GENERATED_NAMESPACE} {{", f"namespace {namespace} {{", 1)

    unwrapped = requalified.replace(f"namespace {GENERATED_NAMESPACE} {{", "", 1)
    return re.sub(r"\}\s*$", "", unwrapped)


def assert_cedar_namespace(namespace: str | None) -> None:
    """Validate a configured namespace.

    An illegal one otherwise surfaces as a schema parse error naming generated text the caller
    never wrote.

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

    Only the declaration and the action references are rewritten: a tool or parameter whose own
    name contains :data:`GENERATED_RESOURCE` must keep it, or the action it declares becomes
    unreachable.

    Args:
        schema: Generated Cedar action schema text.

    Returns:
        The schema with its resource entity renamed.
    """
    renamed = schema.replace(f"entity {GENERATED_RESOURCE};", f"entity {RESOURCE};", 1)
    return renamed.replace(f"resource: [{GENERATED_RESOURCE}]", f"resource: [{RESOURCE}]")


def _allow_absent_input(schema: str, specs: list[ToolSpec]) -> str:
    """Declare ``input`` optional for every tool whose arguments are all optional.

    Dogwood drops an empty record from an event, so a tool the model calls with no arguments
    arrives with no ``input`` group at all; generation declares the group required, which fails
    conformance and denies the call. A tool with a required parameter keeps it required, because
    an empty call there is a genuine mismatch.

    A policy reading one of those parameters already needs a ``has`` guard — the parameter is
    optional too — so this adds ``context has input`` to a guard a policy was writing anyway.

    Args:
        schema: Generated Cedar action schema text.
        specs: The tool specs the schema was generated from.

    Returns:
        The schema, with ``input`` optional on the actions whose arguments may be absent.

    Raises:
        ValueError: If a tool's ``input`` declaration is not found exactly once, which means the
            installed Dogwood generates a shape this does not recognize.
    """
    for spec in specs:
        if _required_parameters(spec):
            continue
        name = spec["name"]
        # The declaration has to be matched whole: `input: aInput` is a prefix of the next tool's
        # `input: aInputInput`, and relaxing that one would admit a call missing a required
        # argument. The type name ends the declaration, so the lookahead anchors it.
        declaration = re.compile(rf"\binput: {re.escape(name)}Input(?=[,\s])")
        schema, found = declaration.subn(f"input?: {name}Input", schema)
        if found != 1:
            raise ValueError(
                f"expected one `input: {name}Input` declaration in the generated schema for tool '{name}', "
                f"found {found}; the installed `dogwood-aws` generates a shape this handler cannot relax"
            )
    return schema


def _required_parameters(spec: ToolSpec) -> list[str]:
    """The parameters a tool spec requires, reading either input-schema shape the converter takes.

    Args:
        spec: A tool spec, with its JSON Schema either wrapped in ``json`` or bare.

    Returns:
        The required parameter names, empty when every parameter is optional.
    """
    input_schema = spec.get("inputSchema") or {}
    return input_schema.get("json", input_schema).get("required") or []


def _retype_for_raw_arguments(spec: ToolSpec | dict[str, Any]) -> dict[str, Any]:
    """Retype a tool spec to the JSON a Cedar condition actually compares against.

    Generation types an ``enum`` constraint as an entity type and a ``number`` as ``decimal``,
    neither of which a raw argument matches: the Cedar-typed form type-checks and then never
    fires, and ``decimal`` rejects the ordering operators. Dropping the constraint generates
    ``String`` instead, and promoting ``number`` to ``integer`` generates ``Long``.

    Only a list-valued ``enum`` and the exact string ``'number'`` are rewritten, so a parameter
    *named* ``enum`` or ``type`` is untouched.

    Args:
        spec: A tool spec.

    Returns:
        A copy of the spec, retyped.
    """
    retyped: dict[str, Any] = {}
    for key, value in spec.items():
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
