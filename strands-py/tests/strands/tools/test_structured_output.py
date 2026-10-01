from typing import Any, Literal

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from pydantic import BaseModel, Field
from pydantic.json_schema import GenerateJsonSchema, JsonSchemaMode

from strands.tools.structured_output import convert_pydantic_to_tool_spec
from strands.types.tools import ToolSpec


class User(BaseModel):
    """User model with name and age."""

    name: str = Field(description="The name of the user")
    age: int = Field(description="The age of the user", ge=18, le=100)


class Address(BaseModel):
    """A postal address."""

    city: str
    postal_code: str | None = None


class Person(BaseModel):
    """Complete person information."""

    name: str
    addresses: tuple[Address, ...]


class Node(BaseModel):
    """A node in a recursive tree."""

    name: str
    children: list["Node"] = Field(default_factory=list)


def test_convert_pydantic_to_tool_spec_basic():
    tru_spec = convert_pydantic_to_tool_spec(User)
    exp_spec = {
        "name": "User",
        "description": "User model with name and age.",
        "inputSchema": {
            "json": {
                "properties": {
                    "name": {"description": "The name of the user", "title": "Name", "type": "string"},
                    "age": {
                        "description": "The age of the user",
                        "maximum": 100,
                        "minimum": 18,
                        "title": "Age",
                        "type": "integer",
                    },
                },
                "required": ["name", "age"],
                "title": "User",
                "description": "User model with name and age.",
                "type": "object",
            }
        },
    }

    assert tru_spec == exp_spec
    assert ToolSpec(**tru_spec) == exp_spec


def test_convert_pydantic_to_tool_spec_preserves_nested_definitions():
    tru_spec = convert_pydantic_to_tool_spec(Person)
    exp_spec = {
        "name": "Person",
        "description": "Complete person information.",
        "inputSchema": {"json": Person.model_json_schema()},
    }

    assert tru_spec == exp_spec
    Draft202012Validator.check_schema(tru_spec["inputSchema"]["json"])


# Preserves nullable enum semantics through structured output conversion (#3590).
def test_convert_pydantic_to_tool_spec_preserves_nullable_enum():
    class FeedbackFilter(BaseModel):
        sentiment: Literal["positive", "negative"] | None

    tru_spec = convert_pydantic_to_tool_spec(FeedbackFilter)
    exp_spec = {
        "name": "FeedbackFilter",
        "description": "FeedbackFilter structured output tool",
        "inputSchema": {"json": FeedbackFilter.model_json_schema()},
    }

    assert tru_spec == exp_spec
    validator = Draft202012Validator(tru_spec["inputSchema"]["json"])
    validator.validate({"sentiment": "negative"})
    validator.validate({"sentiment": None})


# Treats a custom Pydantic schema as authoritative instead of reconstructing nested fields (#3590).
def test_convert_pydantic_to_tool_spec_preserves_custom_model_schema():
    custom_schema = {
        "type": "object",
        "properties": {
            "addresses": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            }
        },
        "required": ["addresses"],
    }

    class CustomPerson(Person):
        @classmethod
        def model_json_schema(
            cls,
            by_alias: bool = True,
            ref_template: str = "#/$defs/{model}",
            schema_generator: type[GenerateJsonSchema] = GenerateJsonSchema,
            mode: JsonSchemaMode = "validation",
            *,
            union_format: Literal["any_of", "primitive_type_array"] = "any_of",
        ) -> dict[str, Any]:
            del cls, by_alias, ref_template, schema_generator, mode, union_format
            return custom_schema

    tru_schema = convert_pydantic_to_tool_spec(CustomPerson)["inputSchema"]["json"]

    assert tru_schema == custom_schema


def test_convert_pydantic_to_tool_spec_keeps_default_fields_non_nullable():
    class Family(BaseModel):
        names: list[str] = Field(default_factory=list)

    tru_schema = convert_pydantic_to_tool_spec(Family)["inputSchema"]["json"]
    exp_schema = Family.model_json_schema()

    assert tru_schema == exp_schema
    validator = Draft202012Validator(tru_schema)
    validator.validate({})
    with pytest.raises(ValidationError):
        validator.validate({"names": None})


def test_convert_pydantic_to_tool_spec_inlines_recursive_root_reference():
    native_schema = Node.model_json_schema()
    tru_schema = convert_pydantic_to_tool_spec(Node)["inputSchema"]["json"]
    exp_schema = {
        **native_schema["$defs"]["Node"],
        "$defs": native_schema["$defs"],
    }

    assert tru_schema == exp_schema
    Draft202012Validator.check_schema(tru_schema)
    Draft202012Validator(tru_schema).validate({"name": "root", "children": [{"name": "child", "children": []}]})


@pytest.mark.parametrize(
    ("schema", "message"),
    [
        ({"$ref": "https://example.com/schema"}, "Unsupported top-level JSON Schema reference"),
        ({"$ref": "#/$defs/Missing", "$defs": {}}, "Missing top-level JSON Schema definition"),
    ],
)
def test_convert_pydantic_to_tool_spec_rejects_unresolvable_root_reference(
    schema: dict[str, Any],
    message: str,
):
    class ReferencedModel(BaseModel):
        @classmethod
        def model_json_schema(
            cls,
            by_alias: bool = True,
            ref_template: str = "#/$defs/{model}",
            schema_generator: type[GenerateJsonSchema] = GenerateJsonSchema,
            mode: JsonSchemaMode = "validation",
            *,
            union_format: Literal["any_of", "primitive_type_array"] = "any_of",
        ) -> dict[str, Any]:
            del cls, by_alias, ref_template, schema_generator, mode, union_format
            return schema

    with pytest.raises(ValueError, match=message):
        convert_pydantic_to_tool_spec(ReferencedModel)


def test_convert_pydantic_to_tool_spec_custom_description():
    tru_description = convert_pydantic_to_tool_spec(User, description="Custom tool description")["description"]

    assert tru_description == "Custom tool description"


def test_convert_pydantic_to_tool_spec_empty_docstring():
    class EmptyDocUser(BaseModel):
        name: str

    tru_description = convert_pydantic_to_tool_spec(EmptyDocUser)["description"]

    assert tru_description == "EmptyDocUser structured output tool"
