from strands.models._strict_schema import ensure_strict_json_schema


def test_basic_object():
    schema = {
        "type": "object",
        "properties": {"x": {"type": "string"}},
    }
    result = ensure_strict_json_schema(schema)

    assert result == {
        "type": "object",
        "properties": {"x": {"type": "string"}},
        "additionalProperties": False,
    }
    assert "additionalProperties" not in schema


def test_nested_objects():
    schema = {
        "type": "object",
        "properties": {
            "outer": {
                "type": "object",
                "properties": {"inner": {"type": "integer"}},
            }
        },
    }
    result = ensure_strict_json_schema(schema)

    assert result == {
        "type": "object",
        "properties": {
            "outer": {
                "type": "object",
                "properties": {"inner": {"type": "integer"}},
                "additionalProperties": False,
            }
        },
        "additionalProperties": False,
    }


def test_defs():
    schema = {
        "type": "object",
        "properties": {"item": {"$ref": "#/$defs/MyItem"}},
        "$defs": {
            "MyItem": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
            }
        },
    }
    result = ensure_strict_json_schema(schema)

    assert result["additionalProperties"] is False
    assert result["$defs"]["MyItem"] == {
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "additionalProperties": False,
    }


def test_definitions():
    schema = {
        "type": "object",
        "properties": {"item": {"$ref": "#/definitions/MyItem"}},
        "definitions": {
            "MyItem": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
            }
        },
    }
    result = ensure_strict_json_schema(schema)

    assert result["additionalProperties"] is False
    assert result["definitions"]["MyItem"] == {
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "additionalProperties": False,
    }


def test_ref_inline():
    schema = {
        "type": "object",
        "properties": {
            "item": {
                "$ref": "#/$defs/MyItem",
                "description": "An item",
            }
        },
        "$defs": {
            "MyItem": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
            }
        },
    }
    result = ensure_strict_json_schema(schema)

    assert result["properties"]["item"] == {
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "description": "An item",
        "additionalProperties": False,
    }


def test_ref_inline_uses_deep_copy():
    """Two properties referencing the same $def get independent copies."""
    schema = {
        "type": "object",
        "properties": {
            "a": {"$ref": "#/$defs/Shared", "description": "first"},
            "b": {"$ref": "#/$defs/Shared", "description": "second"},
        },
        "$defs": {
            "Shared": {
                "type": "object",
                "properties": {"val": {"type": "string"}},
            }
        },
    }
    result = ensure_strict_json_schema(schema)

    assert result["properties"]["a"]["description"] == "first"
    assert result["properties"]["b"]["description"] == "second"
    assert result["properties"]["a"] is not result["properties"]["b"]


def test_arrays_anyof_allof():
    schema = {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {"type": "object", "properties": {"a": {"type": "string"}}},
            },
            "union": {
                "anyOf": [
                    {"type": "object", "properties": {"b": {"type": "string"}}},
                    {"type": "null"},
                ]
            },
            "intersection": {
                "allOf": [
                    {"type": "object", "properties": {"c": {"type": "string"}}},
                ]
            },
        },
    }
    result = ensure_strict_json_schema(schema)

    assert result == {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"a": {"type": "string"}},
                    "additionalProperties": False,
                },
            },
            "union": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {"b": {"type": "string"}},
                        "additionalProperties": False,
                    },
                    {"type": "null"},
                ]
            },
            "intersection": {
                "allOf": [
                    {
                        "type": "object",
                        "properties": {"c": {"type": "string"}},
                        "additionalProperties": False,
                    },
                ]
            },
        },
        "additionalProperties": False,
    }


def test_oneof():
    schema = {
        "type": "object",
        "properties": {
            "value": {
                "oneOf": [
                    {"type": "object", "properties": {"a": {"type": "string"}}},
                    {"type": "object", "properties": {"b": {"type": "integer"}}},
                ]
            }
        },
    }
    result = ensure_strict_json_schema(schema)

    assert result == {
        "type": "object",
        "properties": {
            "value": {
                "oneOf": [
                    {"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": False},
                    {"type": "object", "properties": {"b": {"type": "integer"}}, "additionalProperties": False},
                ]
            }
        },
        "additionalProperties": False,
    }


def test_require_all_properties():
    schema = {
        "type": "object",
        "properties": {
            "required_field": {"type": "string"},
            "optional_field": {"type": "string"},
        },
        "required": ["required_field"],
    }

    without = ensure_strict_json_schema(schema)
    assert without["required"] == ["required_field"]

    with_all = ensure_strict_json_schema(schema, require_all_properties=True)
    assert set(with_all["required"]) == {"required_field", "optional_field"}


def test_preserves_additional_properties_true():
    schema = {
        "type": "object",
        "properties": {"x": {"type": "string"}},
        "additionalProperties": True,
    }
    result = ensure_strict_json_schema(schema)

    assert result == {
        "type": "object",
        "properties": {"x": {"type": "string"}},
        "additionalProperties": True,
    }


def test_preserves_additional_properties_false():
    schema = {
        "type": "object",
        "properties": {"x": {"type": "string"}},
        "additionalProperties": False,
    }
    result = ensure_strict_json_schema(schema)

    assert result == {
        "type": "object",
        "properties": {"x": {"type": "string"}},
        "additionalProperties": False,
    }


def test_non_object_type_unchanged():
    schema = {"type": "string"}
    result = ensure_strict_json_schema(schema)

    assert result == {"type": "string"}


def test_ref_with_invalid_format_is_ignored():
    """A $ref that doesn't start with #/ is silently skipped."""
    schema = {
        "type": "object",
        "properties": {
            "item": {"$ref": "external.json#/Foo", "description": "ext"},
        },
    }
    result = ensure_strict_json_schema(schema)

    # $ref is not resolved, but additionalProperties is still added to root
    assert result["additionalProperties"] is False
    assert result["properties"]["item"]["$ref"] == "external.json#/Foo"


def test_recursive_ref_with_sibling_keys_terminates(caplog):
    """A recursive $ref with sibling keys is left unresolved at the cycle point instead of recursing forever (#5042)."""
    schema = {
        "type": "object",
        "properties": {"n": {"$ref": "#/$defs/Node", "description": "d"}},
        "$defs": {
            "Node": {
                "type": "object",
                "properties": {"child": {"$ref": "#/$defs/Node", "description": "c"}},
            }
        },
    }
    with caplog.at_level("WARNING", logger="strands.models._strict_schema"):
        result = ensure_strict_json_schema(schema)

    inlined_child = {
        "type": "object",
        "properties": {"child": {"$ref": "#/$defs/Node", "description": "c"}},
        "additionalProperties": False,
        "description": "c",
    }
    assert result == {
        "type": "object",
        "properties": {
            "n": {
                "type": "object",
                "properties": {"child": inlined_child},
                "additionalProperties": False,
                "description": "d",
            }
        },
        "$defs": {"Node": {"type": "object", "properties": {"child": inlined_child}, "additionalProperties": False}},
        "additionalProperties": False,
    }
    assert "recursive $ref cannot be inlined" in caplog.text


def test_union_type_including_object_is_closed():
    """An object in a union type (e.g. Optional[Model]) still gets additionalProperties: false (#5042)."""
    schema = {"type": ["object", "null"], "properties": {"a": {"type": "string"}}}
    result = ensure_strict_json_schema(schema)

    assert result == {
        "type": ["object", "null"],
        "properties": {"a": {"type": "string"}},
        "additionalProperties": False,
    }


def test_schema_valued_additional_properties_is_closed():
    """Objects nested under a schema-valued additionalProperties are recursed into (#5042)."""
    schema = {
        "type": "object",
        "additionalProperties": {"type": "object", "properties": {"x": {"type": "string"}}},
    }
    result = ensure_strict_json_schema(schema)

    assert result == {
        "type": "object",
        "additionalProperties": {
            "type": "object",
            "properties": {"x": {"type": "string"}},
            "additionalProperties": False,
        },
    }


def test_ref_target_additional_properties_is_preserved():
    """Inlining a $ref keeps the target's own additionalProperties instead of overwriting it with false (#5042)."""
    schema = {
        "type": "object",
        "properties": {"m": {"$ref": "#/$defs/M", "type": "object", "description": "d"}},
        "$defs": {"M": {"type": "object", "additionalProperties": {"type": "string"}}},
    }
    result = ensure_strict_json_schema(schema)

    assert result == {
        "type": "object",
        "properties": {
            "m": {"type": "object", "additionalProperties": {"type": "string"}, "description": "d"},
        },
        "$defs": {"M": {"type": "object", "additionalProperties": {"type": "string"}}},
        "additionalProperties": False,
    }


def test_ref_with_missing_path_is_ignored():
    """A $ref pointing to a non-existent path is silently skipped."""
    schema = {
        "type": "object",
        "properties": {
            "item": {"$ref": "#/$defs/Missing", "description": "gone"},
        },
        "$defs": {},
    }
    result = ensure_strict_json_schema(schema)

    assert result["additionalProperties"] is False
    # $ref stays because resolution failed
    assert "$ref" in result["properties"]["item"]
