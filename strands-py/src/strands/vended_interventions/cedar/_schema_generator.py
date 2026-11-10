"""Adapter for cedar-policy-mcp-schema-generator package."""

from __future__ import annotations

import re
from typing import Any, cast

from typing_extensions import Required, TypedDict

DEFAULT_STUB = """
namespace Agent {
  @mcp_principal
  entity User;
  @mcp_resource
  entity Resource;
  @mcp_context("session")
  type SessionContext = {
    hour_utc: Long,
    call_count: Long
  };
}
"""


class ToolDefinition(TypedDict, total=False):
    """Minimal tool definition for schema generation (MCP-compatible format)."""

    name: Required[str]
    inputSchema: dict[str, Any]
    description: str


def generate_cedar_schema(tools: list[ToolDefinition]) -> str:
    """Generate a Cedar schema from tool definitions using cedar-policy-mcp-schema-generator.

    Args:
        tools: List of MCP-format tool definitions.

    Returns:
        Cedar schema text with namespace wrapper stripped.

    Raises:
        ImportError: If cedar-policy-mcp-schema-generator is not installed.
        RuntimeError: If schema generation fails.
    """
    try:
        from cedar_mcp_schema_generator import SchemaGeneratorError, generate_schema_or_raise
    except ImportError as e:
        raise ImportError(
            "cedar-policy-mcp-schema-generator is required for auto schema generation. "
            "Install it with: pip install cedar-policy-mcp-schema-generator"
        ) from e

    try:
        result = generate_schema_or_raise(
            DEFAULT_STUB, cast(list[dict[str, Any]], tools), config={"flattenNamespaces": True}
        )
    except SchemaGeneratorError as e:
        raise RuntimeError(f"Schema generation failed: {e}") from e

    schema = result["schema"]
    if not schema:
        raise RuntimeError("Schema generation returned empty schema")

    # The generator wraps output in "namespace Agent { ... }" with prefixed types (Agent::User).
    # Cedar evaluation uses a flat schema, so strip the wrapper and namespace prefixes.
    ns_match = re.match(r"^namespace\s+(\w+)\s*\{", schema)
    ns = ns_match.group(1) if ns_match else "Agent"

    stripped = re.sub(r"^namespace\s+\w+\s*\{", "", schema)
    stripped = re.sub(r"\}\s*$", "", stripped)
    stripped = stripped.replace(f"{ns}::", "")

    return stripped
