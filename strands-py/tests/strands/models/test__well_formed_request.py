"""Tests for ``well_formed_request``, which keeps lone surrogates out of model requests.

Regression tests for https://github.com/strands-agents/harness-sdk/issues/5937: a lone surrogate must never reach a
provider.
"""

import copy
import logging

import pytest

from strands.models._well_formed_request import well_formed_request

LONE_HIGH = "\ud83d"
LONE_LOW = "\udcff"
REPLACEMENT = "\ufffd"


def user(*content: dict, **extra) -> dict:
    return {"role": "user", "content": list(content), **extra}


def tool_result(*content: dict) -> dict:
    return {"toolResult": {"toolUseId": "t1", "status": "success", "content": list(content)}}


@pytest.mark.parametrize(
    ("block", "exp_block"),
    [
        ({"text": f"a{LONE_HIGH}b😂c{LONE_LOW}"}, {"text": f"a{REPLACEMENT}b😂c{REPLACEMENT}"}),
        (
            tool_result({"text": f"x{LONE_HIGH}"}, {"json": {f"k{LONE_LOW}": [f"y{LONE_HIGH}", (f"z{LONE_LOW}",)]}}),
            tool_result(
                {"text": f"x{REPLACEMENT}"}, {"json": {f"k{REPLACEMENT}": [f"y{REPLACEMENT}", (f"z{REPLACEMENT}",)]}}
            ),
        ),
        (
            {"toolUse": {"toolUseId": "t1", "name": "lookup", "input": {"query": f"q{LONE_HIGH}"}}},
            {"toolUse": {"toolUseId": "t1", "name": "lookup", "input": {"query": f"q{REPLACEMENT}"}}},
        ),
        (
            {"reasoningContent": {"reasoningText": {"text": f"r{LONE_HIGH}"}}},
            {"reasoningContent": {"reasoningText": {"text": f"r{REPLACEMENT}"}}},
        ),
        (
            {"injected": {"text": f"i{LONE_HIGH}", "source": "memory"}},
            {"injected": {"text": f"i{REPLACEMENT}", "source": "memory"}},
        ),
    ],
    ids=["text_with_an_intact_pair", "tool_result_text_and_json", "tool_use_input", "unsigned_reasoning", "injected"],
)
def test_well_formed_request_replaces_lone_surrogates_and_leaves_the_messages_unchanged(block, exp_block):
    messages = [user(block, metadata={"key": "value"})]
    original = copy.deepcopy(messages)

    tru_messages, _ = well_formed_request(messages)

    assert tru_messages == [user(exp_block, metadata={"key": "value"})]
    assert messages == original


def test_well_formed_request_replaces_lone_surrogates_in_the_fields_and_keeps_the_rest():
    tool_specs = [{"name": "lookup", "description": f"d{LONE_LOW}", "inputSchema": {"json": {"type": "object"}}}]

    _, tru_fields = well_formed_request(
        [],
        system_prompt=f"s{LONE_HIGH}",
        system_prompt_content=[{"text": f"s{LONE_HIGH}"}],
        tool_specs=tool_specs,
        tool_choice=None,
    )

    assert tru_fields == {
        "system_prompt": f"s{REPLACEMENT}",
        "system_prompt_content": [{"text": f"s{REPLACEMENT}"}],
        "tool_specs": [
            {"name": "lookup", "description": f"d{REPLACEMENT}", "inputSchema": {"json": {"type": "object"}}}
        ],
        "tool_choice": None,
    }


def test_well_formed_request_leaves_signed_reasoning_and_bytes_as_they_are():
    messages = [
        user(
            {"reasoningContent": {"reasoningText": {"text": f"r{LONE_HIGH}", "signature": "signature"}}},
            {"image": {"format": "png", "source": {"bytes": b"\xed\xa0\xbd"}}},
        )
    ]

    tru_messages, _ = well_formed_request(messages)

    assert tru_messages is messages


def test_well_formed_request_warns_when_it_replaces_lone_surrogates(caplog):
    with caplog.at_level(logging.WARNING, logger="strands.models._well_formed_request"):
        well_formed_request([user({"text": f"a{LONE_HIGH}"})])

    assert [record.getMessage() for record in caplog.records] == ["replaced lone surrogates in model request"]


def test_well_formed_request_returns_a_well_formed_request_as_it_is_without_warning(caplog):
    # Only content is sent, so a lone surrogate in metadata is left alone.
    messages = [user({"text": "plain 😂"}, metadata={"note": f"n{LONE_HIGH}"})]
    tool_specs = [{"name": "lookup", "description": "plain", "inputSchema": {"json": {}}}]

    with caplog.at_level(logging.WARNING, logger="strands.models._well_formed_request"):
        tru_messages, tru_fields = well_formed_request(messages, system_prompt="plain 😂", tool_specs=tool_specs)

    assert tru_messages is messages
    assert tru_fields["tool_specs"] is tool_specs
    assert caplog.records == []
