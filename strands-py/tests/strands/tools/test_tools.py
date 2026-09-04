import pytest

import strands
from strands.tools.tools import (
    InvalidToolUseNameException,
    PythonAgentTool,
    normalize_schema,
    normalize_tool_spec,
    validate_tool_use,
    validate_tool_use_name,
)
from strands.types._events import ToolResultEvent
from strands.types.tools import ToolUse


@pytest.fixture(scope="module")
def identity_invoke():
    def identity(tool_use, a):
        return tool_use, a

    return identity


@pytest.fixture(scope="module")
def identity_invoke_async():
    async def identity(tool_use, a):
        return tool_use, a

    return identity


@pytest.fixture
def identity_tool(request):
    identity = request.getfixturevalue(request.param)

    return PythonAgentTool(
        tool_name="identity",
        tool_spec={
            "name": "identity",
            "description": "identity",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "a": {
                        "type": "integer",
                    },
                },
            },
        },
        tool_func=identity,
    )


def test_validate_tool_use_name_valid():
    tool1 = {"name": "valid_tool_name", "toolUseId": "123"}
    # Should not raise an exception
    validate_tool_use_name(tool1)

    tool2 = {"name": "valid-name", "toolUseId": "123"}
    # Should not raise an exception
    validate_tool_use_name(tool2)

    tool3 = {"name": "34234_numbers", "toolUseId": "123"}
    # Should not raise an exception
    validate_tool_use_name(tool3)


def test_validate_tool_use_name_missing():
    tool = {"toolUseId": "123"}
    with pytest.raises(InvalidToolUseNameException, match="tool name missing"):
        validate_tool_use_name(tool)


def test_validate_tool_use_name_invalid_pattern():
    tool = {"name": "+123_invalid", "toolUseId": "123"}
    with pytest.raises(InvalidToolUseNameException, match="invalid tool name pattern"):
        validate_tool_use_name(tool)


def test_validate_tool_use_name_too_long():
    tool = {"name": "a" * 65, "toolUseId": "123"}
    with pytest.raises(InvalidToolUseNameException, match="invalid tool name length"):
        validate_tool_use_name(tool)


def test_validate_tool_use():
    tool = {"name": "valid_tool_name", "toolUseId": "123"}
    # Should not raise an exception
    validate_tool_use(tool)


def test_normalize_schema_basic():
    schema = {"type": "object"}
    normalized = normalize_schema(schema)

    expected = {"type": "object", "properties": {}, "required": []}

    assert normalized == expected


def test_normalize_schema_with_properties():
    schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "User name"},
            "age": {"type": "integer", "description": "User age"},
        },
    }
    normalized = normalize_schema(schema)

    expected = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "User name"},
            "age": {"type": "integer", "description": "User age"},
        },
        "required": [],
    }

    assert normalized == expected


def test_normalize_schema_with_property_removed():
    schema = {
        "type": "object",
        "properties": {"name": "invalid"},
    }
    normalized = normalize_schema(schema)

    expected = {
        "type": "object",
        "properties": {"name": {"type": "string", "description": "Property name"}},
        "required": [],
    }

    assert normalized == expected


def test_normalize_schema_with_property_defaults():
    schema = {"properties": {"name": {}}}
    normalized = normalize_schema(schema)

    expected = {
        "type": "object",
        "properties": {"name": {"type": "string", "description": "Property name"}},
        "required": [],
    }

    assert normalized == expected


def test_normalize_schema_with_property_enum():
    schema = {"properties": {"color": {"type": "string", "description": "color", "enum": ["red", "green", "blue"]}}}
    normalized = normalize_schema(schema)

    expected = {
        "type": "object",
        "properties": {"color": {"type": "string", "description": "color", "enum": ["red", "green", "blue"]}},
        "required": [],
    }

    assert normalized == expected


def test_normalize_schema_with_property_numeric_constraints():
    schema = {
        "properties": {
            "age": {"type": "integer", "description": "age", "minimum": 0, "maximum": 120},
            "score": {"type": "number", "description": "score", "minimum": 0.0, "maximum": 100.0},
        }
    }
    normalized = normalize_schema(schema)

    expected = {
        "type": "object",
        "properties": {
            "age": {"type": "integer", "description": "age", "minimum": 0, "maximum": 120},
            "score": {"type": "number", "description": "score", "minimum": 0.0, "maximum": 100.0},
        },
        "required": [],
    }

    assert normalized == expected


def test_normalize_schema_with_required():
    schema = {"type": "object", "required": ["name", "email"]}
    normalized = normalize_schema(schema)

    expected = {"type": "object", "properties": {}, "required": ["name", "email"]}

    assert normalized == expected


def test_normalize_schema_with_nested_object():
    """Test normalization of schemas with nested objects."""
    schema = {
        "type": "object",
        "properties": {
            "user": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "User name"},
                    "age": {"type": "integer", "description": "User age"},
                },
                "required": ["name"],
            }
        },
        "required": ["user"],
    }

    normalized = normalize_schema(schema)

    expected = {
        "type": "object",
        "properties": {
            "user": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "User name"},
                    "age": {"type": "integer", "description": "User age"},
                },
                "required": ["name"],
            }
        },
        "required": ["user"],
    }

    assert normalized == expected


def test_normalize_schema_with_deeply_nested_objects():
    """Test normalization of deeply nested object structures."""
    schema = {
        "type": "object",
        "properties": {
            "level1": {
                "type": "object",
                "properties": {
                    "level2": {
                        "type": "object",
                        "properties": {
                            "level3": {"type": "object", "properties": {"value": {"type": "string", "const": "fixed"}}}
                        },
                    }
                },
            }
        },
    }

    normalized = normalize_schema(schema)

    expected = {
        "type": "object",
        "properties": {
            "level1": {
                "type": "object",
                "properties": {
                    "level2": {
                        "type": "object",
                        "properties": {
                            "level3": {
                                "type": "object",
                                "properties": {
                                    "value": {"type": "string", "description": "Property value", "const": "fixed"}
                                },
                                "required": [],
                            }
                        },
                        "required": [],
                    }
                },
                "required": [],
            }
        },
        "required": [],
    }

    assert normalized == expected


def _build_nested_schema(depth):
    """Build a schema nested `depth` levels deep via chained object properties."""
    schema = {"type": "object", "properties": {"value": {"type": "string"}}}
    for _ in range(depth):
        schema = {"type": "object", "properties": {"child": schema}}
    return schema


def test_normalize_schema_raises_value_error_when_too_deeply_nested():
    """A pathologically deep schema raises ValueError rather than RecursionError."""
    schema = _build_nested_schema(100)

    with pytest.raises(ValueError, match="nesting exceeds"):
        normalize_schema(schema)


def test_normalize_tool_spec_raises_value_error_when_too_deeply_nested():
    """normalize_tool_spec surfaces the depth bound as ValueError, not RecursionError."""
    tool_spec = {
        "name": "deep_tool",
        "description": "tool with a hostile inputSchema",
        "inputSchema": {"json": _build_nested_schema(100)},
    }

    with pytest.raises(ValueError, match="nesting exceeds"):
        normalize_tool_spec(tool_spec)


def test_normalize_schema_with_const_constraint():
    """Test that const constraints are preserved."""
    schema = {
        "type": "object",
        "properties": {
            "status": {"type": "string", "const": "ACTIVE"},
            "config": {"type": "object", "properties": {"mode": {"type": "string", "const": "PRODUCTION"}}},
        },
    }

    normalized = normalize_schema(schema)

    expected = {
        "type": "object",
        "properties": {
            "status": {"type": "string", "description": "Property status", "const": "ACTIVE"},
            "config": {
                "type": "object",
                "properties": {"mode": {"type": "string", "description": "Property mode", "const": "PRODUCTION"}},
                "required": [],
            },
        },
        "required": [],
    }

    assert normalized == expected


def test_normalize_schema_with_additional_properties():
    """Test that additionalProperties constraint is preserved."""
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "data": {"type": "object", "properties": {"id": {"type": "string"}}, "additionalProperties": False}
        },
    }

    normalized = normalize_schema(schema)

    expected = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "data": {
                "type": "object",
                "additionalProperties": False,
                "properties": {"id": {"type": "string", "description": "Property id"}},
                "required": [],
            }
        },
        "required": [],
    }

    assert normalized == expected


def test_normalize_tool_spec_with_json_schema():
    tool_spec = {
        "name": "test_tool",
        "description": "A test tool",
        "inputSchema": {"json": {"type": "object", "properties": {"query": {}}, "required": ["query"]}},
    }
    normalized = normalize_tool_spec(tool_spec)

    expected = {
        "name": "test_tool",
        "description": "A test tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "Property query"}},
                "required": ["query"],
            }
        },
    }

    assert normalized == expected


def test_normalize_tool_spec_with_direct_schema():
    tool_spec = {
        "name": "test_tool",
        "description": "A test tool",
        "inputSchema": {"type": "object", "properties": {"query": {}}, "required": ["query"]},
    }
    normalized = normalize_tool_spec(tool_spec)

    expected = {
        "name": "test_tool",
        "description": "A test tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "Property query"}},
                "required": ["query"],
            }
        },
    }

    assert normalized == expected


def test_normalize_tool_spec_without_input_schema():
    tool_spec = {"name": "test_tool", "description": "A test tool"}
    normalized = normalize_tool_spec(tool_spec)

    expected = {"name": "test_tool", "description": "A test tool"}

    assert normalized == expected


def test_normalize_tool_spec_empty_input_schema():
    tool_spec = {
        "name": "test_tool",
        "description": "A test tool",
        "inputSchema": "",
    }
    normalized = normalize_tool_spec(tool_spec)

    expected = {"name": "test_tool", "description": "A test tool", "inputSchema": ""}

    assert normalized == expected


def test_normalize_schema_does_not_mutate_caller_schema():
    """normalize_schema must not write into the schema dict the caller passed in (#3910)."""
    schema = {"type": "object", "properties": {"name": {}}}
    original = {"type": "object", "properties": {"name": {}}}

    normalize_schema(schema)

    assert schema == original


def test_normalize_schema_does_not_mutate_nested_object_properties():
    """The recursive object-schema path must not mutate the caller's nested property dict either."""
    schema = {
        "type": "object",
        "properties": {"data": {"type": "object", "properties": {"id": {}}}},
    }
    original = {
        "type": "object",
        "properties": {"data": {"type": "object", "properties": {"id": {}}}},
    }

    normalize_schema(schema)

    assert schema == original


def test_normalize_tool_spec_does_not_mutate_caller_tool_spec():
    """normalize_tool_spec must not write into the tool_spec dict the caller passed in (#3910)."""
    tool_spec = {
        "name": "demo",
        "description": "demo",
        "inputSchema": {"json": {"type": "object", "properties": {"query": {}}}},
    }
    original = {
        "name": "demo",
        "description": "demo",
        "inputSchema": {"json": {"type": "object", "properties": {"query": {}}}},
    }

    normalize_tool_spec(tool_spec)

    assert tool_spec == original


def test_normalize_tool_spec_direct_schema_does_not_mutate_caller_tool_spec():
    """Same guarantee on the "direct schema" (no "json" key yet) branch."""
    tool_spec = {
        "name": "demo",
        "description": "demo",
        "inputSchema": {"type": "object", "properties": {"query": {}}},
    }
    original = {
        "name": "demo",
        "description": "demo",
        "inputSchema": {"type": "object", "properties": {"query": {}}},
    }

    normalize_tool_spec(tool_spec)

    assert tool_spec == original


def test_validate_tool_use_with_valid_input():
    tool_use: ToolUse = {
        "name": "valid",
        "toolUseId": "123",
        "input": {},
    }
    strands.tools.tools.validate_tool_use(tool_use)


@pytest.mark.parametrize(
    ("tool_use", "expected_error"),
    [
        # Name - Invalid characters
        (
            {
                "name": "+1-invalid",
                "toolUseId": "123",
                "input": {},
            },
            strands.tools.InvalidToolUseNameException,
        ),
        # Name - Exceeds max length
        (
            {
                "name": "a" * 65,
                "toolUseId": "123",
                "input": {},
            },
            strands.tools.InvalidToolUseNameException,
        ),
        # Name - Empty
        (
            {
                "name": "",
                "toolUseId": "123",
                "input": {},
            },
            strands.tools.InvalidToolUseNameException,
        ),
    ],
)
def test_validate_tool_use_invalid(tool_use, expected_error):
    with pytest.raises(expected_error):
        strands.tools.tools.validate_tool_use(tool_use)


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
def test_tool_name(identity_tool):
    tru_name = identity_tool.tool_name
    exp_name = "identity"

    assert tru_name == exp_name


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
def test_tool_spec(identity_tool):
    tru_spec = identity_tool.tool_spec
    exp_spec = {
        "name": "identity",
        "description": "identity",
        "inputSchema": {
            "type": "object",
            "properties": {
                "a": {
                    "type": "integer",
                },
            },
        },
    }

    assert tru_spec == exp_spec


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
def test_tool_type(identity_tool):
    tru_type = identity_tool.tool_type
    exp_type = "python"

    assert tru_type == exp_type


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
def test_supports_hot_reload(identity_tool):
    assert identity_tool.supports_hot_reload


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
def test_get_display_properties(identity_tool):
    tru_properties = identity_tool.get_display_properties()
    exp_properties = {
        "Name": "identity",
        "Type": "python",
    }

    assert tru_properties == exp_properties


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
@pytest.mark.asyncio
async def test_stream(identity_tool, alist):
    stream = identity_tool.stream({"tool_use": 1}, {"a": 2})

    tru_events = await alist(stream)
    exp_events = [ToolResultEvent(({"tool_use": 1}, 2))]
    assert tru_events == exp_events


def test_normalize_schema_with_anyof():
    """Test that anyOf properties don't get default type."""
    schema = {
        "type": "object",
        "properties": {
            "optional_field": {"anyOf": [{"items": {"type": "string"}, "type": "array"}, {"type": "null"}]},
            "regular_field": {},
        },
    }
    normalized = normalize_schema(schema)

    assert "type" not in normalized["properties"]["optional_field"]
    assert normalized["properties"]["regular_field"]["type"] == "string"
