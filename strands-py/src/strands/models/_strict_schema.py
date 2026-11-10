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


def ensure_strict_json_schema(
    schema: dict[str, Any],
    *,
    require_all_properties: bool = False,
) -> dict[str, Any]:
    """Ensure a JSON schema conforms to strict tool use requirements.

    Creates a deep copy of the schema and recursively:
    1. Adds ``"additionalProperties": false`` to all ``object`` types that do not already define it
    2. Optionally adds all properties to the ``required`` array (needed for OpenAI)
    3. Handles ``$defs``, ``definitions``, ``anyOf``, ``allOf``, ``items``, and ``$ref``

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


def _apply_strict(
    schema: dict[str, Any],
    *,
    root: dict[str, Any],
    require_all_properties: bool,
) -> None:
    """Recursively apply strict-mode constraints to a JSON schema in place.

    Args:
        schema: The schema node to process (modified in place).
        root: The root schema, used for resolving ``$ref`` pointers.
        require_all_properties: If True, add all properties to ``required``.
    """
    # Process $defs / definitions blocks
    for defs_key in ("$defs", "definitions"):
        defs = schema.get(defs_key)
        if isinstance(defs, dict):
            for def_schema in defs.values():
                if isinstance(def_schema, dict):
                    _apply_strict(def_schema, root=root, require_all_properties=require_all_properties)

    # Add additionalProperties: false to object types that lack it
    if schema.get("type") == "object" and "additionalProperties" not in schema:
        schema["additionalProperties"] = False

    # Process properties and optionally enforce required
    properties = schema.get("properties")
    if isinstance(properties, dict):
        if require_all_properties:
            schema["required"] = list(properties.keys())

        for prop_schema in properties.values():
            if isinstance(prop_schema, dict):
                _apply_strict(prop_schema, root=root, require_all_properties=require_all_properties)

    # Process array items
    items = schema.get("items")
    if isinstance(items, dict):
        _apply_strict(items, root=root, require_all_properties=require_all_properties)

    # Process anyOf variants
    any_of = schema.get("anyOf")
    if isinstance(any_of, list):
        for variant in any_of:
            if isinstance(variant, dict):
                _apply_strict(variant, root=root, require_all_properties=require_all_properties)

    # Process allOf variants
    all_of = schema.get("allOf")
    if isinstance(all_of, list):
        for entry in all_of:
            if isinstance(entry, dict):
                _apply_strict(entry, root=root, require_all_properties=require_all_properties)

    # Process oneOf variants
    one_of = schema.get("oneOf")
    if isinstance(one_of, list):
        for variant in one_of:
            if isinstance(variant, dict):
                _apply_strict(variant, root=root, require_all_properties=require_all_properties)

    # Resolve $ref combined with other keys by inlining the referenced schema
    ref = schema.get("$ref")
    if isinstance(ref, str) and len(schema) > 1:
        resolved = _resolve_ref(root, ref)
        if isinstance(resolved, dict):
            # Inline the resolved schema, giving priority to existing keys
            merged = {**copy.deepcopy(resolved), **schema}
            merged.pop("$ref", None)
            schema.clear()
            schema.update(merged)
            # Re-apply strict to the inlined schema
            _apply_strict(schema, root=root, require_all_properties=require_all_properties)


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
