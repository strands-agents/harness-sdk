"""Structured output enforcement for model providers: mechanism order, learned support, and native output schemas.

What a model rejects is learned from its errors and kept for the life of the process, without eviction: support is a
property of the model, and a stale entry costs at most a weaker mechanism. Records are single set insertions, made
from the event loop (AnthropicModel) and from a worker thread (BedrockModel); concurrent records can only repeat one.
"""

import logging
import warnings
from collections.abc import Set
from typing import Any, Literal

from pydantic import BaseModel

logger = logging.getLogger(__name__)

# Ways a provider can enforce a structured output request, strongest first.
StructuredOutputMechanism = Literal["forced", "native", "auto"]
STRUCTURED_OUTPUT_MECHANISMS: tuple[StructuredOutputMechanism, ...] = ("forced", "native", "auto")

# Mechanisms each model was learned to reject, keyed by (provider, model_id), so later requests skip them.
_UNSUPPORTED_MECHANISMS: dict[tuple[str, str], set[StructuredOutputMechanism]] = {}

# Output models whose schema a model's native output rejected, as (provider, model_id, output_model).
_REJECTED_NATIVE_SCHEMAS: set[tuple[str, str, type[BaseModel]]] = set()

# String formats native structured output accepts; others are moved into the field description.
_SUPPORTED_STRING_FORMATS = frozenset(
    {"date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"}
)

_SUBSCHEMA_MAPS = ("properties", "$defs", "definitions")
_SUBSCHEMA_LISTS = ("anyOf", "oneOf", "allOf")
# A schema node needs one of these to be representable; without them it accepts any value, as Any does.
_SCHEMA_TYPE_KEYS = ("type", "anyOf", "oneOf", "allOf", "$ref")

# Providers report these cases only as a generic 400, so the message text is the only signal. "Documented" entries are
# published provider error text; "observed" entries were seen in live responses and may change wording.

# Error substrings meaning the model cannot be forced to call a tool.
_FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES = (
    'tool_choice: type "tool" and "any" are not supported',  # documented: Anthropic API errors, forced tool use
    "doesn't support the toolConfig.toolChoice",  # observed: Bedrock models without tool choice support
)

# Error substrings meaning the model has no native structured output.
_NATIVE_OUTPUT_UNSUPPORTED_MESSAGES = (
    "doesn't support the outputConfig field",  # observed: Bedrock models without structured output
    "output_config.format: Extra inputs are not permitted",  # observed: Claude models without structured output
)

# Error substrings meaning native structured output cannot express the schema or request.
_NATIVE_OUTPUT_REJECTED_MESSAGES = (
    "output_config.format.schema",  # observed: unsupported JSON Schema keyword
    "Schemas contains too many",  # observed: optional or union parameter limit
    "Schema is too complex",  # documented: Anthropic structured outputs, schema complexity limits
    "Citations cannot be enabled when output format is set",  # observed: citations with native output
)


def unsupported_mechanisms(
    provider: str, model_id: str, output_model: type[BaseModel]
) -> Set[StructuredOutputMechanism]:
    """The structured output mechanisms a model was learned to reject for an output model in this process."""
    unsupported = _UNSUPPORTED_MECHANISMS.get((provider, model_id), set())
    if (provider, model_id, output_model) in _REJECTED_NATIVE_SCHEMAS:
        return unsupported | {"native"}
    return unsupported


def _record_unsupported_mechanism(provider: str, model_id: str, mechanism: StructuredOutputMechanism) -> None:
    """Remember that a model rejects a structured output mechanism, so later requests skip it."""
    _UNSUPPORTED_MECHANISMS.setdefault((provider, model_id), set()).add(mechanism)
    logger.debug(
        "provider=<%s>, model_id=<%s>, mechanism=<%s> | model rejects structured output mechanism",
        provider,
        model_id,
        mechanism,
    )


def structured_output_mechanisms(
    unsupported: Set[StructuredOutputMechanism],
    tool_choice: dict[str, Any] | None,
    output_model: type[BaseModel],
) -> list[StructuredOutputMechanism]:
    """List the mechanisms to try, strongest first.

    Native output is skipped for output models it cannot represent, such as dict and tuple fields, so those models
    fall back to auto: structured output is then best effort rather than guaranteed.

    Args:
        unsupported: Mechanisms the model is known to reject.
        tool_choice: The requested tool choice; forcing is only tried when it forces a tool.
        output_model: The output model the response must produce.

    Returns:
        The mechanisms to try in order; never empty, since auto is always available.
    """
    forces_tool = tool_choice is not None and ("any" in tool_choice or "tool" in tool_choice)
    native_known_unsupported = "native" in unsupported
    feature = (
        None if native_known_unsupported else find_unsupported_native_output_feature(output_model.model_json_schema())
    )
    if feature:
        warnings.warn(
            f"Native structured output cannot represent {output_model.__name__} ({feature}); if the model cannot be "
            "forced to call the structured output tool, structured output falls back to auto tool choice",
            stacklevel=2,
        )
    return [
        mechanism
        for mechanism in STRUCTURED_OUTPUT_MECHANISMS
        if mechanism not in unsupported
        and (mechanism != "forced" or forces_tool)
        and (mechanism != "native" or not feature)
    ]


def handle_rejected_mechanism(
    provider: str, model_id: str, mechanism: StructuredOutputMechanism, output_model: type[BaseModel], message: str
) -> bool:
    """Handle a provider error for a structured output request.

    A rejection the model gives for every request is remembered per model; native output rejecting this output
    model's schema or request is remembered for that output model only, and falls back to auto.

    Args:
        provider: The provider that sent the request.
        model_id: The model the request was sent to.
        mechanism: The mechanism the rejected request used.
        output_model: The output model the request had to produce.
        message: The provider's error message.

    Returns:
        True if the rejection was recorded and the next mechanism should be tried; False if the error is unrelated and
        should surface unchanged.
    """
    if mechanism == "native" and any(signal in message for signal in _NATIVE_OUTPUT_REJECTED_MESSAGES):
        _REJECTED_NATIVE_SCHEMAS.add((provider, model_id, output_model))
        warnings.warn(
            f"Native structured output rejected {output_model.__name__} ({message}); using auto tool choice instead",
            stacklevel=2,
        )
        return True
    if not _is_unsupported_mechanism_message(message, mechanism):
        return False
    _record_unsupported_mechanism(provider, model_id, mechanism)
    return True


def _is_unsupported_mechanism_message(message: str, mechanism: StructuredOutputMechanism) -> bool:
    if mechanism == "forced":
        return any(signal in message for signal in _FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES)
    if mechanism == "native":
        return any(signal in message for signal in _NATIVE_OUTPUT_UNSUPPORTED_MESSAGES)
    return False


def find_unsupported_native_output_feature(schema: dict[str, Any]) -> str | None:
    """Find a schema feature that native structured output cannot represent without losing data.

    Native output requires ``additionalProperties: false`` on every object, has no tuple support, and needs a type on
    every node, so dict and tuple fields would be emptied or left unconstrained, and untyped fields such as ``Any``
    cannot be converted. Such models must not use native output.

    Args:
        schema: A JSON schema, for example from ``BaseModel.model_json_schema()``.

    Returns:
        A description of the first unsupported feature found, or None if the schema can be represented.
    """
    if "prefixItems" in schema:
        return "tuple fields"
    if schema.get("additionalProperties") not in (None, False) or "patternProperties" in schema:
        return "dict fields"
    if not any(key in schema for key in _SCHEMA_TYPE_KEYS):
        return "untyped fields (Any)"

    children: list[Any] = [value for key in _SUBSCHEMA_MAPS for value in schema.get(key, {}).values()]
    children.extend(value for key in _SUBSCHEMA_LISTS for value in schema.get(key, []))
    if isinstance(schema.get("items"), dict):
        children.append(schema["items"])

    for child in children:
        if isinstance(child, dict) and (feature := find_unsupported_native_output_feature(child)):
            return feature
    return None


def to_native_output_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Convert a JSON schema to the subset native structured output accepts.

    Mirrors ``anthropic.transform_schema``, which ``AnthropicModel`` uses directly, for providers without the
    ``anthropic`` package: objects get ``additionalProperties: false``, and keywords outside the supported subset are
    moved into the field description, where the model can still follow them. Validate the result against the original
    model, which still enforces every constraint.

    Args:
        schema: A JSON schema, for example from ``BaseModel.model_json_schema()``.

    Returns:
        The converted schema.

    Raises:
        ValueError: If a schema node has no ``type``, ``anyOf``, ``oneOf``, ``allOf`` or ``$ref``.
    """
    remaining = dict(schema)
    converted: dict[str, Any] = {}

    defs = remaining.pop("$defs", None)
    if defs is not None:
        converted["$defs"] = {name: to_native_output_schema(definition) for name, definition in defs.items()}

    ref = remaining.pop("$ref", None)
    if ref is not None:
        converted["$ref"] = ref
        return converted

    type_ = remaining.pop("type", None)
    _convert_composition(remaining, converted, type_)

    for key in ("enum", "description", "title"):
        if (value := remaining.pop(key, None)) is not None:
            converted[key] = value

    if type_ == "object":
        _convert_object(remaining, converted)
    elif type_ == "string":
        _convert_string(remaining, converted)
    elif type_ == "array":
        _convert_array(remaining, converted)

    if remaining:
        unsupported = "{" + ", ".join(f"{key}: {value}" for key, value in remaining.items()) + "}"
        description = converted.get("description")
        converted["description"] = f"{description}\n\n{unsupported}" if description is not None else unsupported

    return converted


def _convert_composition(remaining: dict[str, Any], converted: dict[str, Any], type_: Any) -> None:
    any_of = remaining.pop("anyOf", None)
    one_of = remaining.pop("oneOf", None)
    all_of = remaining.pop("allOf", None)

    if isinstance(any_of, list):
        converted["anyOf"] = [to_native_output_schema(variant) for variant in any_of]
    elif isinstance(one_of, list):
        converted["anyOf"] = [to_native_output_schema(variant) for variant in one_of]
    elif isinstance(all_of, list):
        converted["allOf"] = [to_native_output_schema(variant) for variant in all_of]
    elif type_ is None:
        raise ValueError("Schema must have a 'type', 'anyOf', 'oneOf', or 'allOf' field.")
    else:
        converted["type"] = type_


def _convert_object(remaining: dict[str, Any], converted: dict[str, Any]) -> None:
    converted["properties"] = {
        name: to_native_output_schema(property_schema)
        for name, property_schema in remaining.pop("properties", {}).items()
    }
    remaining.pop("additionalProperties", None)
    converted["additionalProperties"] = False
    if (required := remaining.pop("required", None)) is not None:
        converted["required"] = required


def _convert_string(remaining: dict[str, Any], converted: dict[str, Any]) -> None:
    string_format = remaining.pop("format", None)
    if string_format in _SUPPORTED_STRING_FORMATS:
        converted["format"] = string_format
    elif string_format:
        remaining["format"] = string_format


def _convert_array(remaining: dict[str, Any], converted: dict[str, Any]) -> None:
    if (items := remaining.pop("items", None)) is not None:
        converted["items"] = to_native_output_schema(items)
    min_items = remaining.pop("minItems", None)
    if min_items in (0, 1):
        converted["minItems"] = min_items
    elif min_items is not None:
        remaining["minItems"] = min_items
