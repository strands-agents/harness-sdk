"""Strict JSON schema transformation for tool definitions.

When model providers require `strict: true` on tool definitions, they also require
`"additionalProperties": false` on every `object` type in the input schema. This module
provides a utility to recursively apply that constraint.

Modeled after OpenAI's `_ensure_strict_json_schema`:
https://github.com/openai/openai-python/blob/main/src/openai/lib/_pydantic.py
"""

import copy
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Keywords whose value is a map of subschemas.
_SCHEMA_MAP_KEYWORDS = ("$defs", "definitions", "properties")
# Keywords whose value is a list of subschemas.
_SCHEMA_LIST_KEYWORDS = ("anyOf", "allOf", "oneOf")
# Keywords whose value is a single subschema.
_SCHEMA_VALUE_KEYWORDS = ("items", "additionalProperties")


def ensure_strict_json_schema(
    schema: dict[str, Any],
    *,
    require_all_properties: bool = False,
) -> dict[str, Any]:
    """Ensure a JSON schema conforms to strict tool use requirements.

    Creates a deep copy of the schema and recursively:
    1. Adds ``"additionalProperties": false`` to all ``object`` types that do not already define it
    2. Optionally adds all properties to the ``required`` array (needed for OpenAI)
    3. Handles ``$defs``, ``definitions``, ``anyOf``, ``allOf``, ``oneOf``, ``items``,
       schema-valued ``additionalProperties``, and ``$ref``

    Args:
        schema: The JSON schema to process. A deep copy is made internally so the original is not mutated.
        require_all_properties: If True, set ``required`` to include all property keys. OpenAI strict mode
            requires this; Bedrock and Anthropic do not.

    Returns:
        A new schema dict with strict-mode constraints applied.
    """
    schema_copy = copy.deepcopy(schema)
    _apply_strict(schema_copy, root=schema_copy, require_all_properties=require_all_properties)
    return schema_copy


def _child_schemas(schema: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the direct subschemas of a schema node, including ``$defs``/``definitions`` entries."""
    children: list[Any] = []
    for keyword in _SCHEMA_MAP_KEYWORDS:
        mapping = schema.get(keyword)
        if isinstance(mapping, dict):
            children.extend(mapping.values())
    for keyword in _SCHEMA_LIST_KEYWORDS:
        entries = schema.get(keyword)
        if isinstance(entries, list):
            children.extend(entries)
    for keyword in _SCHEMA_VALUE_KEYWORDS:
        children.append(schema.get(keyword))
    return [child for child in children if isinstance(child, dict)]


def _is_object_type(schema: dict[str, Any]) -> bool:
    """Return whether a schema node is an object type, including union types that include ``"object"``."""
    schema_type = schema.get("type")
    return schema_type == "object" or (isinstance(schema_type, list) and "object" in schema_type)


def _apply_strict(
    schema: dict[str, Any],
    *,
    root: dict[str, Any],
    require_all_properties: bool,
    inlining: frozenset[str] = frozenset(),
) -> None:
    """Recursively apply strict-mode constraints to a JSON schema in place.

    Args:
        schema: The schema node to process (modified in place).
        root: The root schema, used for resolving ``$ref`` pointers.
        require_all_properties: If True, add all properties to ``required``.
        inlining: The ``$ref`` values currently being inlined on this path, so a recursive
            ``$ref`` terminates instead of inlining forever.
    """
    # A node still carrying a $ref is left for the inline below, so the target's own value wins.
    if _is_object_type(schema) and "additionalProperties" not in schema and "$ref" not in schema:
        schema["additionalProperties"] = False

    properties = schema.get("properties")
    if require_all_properties and isinstance(properties, dict):
        schema["required"] = list(properties.keys())

    for child in _child_schemas(schema):
        _apply_strict(child, root=root, require_all_properties=require_all_properties, inlining=inlining)

    # Resolve $ref combined with other keys by inlining the referenced schema
    ref = schema.get("$ref")
    if not isinstance(ref, str) or len(schema) <= 1:
        return
    if ref in inlining:
        logger.warning("ref=<%s> | recursive $ref cannot be inlined, leaving it unresolved", ref)
        return
    resolved = _resolve_ref(root, ref)
    if not isinstance(resolved, dict):
        return
    # Inline the resolved schema, giving priority to existing keys
    merged = {**copy.deepcopy(resolved), **schema}
    merged.pop("$ref", None)
    schema.clear()
    schema.update(merged)
    # Re-apply strict to the inlined schema
    _apply_strict(
        schema,
        root=root,
        require_all_properties=require_all_properties,
        inlining=inlining | {ref},
    )


def _resolve_ref(root: dict[str, Any], ref: str) -> dict[str, Any] | None:
    """Resolve a JSON Schema ``$ref`` pointer against the root schema.

    Args:
        root: The root schema containing definitions.
        ref: A JSON pointer string (e.g., ``#/$defs/MyModel``).

    Returns:
        The resolved schema dict, or None if resolution fails.
    """
    if not ref.startswith("#/"):
        logger.warning("ref=<%s> | unexpected $ref format, skipping resolution", ref)
        return None

    path = ref[2:].split("/")
    current: Any = root
    for key in path:
        if not isinstance(current, dict) or key not in current:
            logger.warning("ref=<%s> | failed to resolve $ref path", ref)
            return None
        current = current[key]

    if not isinstance(current, dict):
        logger.warning("ref=<%s> | resolved to non-dict value", ref)
        return None

    return current
