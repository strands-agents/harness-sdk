from enum import Enum
from typing import Any, Literal, Optional

import pytest
from pydantic import BaseModel, Field

from strands.tools.structured_output import convert_pydantic_to_tool_spec
from strands.types.tools import ToolSpec


# Basic test model
class User(BaseModel):
    """User model with name and age."""

    name: str = Field(description="The name of the user")
    age: int = Field(description="The age of the user", ge=18, le=100)


# Test model with inheritance and literals
class UserWithPlanet(User):
    """User with planet."""

    planet: Literal["Earth", "Mars"] = Field(description="The planet")


# Test model with multiple same type fields and optional field
class TwoUsersWithPlanet(BaseModel):
    """Two users model with planet."""

    user1: UserWithPlanet = Field(description="The first user")
    user2: UserWithPlanet | None = Field(description="The second user", default=None)


# Test model with list of same type fields
class ListOfUsersWithPlanet(BaseModel):
    """List of users model with planet."""

    users: list[UserWithPlanet] = Field(description="The users", min_length=2, max_length=3)


def test_convert_pydantic_to_tool_spec_basic():
    tool_spec = convert_pydantic_to_tool_spec(User)

    expected_spec = {
        "name": "User",
        "description": "User model with name and age.",
        "inputSchema": {
            "json": {
                "type": "object",
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
                "title": "User",
                "description": "User model with name and age.",
                "required": ["name", "age"],
            }
        },
    }

    # Verify we can construct a valid ToolSpec
    tool_spec_obj = ToolSpec(**tool_spec)
    assert tool_spec_obj is not None
    assert tool_spec == expected_spec


def test_convert_pydantic_to_tool_spec_complex():
    tool_spec = convert_pydantic_to_tool_spec(ListOfUsersWithPlanet)

    expected_spec = {
        "name": "ListOfUsersWithPlanet",
        "description": "List of users model with planet.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "users": {
                        "description": "The users",
                        "items": {
                            "description": "User with planet.",
                            "title": "UserWithPlanet",
                            "type": "object",
                            "properties": {
                                "name": {"description": "The name of the user", "title": "Name", "type": "string"},
                                "age": {
                                    "description": "The age of the user",
                                    "maximum": 100,
                                    "minimum": 18,
                                    "title": "Age",
                                    "type": "integer",
                                },
                                "planet": {
                                    "description": "The planet",
                                    "enum": ["Earth", "Mars"],
                                    "title": "Planet",
                                    "type": "string",
                                },
                            },
                            "required": ["name", "age", "planet"],
                        },
                        "maxItems": 3,
                        "minItems": 2,
                        "title": "Users",
                        "type": "array",
                    }
                },
                "title": "ListOfUsersWithPlanet",
                "description": "List of users model with planet.",
                "required": ["users"],
            }
        },
    }

    assert tool_spec == expected_spec

    # Verify we can construct a valid ToolSpec
    tool_spec_obj = ToolSpec(**tool_spec)
    assert tool_spec_obj is not None


def test_convert_pydantic_to_tool_spec_multiple_same_type():
    tool_spec = convert_pydantic_to_tool_spec(TwoUsersWithPlanet)

    expected_spec = {
        "name": "TwoUsersWithPlanet",
        "description": "Two users model with planet.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "user1": {
                        "type": "object",
                        "description": "The first user",
                        "properties": {
                            "name": {"description": "The name of the user", "title": "Name", "type": "string"},
                            "age": {
                                "description": "The age of the user",
                                "maximum": 100,
                                "minimum": 18,
                                "title": "Age",
                                "type": "integer",
                            },
                            "planet": {
                                "description": "The planet",
                                "enum": ["Earth", "Mars"],
                                "title": "Planet",
                                "type": "string",
                            },
                        },
                        "required": ["name", "age", "planet"],
                    },
                    "user2": {
                        "type": ["object", "null"],
                        "description": "The second user",
                        "title": "UserWithPlanet",
                        "properties": {
                            "name": {"description": "The name of the user", "title": "Name", "type": "string"},
                            "age": {
                                "description": "The age of the user",
                                "maximum": 100,
                                "minimum": 18,
                                "title": "Age",
                                "type": "integer",
                            },
                            "planet": {
                                "description": "The planet",
                                "enum": ["Earth", "Mars"],
                                "title": "Planet",
                                "type": "string",
                            },
                        },
                        "required": ["name", "age", "planet"],
                    },
                },
                "title": "TwoUsersWithPlanet",
                "description": "Two users model with planet.",
                "required": ["user1"],
            }
        },
    }

    assert tool_spec == expected_spec

    # Verify we can construct a valid ToolSpec
    tool_spec_obj = ToolSpec(**tool_spec)
    assert tool_spec_obj is not None


def test_convert_pydantic_with_missing_refs():
    """Test that the tool handles missing $refs gracefully."""
    # This test checks that our error handling for missing $refs works correctly
    # by testing with a model that has circular references

    class NodeWithCircularRef(BaseModel):
        """A node with a circular reference to itself."""

        name: str = Field(description="The name of the node")
        parent: Optional["NodeWithCircularRef"] = Field(None, description="Parent node")
        children: list["NodeWithCircularRef"] = Field(default_factory=list, description="Child nodes")

    # This forward reference normally causes issues with schema generation
    # but our error handling should prevent errors
    with pytest.raises(ValueError, match="Circular reference detected and not supported"):
        convert_pydantic_to_tool_spec(NodeWithCircularRef)


def test_convert_pydantic_with_circular_required_dependency():
    """Test that the tool handles circular dependencies gracefully."""

    class NodeWithCircularRef(BaseModel):
        """A node with a circular reference to itself."""

        name: str = Field(description="The name of the node")
        parent: "NodeWithCircularRef"

    with pytest.raises(ValueError, match="Circular reference detected and not supported"):
        convert_pydantic_to_tool_spec(NodeWithCircularRef)


def test_convert_pydantic_with_circular_optional_dependency():
    """Test that the tool handles circular dependencies gracefully."""

    class NodeWithCircularRef(BaseModel):
        """A node with a circular reference to itself."""

        name: str = Field(description="The name of the node")
        parent: Optional["NodeWithCircularRef"] = None

    with pytest.raises(ValueError, match="Circular reference detected and not supported"):
        convert_pydantic_to_tool_spec(NodeWithCircularRef)


def test_convert_pydantic_with_circular_optional_dependenc_not_using_optional_typing():
    """Test that the tool handles circular dependencies gracefully."""

    class NodeWithCircularRef(BaseModel):
        """A node with a circular reference to itself."""

        name: str = Field(description="The name of the node")
        parent: "NodeWithCircularRef" = None

    with pytest.raises(ValueError, match="Circular reference detected and not supported"):
        convert_pydantic_to_tool_spec(NodeWithCircularRef)


def test_conversion_works_with_fields_that_are_not_marked_as_optional_but_have_a_default_value_which_makes_them_optional():  # noqa E501
    class Family(BaseModel):
        ages: list[str] = Field(default_factory=list)
        names: list[str] = Field(default_factory=list)

    converted_output = convert_pydantic_to_tool_spec(Family)
    expected_output = {
        "name": "Family",
        "description": "Family structured output tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "ages": {
                        "items": {"type": "string"},
                        "title": "Ages",
                        "type": ["array", "null"],
                    },
                    "names": {
                        "items": {"type": "string"},
                        "title": "Names",
                        "type": ["array", "null"],
                    },
                },
                "title": "Family",
            }
        },
    }
    assert converted_output == expected_output


def test_marks_fields_as_optional_for_model_w_fields_that_are_not_marked_as_optional_but_have_a_default_value_which_makes_them_optional():  # noqa E501
    class Family(BaseModel):
        ages: list[str] = Field(default_factory=list)
        names: list[str] = Field(default_factory=list)

    converted_output = convert_pydantic_to_tool_spec(Family)
    assert "null" in converted_output["inputSchema"]["json"]["properties"]["ages"]["type"]


def test_convert_pydantic_with_custom_description():
    """Test that custom descriptions override model docstrings."""

    # Test with custom description
    custom_description = "Custom tool description for user model"
    tool_spec = convert_pydantic_to_tool_spec(User, description=custom_description)

    assert tool_spec["description"] == custom_description


def test_convert_pydantic_with_empty_docstring():
    """Test that empty docstrings use default description."""

    class EmptyDocUser(BaseModel):
        name: str = Field(description="The name of the user")

    tool_spec = convert_pydantic_to_tool_spec(EmptyDocUser)
    assert tool_spec["description"] == "EmptyDocUser structured output tool"


def test_convert_pydantic_with_items_refs():
    """Test that no $refs exist after lists of different components."""

    class Address(BaseModel):
        postal_code: str | None = None

    class Person(BaseModel):
        """Complete person information."""

        list_of_items: list[Address]
        list_of_items_nullable: list[Address] | None
        list_of_item_or_nullable: list[Address | None]

    tool_spec = convert_pydantic_to_tool_spec(Person)

    expected_spec = {
        "description": "Complete person information.",
        "inputSchema": {
            "json": {
                "description": "Complete person information.",
                "properties": {
                    "list_of_item_or_nullable": {
                        "items": {
                            "anyOf": [
                                {
                                    "properties": {"postal_code": {"type": ["string", "null"]}},
                                    "title": "Address",
                                    "type": "object",
                                },
                                {"type": "null"},
                            ]
                        },
                        "title": "List Of Item Or Nullable",
                        "type": "array",
                    },
                    "list_of_items": {
                        "items": {
                            "properties": {"postal_code": {"type": ["string", "null"]}},
                            "title": "Address",
                            "type": "object",
                        },
                        "title": "List Of Items",
                        "type": "array",
                    },
                    "list_of_items_nullable": {
                        "items": {
                            "properties": {"postal_code": {"type": ["string", "null"]}},
                            "title": "Address",
                            "type": "object",
                        },
                        "type": ["array", "null"],
                    },
                },
                "required": ["list_of_items", "list_of_item_or_nullable"],
                "title": "Person",
                "type": "object",
            }
        },
        "name": "Person",
    }
    assert tool_spec == expected_spec


def test_convert_pydantic_with_refs():
    """Test that no $refs exist after processing complex hierarchies."""

    class Address(BaseModel):
        street: str
        city: str
        country: str
        postal_code: str | None = None

    class Contact(BaseModel):
        address: Address

    class Person(BaseModel):
        """Complete person information."""

        contact: Contact = Field(description="Contact methods")

    tool_spec = convert_pydantic_to_tool_spec(Person)

    expected_spec = {
        "description": "Complete person information.",
        "inputSchema": {
            "json": {
                "description": "Complete person information.",
                "properties": {
                    "contact": {
                        "description": "Contact methods",
                        "properties": {
                            "address": {
                                "properties": {
                                    "city": {"title": "City", "type": "string"},
                                    "country": {"title": "Country", "type": "string"},
                                    "postal_code": {"type": ["string", "null"]},
                                    "street": {"title": "Street", "type": "string"},
                                },
                                "required": ["street", "city", "country"],
                                "title": "Address",
                                "type": "object",
                            }
                        },
                        "required": ["address"],
                        "type": "object",
                    }
                },
                "required": ["contact"],
                "title": "Person",
                "type": "object",
            }
        },
        "name": "Person",
    }
    assert tool_spec == expected_spec


def test_convert_pydantic_with_nullable_enum():
    """Test that nullable Literal/enum fields preserve anyOf instead of creating invalid type/enum combo."""

    class NullableEnum(BaseModel):
        sentiment: Literal["positive", "negative"] | None
        flag: Literal["x"] | None = None

    tool_spec = convert_pydantic_to_tool_spec(NullableEnum)

    expected_spec = {
        "name": "NullableEnum",
        "description": "NullableEnum structured output tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "sentiment": {
                        "anyOf": [
                            {"enum": ["positive", "negative"], "type": "string"},
                            {"type": "null"},
                        ],
                        "title": "Sentiment",
                    },
                    "flag": {
                        "anyOf": [
                            {"const": "x", "type": "string"},
                            {"type": "null"},
                        ],
                        "default": None,
                        "title": "Flag",
                    },
                },
                "title": "NullableEnum",
                "required": ["sentiment"],
            }
        },
    }

    assert tool_spec == expected_spec

    # Verify we can construct a valid ToolSpec
    tool_spec_obj = ToolSpec(**tool_spec)
    assert tool_spec_obj is not None


def test_convert_pydantic_with_model_json_schema_override():
    """Test that a model_json_schema override returning a dereferenced schema is respected."""

    group_schema = {
        "type": "object",
        "properties": {
            "filters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                },
            }
        },
        "required": ["filters"],
    }

    class Filter(BaseModel):
        name: str

    class FilterGroup(BaseModel):
        filters: tuple[Filter, ...]

    class Scope(BaseModel):
        group: FilterGroup

        @classmethod
        def model_json_schema(cls, *args: Any, **kwargs: Any) -> dict[str, Any]:
            return {
                "type": "object",
                "properties": {"group": group_schema},
                "required": ["group"],
            }

    # Should not raise ValueError: Missing reference: Filter
    tool_spec = convert_pydantic_to_tool_spec(Scope)

    expected_spec = {
        "name": "Scope",
        "description": "Scope structured output tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"group": {**group_schema, "description": ""}},
                "required": ["group"],
            }
        },
    }

    assert tool_spec == expected_spec

    # Verify we can construct a valid ToolSpec
    tool_spec_obj = ToolSpec(**tool_spec)
    assert tool_spec_obj is not None


def test_convert_pydantic_with_nullable_str_enum():
    """Test that nullable str Enum fields (resolved via $ref) preserve anyOf."""

    class Color(str, Enum):
        RED = "red"
        GREEN = "green"
        BLUE = "blue"

    class Palette(BaseModel):
        favorite: Color | None = None

    tool_spec = convert_pydantic_to_tool_spec(Palette)

    expected_spec = {
        "name": "Palette",
        "description": "Palette structured output tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "favorite": {
                        "anyOf": [
                            {"enum": ["red", "green", "blue"], "title": "Color", "type": "string"},
                            {"type": "null"},
                        ],
                        "default": None,
                    }
                },
                "title": "Palette",
            }
        },
    }

    assert tool_spec == expected_spec


def test_convert_pydantic_with_non_nullable_literal_default():
    """Test that a non-nullable Literal with a default does not get null injected into its type."""

    class Config(BaseModel):
        mode: Literal["fast", "slow"] = "fast"
        flag: Literal["on"] = "on"

    tool_spec = convert_pydantic_to_tool_spec(Config)

    expected_spec = {
        "name": "Config",
        "description": "Config structured output tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "mode": {
                        "default": "fast",
                        "enum": ["fast", "slow"],
                        "title": "Mode",
                        "type": "string",
                    },
                    "flag": {
                        "const": "on",
                        "default": "on",
                        "title": "Flag",
                        "type": "string",
                    },
                },
                "title": "Config",
            }
        },
    }

    assert tool_spec == expected_spec
