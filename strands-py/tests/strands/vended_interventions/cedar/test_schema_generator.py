"""Tests for the Cedar schema generator adapter."""

import pytest

from strands.vended_interventions.cedar._schema_generator import generate_cedar_schema

try:
    from cedar_mcp_schema_generator import generate_schema_or_raise  # noqa: F401

    HAS_SCHEMA_GENERATOR = True
except ImportError:
    HAS_SCHEMA_GENERATOR = False

pytestmark = pytest.mark.skipif(not HAS_SCHEMA_GENERATOR, reason="cedar-policy-mcp-schema-generator not installed")


class TestSchemaGeneration:
    def test_basic_tool_generates_schema(self):
        tools = [
            {
                "name": "search",
                "inputSchema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            }
        ]
        schema = generate_cedar_schema(tools)
        assert "search" in schema
        assert "namespace" not in schema

    def test_multiple_tools(self):
        tools = [
            {
                "name": "search",
                "inputSchema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                },
            },
            {
                "name": "delete",
                "inputSchema": {
                    "type": "object",
                    "properties": {"id": {"type": "integer"}},
                },
            },
        ]
        schema = generate_cedar_schema(tools)
        assert "search" in schema
        assert "delete" in schema

    def test_empty_tools_list(self):
        schema = generate_cedar_schema([])
        assert schema is not None

    def test_tool_with_empty_input_schema(self):
        tools = [{"name": "ping", "inputSchema": {"type": "object", "properties": {}}}]
        schema = generate_cedar_schema(tools)
        assert "ping" in schema

    def test_namespace_prefix_stripped(self):
        tools = [
            {
                "name": "test_tool",
                "inputSchema": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                },
            }
        ]
        schema = generate_cedar_schema(tools)
        assert "Agent::" not in schema
