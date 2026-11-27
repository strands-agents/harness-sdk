"""Tests for the Dogwood action schema generator."""

from unittest.mock import patch

import pytest

from strands.vended_interventions.dogwood import _schema_generator
from strands.vended_interventions.dogwood._schema_generator import (
    GENERATED_NAMESPACE,
    GENERATED_RESOURCE,
    RESOURCE,
    apply_namespace,
    assert_cedar_namespace,
    decimal_parameters,
    generate_action_schema,
    namespace_prefix_of,
    specs_of,
)
from tests.fixtures.mock_agent_tool import MockAgentTool

SEARCH_SPEC = {
    "name": "search",
    "description": "Search the web",
    "inputSchema": {"json": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
}
PING_SPEC = {
    "name": "ping",
    "description": "Check liveness",
    "inputSchema": {"json": {"type": "object", "properties": {}}},
}
TYPED_SPEC = {
    "name": "report",
    "description": "File a report",
    "inputSchema": {
        "json": {
            "type": "object",
            "properties": {
                "amount": {"type": "number"},
                "amounts": {"type": "array", "items": {"type": "number"}},
                "count": {"type": "integer"},
                "label": {"type": "string"},
                "flag": {"type": "boolean"},
                "nested": {"type": "object", "properties": {"inner": {"type": "number"}}},
            },
            "required": ["amount"],
        }
    },
}
ENUM_SPEC = {
    "name": "sort",
    "description": "Sort results",
    "inputSchema": {
        "json": {
            "type": "object",
            "properties": {"order": {"type": "string", "enum": ["asc", "desc"]}},
            "required": ["order"],
        }
    },
}


def _declared_type(schema, name):
    """The attribute lines of a `type <name> = { ... };` declaration, in order."""
    body = schema.split(f"type {name} = {{", 1)[1].split("};", 1)[0]
    return [line.strip().rstrip(",") for line in body.splitlines() if line.strip()]


def test_generate_action_schema_declares_an_action_per_tool():
    schema = generate_action_schema([SEARCH_SPEC, PING_SPEC])
    assert 'action "search"' in schema
    assert 'action "ping"' in schema


def test_generate_action_schema_renames_the_generated_resource_entity():
    schema = generate_action_schema([SEARCH_SPEC])
    assert f"entity {RESOURCE};" in schema
    assert f"entity {GENERATED_RESOURCE};" not in schema
    assert f"resource: [{GENERATED_RESOURCE}]" not in schema


def test_generate_action_schema_makes_input_optional_only_when_every_argument_is():
    schema = generate_action_schema([SEARCH_SPEC, PING_SPEC])
    assert "input?: pingInput" in schema
    assert "input: searchInput" in schema


def test_generate_action_schema_relaxes_only_the_tool_whose_whole_name_matches():
    all_optional = {
        "name": "a",
        "description": "All optional",
        "inputSchema": {"json": {"type": "object", "properties": {"x": {"type": "string"}}}},
    }
    # `input: aInput` is a prefix of this tool's own `input: aInputInput`, which must stay required.
    name_collides = {
        "name": "aInput",
        "description": "Requires a query",
        "inputSchema": {"json": {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}},
    }

    schema = generate_action_schema([all_optional, name_collides])

    assert "input?: aInput," in schema
    assert "input: aInputInput," in schema


def test_generate_action_schema_maps_each_json_type_to_a_cedar_type():
    tru_attributes = _declared_type(generate_action_schema([TYPED_SPEC]), "reportInput")
    exp_attributes = [
        "amount: decimal",
        "amounts?: Set<decimal>",
        "count?: Long",
        "flag?: Bool",
        "label?: String",
        "nested?: Drupe::report_Input_nested",
    ]
    assert tru_attributes == exp_attributes


def test_generate_action_schema_declares_an_enum_parameter_as_a_string():
    schema = generate_action_schema([ENUM_SPEC])
    assert "order: String" in schema


def test_generate_action_schema_leaves_a_parameter_named_enum_alone():
    spec = {
        "name": "configure",
        "description": "Configure",
        "inputSchema": {"json": {"type": "object", "properties": {"enum": {"type": "string"}}, "required": ["enum"]}},
    }
    assert "enum: String" in generate_action_schema([spec])


def test_generate_action_schema_rejects_a_shape_it_cannot_rewrite():
    with patch.object(_schema_generator, "mcp_to_cedar_schema", return_value="entity Unexpected;"):
        with pytest.raises(ValueError, match="cannot rewrite"):
            generate_action_schema([SEARCH_SPEC])


def test_generate_action_schema_rejects_a_shape_whose_input_it_cannot_relax():
    unrelaxable = f"entity {GENERATED_RESOURCE};\nresource: [{GENERATED_RESOURCE}]\n"
    with patch.object(_schema_generator, "mcp_to_cedar_schema", return_value=unrelaxable):
        with pytest.raises(ValueError, match="cannot relax"):
            generate_action_schema([PING_SPEC])


def test_specs_of_reads_a_spec_from_a_tool_or_passes_one_through():
    tool = MockAgentTool("recall")

    tru_specs = specs_of([tool, SEARCH_SPEC])
    exp_specs = [tool.tool_spec, SEARCH_SPEC]
    assert tru_specs == exp_specs


def test_decimal_parameters_selects_the_number_parameters_a_tool_declares():
    tru_decimals = decimal_parameters([TYPED_SPEC])
    exp_decimals = {"report": frozenset({"amount", "amounts"})}
    assert tru_decimals == exp_decimals


def test_decimal_parameters_omits_a_tool_declaring_none():
    assert decimal_parameters([SEARCH_SPEC, PING_SPEC]) == {}


@pytest.mark.parametrize("declared", [{"type": "array"}, {"type": "array", "items": True}, "number", None])
def test_decimal_parameters_skips_a_parameter_whose_type_it_cannot_read(declared):
    spec = {"name": "pay", "inputSchema": {"json": {"type": "object", "properties": {"amount": declared}}}}
    assert decimal_parameters([spec]) == {}


def test_decimal_parameters_reads_a_bare_input_schema():
    bare = {"name": "pay", "inputSchema": {"type": "object", "properties": {"amount": {"type": "number"}}}}
    assert decimal_parameters([bare]) == {"pay": frozenset({"amount"})}


def test_apply_namespace_redeclares_a_generated_schema():
    schema = apply_namespace(generate_action_schema([SEARCH_SPEC]), "Acme")
    assert "namespace Acme {" in schema
    assert GENERATED_NAMESPACE not in schema


def test_apply_namespace_unwraps_a_generated_schema_for_none():
    schema = apply_namespace(generate_action_schema([SEARCH_SPEC]), None)
    assert "namespace" not in schema
    assert GENERATED_NAMESPACE not in schema
    assert 'action "search"' in schema


def test_apply_namespace_leaves_the_generated_namespace_untouched():
    generated = generate_action_schema([SEARCH_SPEC])
    assert apply_namespace(generated, GENERATED_NAMESPACE) == generated


@pytest.mark.parametrize("namespace", [None, "Acme", "Acme::Inner", "_private", "A1::B2"])
def test_assert_cedar_namespace_accepts_a_legal_namespace(namespace):
    assert_cedar_namespace(namespace)


@pytest.mark.parametrize(
    "namespace",
    ["if", "then", "else", "in", "is", "like", "has", "true", "false", "Acme::if", "__cedarInternal"],
)
def test_assert_cedar_namespace_rejects_a_reserved_namespace(namespace):
    with pytest.raises(ValueError, match="none of them reserved"):
        assert_cedar_namespace(namespace)


@pytest.mark.parametrize("namespace", ["Ac-me", "1Acme", "Acme::", "::Acme", "Acme Inner", "Acme:Inner", ""])
def test_assert_cedar_namespace_rejects_a_malformed_namespace(namespace):
    with pytest.raises(ValueError, match="`::`-separated Cedar identifiers"):
        assert_cedar_namespace(namespace)


@pytest.mark.parametrize(
    ("actions", "exp_prefix"),
    [
        ([], ""),
        (["Action::search"], ""),
        (["Acme::Action::search"], "Acme::"),
        (["Acme::Inner::Action::search"], "Acme::Inner::"),
        (["My::Action::Action::search"], "My::Action::"),
    ],
)
def test_namespace_prefix_of_reads_the_namespace_the_actions_live_in(actions, exp_prefix):
    assert namespace_prefix_of(actions) == exp_prefix
