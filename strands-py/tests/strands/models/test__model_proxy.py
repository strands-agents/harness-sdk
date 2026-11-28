"""Tests for ``ModelProxy``, which sends a model call's messages in the form the model accepts."""

import copy
import threading
import unittest.mock

import pytest

from strands.agent.invocation_context import ModelUsage, _create_invocation_context
from strands.models._model_info import ModelCapabilities, ModelInfo
from strands.models._model_proxy import ModelProxy
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
async def test_stream_skips_model_when_cancel_signal_is_already_set(alist):
    model = unittest.mock.MagicMock()
    cancel_signal = threading.Event()
    cancel_signal.set()

    events = await alist(ModelProxy(model).stream([user({"text": "go"})], None, None, cancel_signal=cancel_signal))

    assert len(events) == 1
    assert events[0]["stop"] == (
        "cancelled",
        {"role": "assistant", "content": [{"text": "Cancelled by user"}]},
        {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
        {"latencyMs": 0},
    )
    model.stream.assert_not_called()


@pytest.mark.asyncio
async def test_stream_adds_the_call_usage_under_the_model_it_wraps(alist):
    usage = {"inputTokens": 3, "outputTokens": 4, "totalTokens": 7}
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "done"}]}], [usage])
    model.get_config = lambda: {"model_id": "model-a"}
    invocation_context = _create_invocation_context()

    await alist(ModelProxy(model).stream([user({"text": "go"})], None, None, invocation_context=invocation_context))

    assert invocation_context.usage_by_model == [ModelUsage(provider_name=None, model_id="model-a", usage=usage)]


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


def test_prepare_sends_reasoning_with_provider_data_only_to_a_model_that_takes_it_back(model):
    tagged = {"reasoningContent": {"providerData": {"provider": "openai_responses", "modelId": "m", "data": {}}}}
    plain = {"reasoningContent": {"reasoningText": {"text": "plain"}}}
    messages = [user({"text": "go"}), {"role": "assistant", "content": [tagged, plain, {"text": "done"}]}]
    original = copy.deepcopy(messages)

    sent, _ = ModelProxy(model)._prepare(messages)
    assert sent[1]["content"] == [plain, {"text": "done"}]

    info = ModelInfo(capabilities=ModelCapabilities(reasoning_provider="openai_responses"))
    with unittest.mock.patch.object(
        type(model), "model_info", new_callable=unittest.mock.PropertyMock, return_value=info
    ):
        assert ModelProxy(model)._prepare(messages)[0] == messages
    assert messages == original


def test_prepare_keeps_a_turn_that_held_only_dropped_reasoning_as_blank_text(model):
    tagged = {"reasoningContent": {"providerData": {"provider": "openai_responses", "modelId": "m", "data": {}}}}
    messages = [user({"text": "go"}), {"role": "assistant", "content": [tagged]}, user({"text": "next"})]

    sent, _ = ModelProxy(model)._prepare(messages)

    assert sent[1] == {"role": "assistant", "content": [{"text": "[blank text]"}]}
    assert sent[0] is messages[0]


def test_prepare_sends_only_the_text_of_reasoning_the_model_does_not_take_back(model):
    tag = {"provider": "anthropic", "modelId": "m", "data": {}}
    signed = {"reasoningContent": {"reasoningText": {"text": "plan", "signature": "SIG"}, "providerData": tag}}
    redacted = {"reasoningContent": {"redactedContent": b"x", "providerData": tag}}
    messages = [user({"text": "go"}), {"role": "assistant", "content": [signed, redacted, {"text": "done"}]}]

    sent, _ = ModelProxy(model)._prepare(messages)

    assert sent[1]["content"] == [{"reasoningContent": {"reasoningText": {"text": "plan"}}}, {"text": "done"}]


def _accepting(*accepted_mime_types: str) -> unittest.mock.MagicMock:
    model = unittest.mock.MagicMock()
    model.model_info = ModelInfo(capabilities=ModelCapabilities(accepted_mime_types=accepted_mime_types))
    return model


_PNG = {"image": {"format": "png", "source": {"bytes": b"1"}}}
_GIF = {"image": {"format": "gif", "source": {"bytes": b"1"}}}
_DOCX = {"document": {"name": "report", "format": "docx", "source": {"bytes": b"1"}}}
_MP4 = {"video": {"format": "mp4", "source": {"bytes": b"1"}}}
_THREE_GP = {"video": {"format": "three_gp", "source": {"bytes": b"1"}}}


def test_prepare_sends_a_text_in_place_of_each_media_block_the_model_does_not_accept():
    tool_result = {"toolUseId": "t-1", "status": "success", "content": [_GIF, {"text": "done"}]}
    messages = [user({"text": "look"}, _PNG, _DOCX, _THREE_GP), user({"toolResult": tool_result})]
    original = copy.deepcopy(messages)

    sent, _ = ModelProxy(_accepting("image/png", "application/pdf"))._prepare(messages)

    docx_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    assert sent == [
        user(
            {"text": "look"},
            _PNG,
            {"text": f'[document "report" omitted: this model can\'t read {docx_type}]'},
            {"text": "[video omitted: this model can't read video/3gpp]"},
        ),
        user(
            {
                "toolResult": {
                    **tool_result,
                    "content": [{"text": "[image omitted: this model can't read image/gif]"}, {"text": "done"}],
                }
            }
        ),
    ]
    assert messages == original


def test_prepare_passes_a_message_through_when_the_model_accepts_all_of_its_media():
    message = user(_PNG, _MP4)

    sent, _ = ModelProxy(_accepting("image/*", "video/*"))._prepare([message])

    assert sent[0] is message


def test_prepare_sends_every_block_to_a_model_without_an_accepted_list(model):
    messages = [user(_GIF, _DOCX, _MP4)]

    sent, _ = ModelProxy(model)._prepare(messages)

    assert sent is messages


def test_prepare_sends_only_text_to_a_text_only_model():
    sent, _ = ModelProxy(_accepting())._prepare([user(_PNG)])

    assert sent == [user({"text": "[image omitted: this model can't read image/png]"})]


def test_prepare_replaces_audio_by_its_audio_type():
    audio = {"audio": {"format": "mp3", "source": {"bytes": b"1"}}}

    sent, _ = ModelProxy(_accepting("image/*"))._prepare([user(audio)])

    assert sent == [user({"text": "[audio omitted: this model can't read audio/mp3]"})]


@pytest.mark.asyncio
async def test_count_tokens_counts_the_placeholder_it_would_send():
    model = _accepting("image/png")
    model.count_tokens = unittest.mock.AsyncMock(return_value=1)

    await ModelProxy(model).count_tokens([user(_GIF)])

    model.count_tokens.assert_awaited_once_with([user({"text": "[image omitted: this model can't read image/gif]"})])


@pytest.mark.parametrize("image_format", ["jpg", "JPEG"])
def test_prepare_reads_the_jpg_alias_and_any_case(image_format):
    image = {"image": {"format": image_format, "source": {"bytes": b"1"}}}

    sent, _ = ModelProxy(_accepting("image/png"))._prepare([user(image)])

    assert sent == [user({"text": "[image omitted: this model can't read image/jpeg]"})]


def test_prepare_keeps_a_block_whose_format_has_no_mime_type():
    message = user({"image": {"format": "heic", "source": {"bytes": b"1"}}})

    sent, _ = ModelProxy(_accepting())._prepare([message])

    assert sent[0] is message
