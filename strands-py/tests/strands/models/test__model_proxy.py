"""Tests for ``ModelProxy``, which sends a model call's messages in the form the model accepts."""

import copy
import unittest.mock

import pytest

from strands.models._model_proxy import ModelProxy, _with_cache_points
from tests.fixtures.mocked_model_provider import MockedModelProvider


def injected(text: str) -> dict:
    return {"injected": {"text": text, "source": "test"}}


def user(*content: dict, **extra) -> dict:
    return {"role": "user", "content": list(content), **extra}


@pytest.fixture
def model():
    return MockedModelProvider([])


@pytest.fixture
def temporary_model():
    model = unittest.mock.MagicMock()
    model.model_info.capabilities.temporary_messages = True
    return model


@pytest.mark.parametrize(
    ("content", "text", "sent_text"),
    [
        ([{"text": "Refactor the tokenizer."}], "reminder", "\n\nreminder"),
        (
            [{"toolResult": {"toolUseId": "tool-1", "status": "success", "content": [{"text": "done"}]}}],
            "reminder",
            "\n\nreminder",
        ),
        ([], "reminder", "reminder"),
        ([{"text": "Refactor the tokenizer."}], "\nreminder", "\nreminder"),
    ],
    ids=["a_prompt", "a_tool_result_turn", "an_empty_user_message", "text_that_starts_with_a_newline"],
)
def test_prepare_sends_the_text_apart_from_the_content_before_it(model, content, text, sent_text):
    messages = [user(*content, injected(text), tracking_id="msg-1")]

    tru_messages, _ = ModelProxy(model)._prepare(messages)

    assert tru_messages == [user(*content, {"text": sent_text}, tracking_id="msg-1")]


def test_prepare_sends_each_of_several_injected_blocks_as_its_own_text_block_in_place(model):
    metadata = {"custom": {"source": "test"}}
    messages = [
        user(
            {"text": "Refactor the tokenizer."},
            injected("one"),
            injected("two"),
            tracking_id="msg-1",
            metadata=metadata,
        )
    ]

    tru_messages, _ = ModelProxy(model)._prepare(messages)

    exp_messages = [
        user(
            {"text": "Refactor the tokenizer."},
            {"text": "\n\none"},
            {"text": "\n\ntwo"},
            tracking_id="msg-1",
            metadata=metadata,
        )
    ]
    assert tru_messages == exp_messages


def test_prepare_leaves_out_the_injected_blocks_of_earlier_user_messages(model):
    answer = {"role": "assistant", "content": [{"text": "Done."}], "tracking_id": "msg-2"}
    latest = user({"text": "Now the docs."})
    messages = [user({"text": "Refactor."}, injected("reminder"), tracking_id="msg-1"), answer, latest]

    tru_messages, tru_trailing = ModelProxy(model)._prepare(messages)

    assert tru_messages == [user({"text": "Refactor."}, tracking_id="msg-1"), answer, latest]
    assert tru_messages[1] is answer
    assert tru_trailing == 0


def test_prepare_reports_the_trailing_blocks_from_the_first_injected_block_on(model):
    messages = [user({"text": "Refactor."}, injected("reminder"), {"text": "\n\nper-call text"})]

    _, tru_trailing = ModelProxy(model)._prepare(messages)

    assert tru_trailing == 2


def test_prepare_sends_text_to_a_custom_provider_serving_a_model_that_takes_temporary_messages(model):
    messages = [user({"text": "Refactor."}, injected("reminder"), tracking_id="msg-1")]

    with unittest.mock.patch.object(model, "get_config", return_value={"model_id": "claude-opus-5-5"}):
        tru_messages, _ = ModelProxy(model)._prepare(messages)

    assert tru_messages == [user({"text": "Refactor."}, {"text": "\n\nreminder"}, tracking_id="msg-1")]


def test_prepare_passes_injected_blocks_through_to_a_model_that_takes_temporary_messages(
    temporary_model,
):
    messages = [
        user({"text": "Refactor."}, injected("reminder")),
        {"role": "assistant", "content": [{"text": "Done."}]},
        user({"text": "Now the docs."}),
    ]

    tru_messages, tru_trailing = ModelProxy(temporary_model)._prepare(messages)

    assert tru_messages is messages
    assert tru_trailing == 0


@pytest.mark.asyncio
async def test_count_tokens_counts_the_messages_it_would_send():
    model = unittest.mock.MagicMock()
    model.count_tokens = unittest.mock.AsyncMock(return_value=7)
    messages = [user({"text": "Refactor."}, injected("reminder"), tracking_id="msg-1")]

    tru_count = await ModelProxy(model).count_tokens(messages, system_prompt="Be brief.")

    assert tru_count == 7
    model.count_tokens.assert_awaited_once_with(
        [user({"text": "Refactor."}, {"text": "\n\nreminder"}, tracking_id="msg-1")], system_prompt="Be brief."
    )


def test_prepare_leaves_out_an_injected_block_outside_a_user_message(model):
    prompt = user({"text": "go"})
    messages = [
        prompt,
        {
            "role": "assistant",
            "content": [{"text": "Hi"}, injected("reminder"), {"text": "Bye"}],
            "tracking_id": "msg-2",
        },
    ]

    tru_messages, _ = ModelProxy(model)._prepare(messages)

    assert tru_messages == [
        prompt,
        {"role": "assistant", "content": [{"text": "Hi"}, {"text": "Bye"}], "tracking_id": "msg-2"},
    ]


def test_prepare_does_not_change_the_messages_it_was_given(model):
    messages = [user({"text": "Refactor the tokenizer."}, injected("reminder"))]
    original = copy.deepcopy(messages)

    ModelProxy(model)._prepare(messages)

    assert messages == original


def test_prepare_passes_messages_without_an_injected_block_through_as_they_are(model):
    messages = [user({"text": "go"})]

    tru_messages, _ = ModelProxy(model)._prepare(messages)

    assert tru_messages is messages


def test_prepare_leaves_an_offload_placeholders_bookkeeping_out_of_the_request(model):
    placeholder = {"text": "[Dropped: ~5 tokens] [ref: tool-1]", "offloaded": {"method": "drop", "ref": "tool-1"}}
    tool_result = {"toolUseId": "tool-1", "status": "success", "content": [dict(placeholder)]}
    messages = [user(dict(placeholder), {"toolResult": tool_result})]
    original = copy.deepcopy(messages)

    sent, _ = ModelProxy(model)._prepare(messages)

    assert sent == [
        user(
            {"text": "[Dropped: ~5 tokens] [ref: tool-1]"},
            {"toolResult": {**tool_result, "content": [{"text": "[Dropped: ~5 tokens] [ref: tool-1]"}]}},
        )
    ]
    assert messages == original


@pytest.mark.parametrize(
    ("server_side_summary", "sent_block"),
    [(None, {"text": "SUMMARY"}), (False, {"text": "SUMMARY"}), (True, {"summary": {"text": "SUMMARY"}})],
)
def test_prepare_sends_summary_text_unless_the_model_summarizes_server_side(server_side_summary, sent_block):
    model = unittest.mock.MagicMock()
    model.model_info.capabilities.server_side_summary = server_side_summary
    model.model_info.capabilities.temporary_messages = None
    messages = [
        {"role": "assistant", "content": [{"summary": {"text": "SUMMARY"}}, {"text": "next"}]},
        user({"text": "go"}, injected("reminder")),
    ]
    original = copy.deepcopy(messages)

    sent, trailing_blocks = ModelProxy(model)._prepare(messages)

    assert sent == [
        {"role": "assistant", "content": [sent_block, {"text": "next"}]},
        user({"text": "go"}, {"text": "\n\nreminder"}),
    ]
    assert trailing_blocks == 1
    assert messages == original


def tool_result_turn(*extra: dict) -> dict:
    return user({"toolResult": {"toolUseId": "t1", "status": "success", "content": [{"text": "s1"}]}}, *extra)


@pytest.fixture
def cache_messages():
    return [
        user({"text": "read section 1"}),
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "read", "input": {"n": 1}}}]},
        tool_result_turn({"text": "Current time: 1 ms"}),
    ]


def _cache_model(model_id: str, model_info=None, **cache_config):
    from strands.models import CacheConfig
    from strands.models.litellm import LiteLLMModel

    extra = {"model_info": model_info} if model_info else {}
    return LiteLLMModel(model_id=model_id, cache_config=CacheConfig(**cache_config), **extra)


def test_with_cache_points_marks_the_system_prompt_and_the_latest_user_message_ahead_of_rebuilt_blocks(
    cache_messages,
):
    model = _cache_model("anthropic/claude-haiku-4-5")
    original = copy.deepcopy(cache_messages)

    system, messages = _with_cache_points(model, "s1", None, cache_messages, dynamic_trailing_blocks=1)

    assert system == [{"text": "s1"}, {"cachePoint": {"type": "default"}}]
    assert messages[-1]["content"][1:] == [{"cachePoint": {"type": "default"}}, {"text": "Current time: 1 ms"}]
    assert messages[:-1] == cache_messages[:-1]
    assert cache_messages == original


@pytest.mark.parametrize("model_id", ["openai/gpt-6-luna", "gemini/gemini-3.5-flash"])
def test_with_cache_points_leaves_backends_without_cache_points_alone(model_id, cache_messages):
    system, messages = _with_cache_points(_cache_model(model_id), "s1", None, cache_messages, 0)

    assert (system, messages) == (None, cache_messages)


def test_with_cache_points_leaves_a_provider_that_places_its_own_alone(model, cache_messages):
    system, messages = _with_cache_points(model, "s1", None, cache_messages, 0)

    assert (system, messages) == (None, cache_messages)


def test_with_cache_points_marks_a_proxy_alias_declared_through_model_info(cache_messages):
    from strands.models import ModelCapabilities, ModelInfo

    declared = ModelInfo(capabilities=ModelCapabilities(prompt_caching="cache_points"))
    model = _cache_model("litellm_proxy/claude-alias", model_info=declared)

    system, messages = _with_cache_points(model, "s1", None, cache_messages, 0)

    assert system[-1] == {"cachePoint": {"type": "default"}}
    assert messages[-1]["content"][-1] == {"cachePoint": {"type": "default"}}


@pytest.mark.parametrize("model_id", ["litellm_proxy/claude-alias", "gemini/gemini-3.5-flash"])
def test_with_cache_points_does_not_let_the_anthropic_strategy_override_model_info(model_id, cache_messages):
    model = _cache_model(model_id, strategy="anthropic")

    assert _with_cache_points(model, "s1", None, cache_messages, 0) == (None, cache_messages)


def test_with_cache_points_keeps_the_callers_points_and_ttls(cache_messages):
    model = _cache_model("anthropic/claude-haiku-4-5", ttl="1h")
    content = [{"text": "a"}, {"cachePoint": {"type": "default"}}, {"text": "b"}]

    system, messages = _with_cache_points(model, None, content, cache_messages, 0)

    assert system is content
    assert messages[-1]["content"][-1] == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_with_cache_points_honors_disabled_sections(cache_messages):
    model = _cache_model("anthropic/claude-haiku-4-5", system_prompt_ttl=False, messages_ttl=False)

    assert _with_cache_points(model, "s1", None, cache_messages, 0) == (None, cache_messages)
