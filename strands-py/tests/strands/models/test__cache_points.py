"""Tests for the cache point placement rules shared by providers."""

import copy

import pytest

from strands.models._cache_points import (
    cache_control,
    cache_point,
    messages_with_cache_point,
    section_ttl,
    step_back_over_documents,
    system_with_cache_point,
    with_placed_points_normalized,
    with_point_ttls,
)

POINT = {"cachePoint": {"type": "default"}}
TXT = {"document": {"format": "txt", "name": "a", "source": {"bytes": b"a"}}}
PDF = {"document": {"format": "pdf", "name": "b", "source": {"bytes": b"b"}}}


@pytest.mark.parametrize(
    ("section", "ttl", "exp_ttl"), [("1h", "5m", "1h"), (True, "5m", "5m"), (None, None, None), (False, "1h", "1h")]
)
def test_section_ttl_prefers_the_sections_own_ttl(section, ttl, exp_ttl):
    assert section_ttl(section, ttl) == exp_ttl


@pytest.mark.parametrize(("ttl", "exp_point"), [("1h", {"type": "default", "ttl": "1h"}), (None, {"type": "default"})])
def test_cache_point_carries_a_ttl_only_when_given(ttl, exp_point):
    assert cache_point(ttl) == exp_point


@pytest.mark.parametrize(
    ("ttl", "exp_cache_control"), [("1h", {"type": "ephemeral", "ttl": "1h"}), ("", {"type": "ephemeral"})]
)
def test_cache_control_carries_a_ttl_only_when_given(ttl, exp_cache_control):
    assert cache_control(ttl) == exp_cache_control


def test_with_point_ttls_fills_only_points_without_a_ttl():
    blocks = [{"text": "a"}, POINT, {"cachePoint": {"type": "default", "ttl": "5m"}}]
    original = copy.deepcopy(blocks)

    tru_blocks = with_point_ttls(blocks, "1h")

    exp_blocks = [
        {"text": "a"},
        {"cachePoint": {"type": "default", "ttl": "1h"}},
        {"cachePoint": {"type": "default", "ttl": "5m"}},
    ]
    assert tru_blocks == exp_blocks
    assert blocks == original


@pytest.mark.parametrize("blocks", [None, [{"text": "a"}]])
def test_with_point_ttls_returns_blocks_without_points_unchanged(blocks):
    assert with_point_ttls(blocks, "1h") is blocks


@pytest.mark.parametrize(
    ("content", "index", "exp_index"),
    [
        ([{"text": "a"}, TXT], 2, 1),
        ([{"text": "a"}, TXT, TXT], 3, 1),
        ([{"text": "a"}, PDF], 2, 2),
        ([TXT], 1, 0),
        ([{"text": "a"}], 1, 1),
    ],
    ids=["one_txt", "two_txt", "pdf_stays", "only_a_document", "no_document"],
)
def test_step_back_over_documents_steps_over_adjacent_non_pdf_documents(content, index, exp_index):
    assert step_back_over_documents(content, index) == exp_index


@pytest.mark.parametrize(
    ("system_prompt", "content", "exp_content"),
    [
        ("s", None, [{"text": "s"}, POINT]),
        (None, [{"text": "a"}], [{"text": "a"}, POINT]),
        (None, [{"text": "a"}, POINT, {"text": "b"}], [{"text": "a"}, POINT, {"text": "b"}]),
        (None, None, None),
    ],
    ids=["from_string", "from_blocks", "caller_placed", "empty"],
)
def test_system_with_cache_point_ends_the_system_prompt_with_a_point_once(system_prompt, content, exp_content):
    assert system_with_cache_point(system_prompt, content, {"type": "default"}) == exp_content


def test_messages_with_cache_point_puts_the_point_in_the_latest_user_message_ahead_of_rebuilt_blocks():
    messages = [
        {"role": "user", "content": [{"text": "q"}]},
        {"role": "assistant", "content": [{"text": "a"}]},
        {"role": "user", "content": [{"text": "r"}, {"text": "injected"}]},
    ]
    original = copy.deepcopy(messages)

    tru_messages = messages_with_cache_point(messages, 1, {"type": "default"})

    exp_messages = [*original[:2], {"role": "user", "content": [{"text": "r"}, POINT, {"text": "injected"}]}]
    assert tru_messages == exp_messages
    assert messages == original


@pytest.mark.parametrize(
    ("content", "dynamic_trailing_blocks"),
    [([{"text": "r"}, POINT], 0), ([{"text": "injected"}], 1), ([TXT], 0)],
    ids=["caller_placed", "only_rebuilt_blocks", "would_come_first"],
)
def test_messages_with_cache_point_leaves_the_message_alone_when_it_cannot_take_a_point(
    content, dynamic_trailing_blocks
):
    messages = [{"role": "user", "content": content}]

    tru_messages = messages_with_cache_point(
        messages, dynamic_trailing_blocks, {"type": "default"}, step_back_over_documents
    )

    assert tru_messages is messages


def test_messages_with_cache_point_applies_the_boundary_rule():
    messages = [{"role": "user", "content": [{"text": "read"}, TXT]}]

    tru_messages = messages_with_cache_point(messages, 0, {"type": "default"}, step_back_over_documents)

    assert tru_messages == [{"role": "user", "content": [{"text": "read"}, POINT, TXT]}]


def test_with_placed_points_normalized_sets_the_ttl_steps_back_and_drops_leading_points():
    messages = [
        {"role": "user", "content": [{"text": "a"}, {"cachePoint": {"type": "default", "ttl": "1h"}}]},
        {"role": "user", "content": [{"text": "b"}, TXT, POINT, {"text": "c"}]},
        {"role": "user", "content": [TXT, POINT]},
    ]
    original = copy.deepcopy(messages)

    tru_messages = with_placed_points_normalized(messages, "5m", step_back=True, align_ttl=True)

    five_minutes = {"cachePoint": {"type": "default", "ttl": "5m"}}
    exp_messages = [
        {"role": "user", "content": [{"text": "a"}, five_minutes]},
        {"role": "user", "content": [{"text": "b"}, five_minutes, TXT, {"text": "c"}]},
        {"role": "user", "content": [TXT]},
    ]
    assert tru_messages == exp_messages
    assert messages == original


def test_with_placed_points_normalized_keeps_positions_and_ttls_without_step_back_or_alignment():
    placed = {"cachePoint": {"type": "default", "ttl": "1h"}}
    messages = [{"role": "user", "content": [{"text": "b"}, TXT, placed]}]

    tru_messages = with_placed_points_normalized(messages, None, step_back=False, align_ttl=False)

    assert tru_messages == [{"role": "user", "content": [{"text": "b"}, TXT, placed]}]
