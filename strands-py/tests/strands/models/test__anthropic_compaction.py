import asyncio
import logging
import threading

import pytest

from strands.models._anthropic_compaction import (
    carries_native_block,
    compaction_params,
    format_native_block,
    from_last_native_block,
    read_compaction,
    until_cancelled,
)

RETURNED = {"type": "compaction", "content": "Summary: the user plans a release.", "signature": "EuYBCkQY-opaque"}
STORED = {"text": RETURNED["content"], "metadata": {"providerData": {"provider": "anthropic", "data": RETURNED}}}


def test_format_native_block_returns_anthropic_provider_data_unchanged():
    assert format_native_block(STORED) is RETURNED


@pytest.mark.parametrize(
    "block",
    [
        {"text": "plain"},
        {"text": "other", "metadata": {"providerData": {"provider": "bedrock", "data": {"type": "x"}}}},
        {"text": "no data", "metadata": {}},
        {"text": "string data", "metadata": {"providerData": {"provider": "anthropic", "data": "opaque"}}},
        {"text": "list data", "metadata": {"providerData": {"provider": "anthropic", "data": [RETURNED]}}},
        {"text": "null data", "metadata": {"providerData": {"provider": "anthropic", "data": None}}},
        {"text": "missing data", "metadata": {"providerData": {"provider": "anthropic"}}},
        {"image": {"format": "png", "source": {"bytes": b""}}},
    ],
)
def test_format_native_block_returns_none_for_other_blocks(block):
    assert format_native_block(block) is None
    assert not carries_native_block([{"role": "user", "content": [block]}])


def test_carries_native_block():
    messages = [{"role": "user", "content": [{"text": "a"}]}, {"role": "assistant", "content": [STORED]}]

    assert carries_native_block(messages)


def test_from_last_native_block_slices_from_the_last_native_block():
    older = {**STORED, "text": "older"}
    messages = [
        {"role": "user", "content": [older, {"text": "first"}]},
        {"role": "assistant", "content": [{"text": "before"}, STORED, {"text": "after"}]},
        {"role": "user", "content": [{"text": "next"}]},
    ]

    tru_messages = from_last_native_block(messages)

    exp_messages = [
        {"role": "assistant", "content": [STORED, {"text": "after"}]},
        {"role": "user", "content": [{"text": "next"}]},
    ]
    assert tru_messages == exp_messages
    assert messages[1]["content"] == [{"text": "before"}, STORED, {"text": "after"}]


def test_from_last_native_block_returns_all_messages_without_one():
    messages = [{"role": "user", "content": [{"text": "a"}]}]

    assert from_last_native_block(messages) is messages


def test_compaction_params_leaves_out_what_a_compaction_request_rejects():
    request = {
        "model": "m1",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "a"}]}],
        "system": "s1",
        "tools": [{"name": "lookup"}],
        "stop_sequences": ["STOP"],
        "context_management": {"edits": []},
        "tool_choice": {"type": "any"},
        "output_config": {
            "format": {"type": "json_schema"},
            "effort": "high",
            "task_budget": {"total": 9, "remaining": 4},
        },
        "extra_headers": {"anthropic-beta": "b1"},
        "extra_body": {"other": 1},
    }

    tru_params = compaction_params(request, "Keep the task.")

    exp_params = {
        "model": "m1",
        "max_tokens": 1,
        "messages": request["messages"],
        "system": "s1",
        "tools": [{"name": "lookup"}],
        "output_config": {"effort": "high", "task_budget": {"total": 9}},
        "extra_headers": {"anthropic-beta": "b1"},
        "extra_body": {"other": 1, "compaction": {"type": "summarize", "instructions": "Keep the task."}},
    }
    assert tru_params == exp_params


@pytest.mark.parametrize(
    ("tool_choice", "output_config", "exp_extra"),
    [
        ({"type": "auto"}, {"task_budget": {"remaining": 4}}, {"tool_choice": {"type": "auto"}}),
        ({"type": "tool", "name": "x"}, {"format": {"type": "json_schema"}}, {}),
        (None, None, {}),
    ],
)
def test_compaction_params_keeps_a_non_forcing_tool_choice_and_drops_an_empty_output_config(
    tool_choice, output_config, exp_extra
):
    request = {"model": "m1", "tool_choice": tool_choice, "output_config": output_config}

    tru_params = compaction_params(request, None)

    assert tru_params == {"model": "m1", **exp_extra, "extra_body": {"compaction": {"type": "summarize"}}}


def test_compaction_params_leaves_out_what_a_compaction_request_rejects_from_extra_body():
    request = {
        "model": "m1",
        "extra_body": {
            "other": 1,
            "stop_sequences": ["STOP"],
            "context_management": {"edits": []},
            "tool_choice": {"type": "tool", "name": "x"},
            "output_config": {"format": {"type": "json_schema"}, "task_budget": {"total": 9, "remaining": 4}},
        },
    }

    tru_params = compaction_params(request, None)

    exp_params = {
        "model": "m1",
        "extra_body": {"other": 1, "output_config": {"task_budget": {"total": 9}}, "compaction": {"type": "summarize"}},
    }
    assert tru_params == exp_params


@pytest.mark.parametrize(
    ("extra_body", "exp_extra_body"),
    [
        (
            {"tool_choice": {"type": "auto"}, "output_config": {"task_budget": {"remaining": 4}}},
            {"tool_choice": {"type": "auto"}},
        ),
        ({"tool_choice": {"type": "any"}, "output_config": {"format": {"type": "json_schema"}}}, {}),
    ],
)
def test_compaction_params_keeps_a_non_forcing_tool_choice_and_drops_an_empty_output_config_in_extra_body(
    extra_body, exp_extra_body
):
    tru_params = compaction_params({"model": "m1", "extra_body": extra_body}, None)

    exp_params = {"model": "m1", "extra_body": {**exp_extra_body, "compaction": {"type": "summarize"}}}
    assert tru_params == exp_params


def test_read_compaction_returns_the_stored_block_and_the_compaction_usage():
    response = {
        "content": [RETURNED],
        "stop_reason": "compaction",
        "usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "iterations": [
                {"type": "message", "input_tokens": 1, "output_tokens": 1},
                {
                    "type": "compaction",
                    "input_tokens": 144,
                    "output_tokens": 276,
                    "cache_read_input_tokens": 5,
                    "cache_creation_input_tokens": 0,
                },
            ],
        },
    }

    tru_result = read_compaction(response, "m1")

    exp_usage = {"inputTokens": 144, "outputTokens": 276, "totalTokens": 420, "cacheReadInputTokens": 5}
    assert tru_result == (STORED, exp_usage)


def test_read_compaction_without_a_compaction_iteration_has_no_usage():
    response = {"content": [RETURNED], "stop_reason": "compaction", "usage": {"input_tokens": 0}}

    assert read_compaction(response, "m1") == (STORED, None)


@pytest.mark.parametrize(
    ("content", "stop_reason"),
    [
        ([], "max_tokens"),
        ([RETURNED], "end_turn"),
        ([{"type": "compaction", "content": ""}], "compaction"),
        ([{"type": "compaction", "content": None}], "compaction"),
        ([{"type": "text", "text": "hi"}], "compaction"),
    ],
)
def test_read_compaction_returns_none_and_warns_without_a_summary(content, stop_reason, caplog):
    with caplog.at_level(logging.WARNING, logger="strands.models._anthropic_compaction"):
        tru_result = read_compaction({"content": content, "stop_reason": stop_reason, "usage": {}}, "m1")

    assert tru_result is None
    assert f"model_id=<m1>, stop_reason=<{stop_reason}> | compaction returned no summary" in caplog.text


@pytest.mark.asyncio
async def test_until_cancelled_returns_false_when_the_request_completes():
    request = asyncio.ensure_future(asyncio.sleep(0, result="done"))

    assert await until_cancelled(request, threading.Event()) is False
    assert request.result() == "done"


@pytest.mark.asyncio
async def test_until_cancelled_without_a_signal_waits_for_the_request():
    request = asyncio.ensure_future(asyncio.sleep(0, result="done"))

    assert await until_cancelled(request, None) is False
    assert request.result() == "done"


@pytest.mark.asyncio
async def test_until_cancelled_cancels_the_request_once_the_signal_is_set():
    cancel_signal = threading.Event()
    request = asyncio.ensure_future(asyncio.sleep(60))
    asyncio.get_running_loop().call_later(0.01, cancel_signal.set)

    assert await until_cancelled(request, cancel_signal) is True
    with pytest.raises(asyncio.CancelledError):
        await request


@pytest.mark.asyncio
async def test_until_cancelled_cancels_the_request_when_the_wait_is_cancelled():
    request = asyncio.ensure_future(asyncio.sleep(60))
    wait = asyncio.ensure_future(until_cancelled(request, threading.Event()))
    await asyncio.sleep(0)

    wait.cancel()
    with pytest.raises(asyncio.CancelledError):
        await wait

    assert request.cancelled()
