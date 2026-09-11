import logging
import unittest.mock

import pydantic
import pytest
from google import genai

import strands
from strands.models.gemini import GeminiModel
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException


@pytest.fixture
def gemini_client():
    with unittest.mock.patch.object(strands.models.gemini.genai, "Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value
        mock_client.aio = unittest.mock.AsyncMock()
        yield mock_client


@pytest.fixture
def model_id():
    return "m1"


@pytest.fixture
def model(gemini_client, model_id):
    _ = gemini_client

    return GeminiModel(model_id=model_id)


@pytest.fixture
def messages():
    return [{"role": "user", "content": [{"text": "test"}]}]


@pytest.fixture
def tool_spec():
    return {
        "description": "description",
        "name": "name",
        "inputSchema": {"json": {"key": "val"}},
    }


@pytest.fixture
def system_prompt():
    return "s1"


@pytest.fixture
def weather_output():
    class Weather(pydantic.BaseModel):
        time: str
        weather: str

    return Weather(time="12:00", weather="sunny")


def test__init__model_configs(gemini_client, model_id):
    _ = gemini_client

    model = GeminiModel(model_id=model_id, params={"temperature": 1})

    tru_temperature = model.get_config().get("params")
    exp_temperature = {"temperature": 1}

    assert tru_temperature == exp_temperature


def test__init__context_window_limit(gemini_client):
    _ = gemini_client

    model = GeminiModel(model_id="gemini-2.5-flash", context_window_limit=1_048_576)

    assert model.get_config().get("context_window_limit") == 1_048_576
    assert model.context_window_limit == 1_048_576


def test__init__auto_populates_context_window_limit(gemini_client):
    _ = gemini_client

    model = GeminiModel(model_id="gemini-2.5-flash")

    assert model.get_config().get("context_window_limit") == 1_048_576


def test__init__explicit_context_window_limit_not_overridden(gemini_client):
    _ = gemini_client

    model = GeminiModel(model_id="gemini-2.5-flash", context_window_limit=500_000)

    assert model.get_config().get("context_window_limit") == 500_000


def test__init__unknown_model_no_context_window_limit(gemini_client):
    _ = gemini_client

    model = GeminiModel(model_id="unknown-model")

    assert model.get_config().get("context_window_limit") is None


def test_update_config(model, model_id):
    model.update_config(model_id=model_id)

    tru_model_id = model.get_config().get("model_id")
    exp_model_id = model_id

    assert tru_model_id == exp_model_id


@pytest.mark.asyncio
async def test_stream_request_default(gemini_client, model, messages, model_id):
    await anext(model.stream(messages))

    exp_request = {
        "config": {},
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_params(gemini_client, model, messages, model_id):
    model.update_config(params={"temperature": 1})

    await anext(model.stream(messages))

    exp_request = {
        "config": {"temperature": 1},
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_system_prompt(gemini_client, model, messages, model_id, system_prompt):
    await anext(model.stream(messages, system_prompt=system_prompt))

    exp_request = {
        "config": {"system_instruction": system_prompt},
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.parametrize(
    ("content", "formatted_part"),
    [
        # # PDF
        (
            {"document": {"format": "pdf", "name": "test doc", "source": {"bytes": b"pdf"}}},
            {"inline_data": {"data": "cGRm", "mime_type": "application/pdf"}},
        ),
        # Plain text
        (
            {"document": {"format": "txt", "name": "test doc", "source": {"bytes": b"txt"}}},
            {"inline_data": {"data": "dHh0", "mime_type": "text/plain"}},
        ),
    ],
)
@pytest.mark.asyncio
async def test_stream_request_with_document(content, formatted_part, gemini_client, model, model_id):
    messages = [
        {
            "role": "user",
            "content": [content],
        },
    ]
    await anext(model.stream(messages))

    exp_request = {
        "config": {},
        "contents": [{"parts": [formatted_part], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_image(gemini_client, model, model_id):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "image": {
                        "format": "jpg",
                        "source": {"bytes": b"base64encodedimage"},
                    },
                },
            ],
        },
    ]
    await anext(model.stream(messages))

    exp_request = {
        "config": {},
        "contents": [
            {
                "parts": [
                    {
                        "inline_data": {
                            "data": "YmFzZTY0ZW5jb2RlZGltYWdl",
                            "mime_type": "image/jpeg",
                        },
                    },
                ],
                "role": "user",
            },
        ],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_reasoning(gemini_client, model, model_id):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "reasoningContent": {
                        "reasoningText": {
                            "signature": "YWJj",  # base64 of "abc"
                            "text": "reasoning_text",
                        },
                    },
                },
            ],
        },
    ]
    await anext(model.stream(messages))

    exp_request = {
        "config": {},
        "contents": [
            {
                "parts": [
                    {
                        "text": "reasoning_text",
                        "thought": True,
                        "thought_signature": "YWJj",
                    },
                ],
                "role": "user",
            },
        ],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_tool_spec(gemini_client, model, model_id, tool_spec):
    await anext(model.stream([], [tool_spec]))

    exp_request = {
        "config": {
            "tools": [
                {
                    "function_declarations": [
                        {
                            "description": "description",
                            "name": "name",
                            "parameters_json_schema": {"key": "val"},
                        },
                    ],
                },
            ],
        },
        "contents": [],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_tool_use(gemini_client, model, model_id):
    """Test toolUse with reasoningSignature is sent as function_call with thought_signature."""
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "c1",
                        "name": "calculator",
                        "input": {"expression": "2+2"},
                        "reasoningSignature": "YWJj",  # base64 of "abc"
                    },
                },
            ],
        },
    ]
    await anext(model.stream(messages))

    exp_request = {
        "config": {},
        "contents": [
            {
                "parts": [
                    {
                        "function_call": {
                            "args": {"expression": "2+2"},
                            "id": "c1",
                            "name": "calculator",
                        },
                        "thought_signature": "YWJj",
                    },
                ],
                "role": "model",
            },
        ],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_tool_use_no_reasoning_signature(gemini_client, model, model_id):
    """Test toolUse without reasoningSignature is sent as function_call without thought_signature."""
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "c1",
                        "name": "calculator",
                        "input": {"expression": "2+2"},
                    },
                },
            ],
        },
    ]
    await anext(model.stream(messages))

    exp_request = {
        "config": {},
        "contents": [
            {
                "parts": [
                    {
                        "function_call": {
                            "args": {"expression": "2+2"},
                            "id": "c1",
                            "name": "calculator",
                        },
                    },
                ],
                "role": "model",
            },
        ],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_tool_results(gemini_client, model, model_id):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "c1",
                        "status": "success",
                        "content": [
                            {"text": "see image"},
                            {"json": ["see image"]},
                            {
                                "image": {
                                    "format": "jpg",
                                    "source": {"bytes": b"base64encodedimage"},
                                },
                            },
                        ],
                    }
                }
            ],
        }
    ]
    await anext(model.stream(messages))

    exp_request = {
        "config": {},
        "contents": [
            {
                "parts": [
                    {
                        "function_response": {
                            "id": "c1",
                            "name": "c1",
                            "response": {
                                "output": [
                                    {"text": "see image"},
                                    {"json": ["see image"]},
                                    {
                                        "inline_data": {
                                            "data": "YmFzZTY0ZW5jb2RlZGltYWdl",
                                            "mime_type": "image/jpeg",
                                        },
                                    },
                                ],
                            },
                        },
                    },
                ],
                "role": "user",
            },
        ],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_tool_results_preserving_name(gemini_client, model, model_id):
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "t1",
                        "name": "tool_1",
                        "input": {},
                    },
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [{"text": "done"}],
                    },
                },
            ],
        },
    ]
    await anext(model.stream(messages))

    exp_request = {
        "config": {},
        "contents": [
            {
                "parts": [
                    {
                        "function_call": {
                            "args": {},
                            "id": "t1",
                            "name": "tool_1",
                        },
                    },
                ],
                "role": "model",
            },
            {
                "parts": [
                    {
                        "function_response": {
                            "id": "t1",
                            "name": "tool_1",
                            "response": {"output": [{"text": "done"}]},
                        },
                    },
                ],
                "role": "user",
            },
        ],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_empty_content(gemini_client, model, model_id):
    messages = [
        {
            "role": "user",
            "content": [],
        },
    ]
    await anext(model.stream(messages))

    exp_request = {
        "config": {},
        "contents": [{"parts": [], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_unsupported_type(model):
    messages = [
        {
            "role": "user",
            "content": [{"unsupported": {}}],
        },
    ]

    with pytest.raises(TypeError, match="content_type=<unsupported> | unsupported type"):
        await anext(model.stream(messages))


@pytest.mark.asyncio
async def test_stream_response_text(gemini_client, model, messages, agenerator, alist):
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[genai.types.Part(text="test text")],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    tru_chunks = await alist(model.stream(messages))
    exp_chunks = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": "test text"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
        {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}, "metrics": {"latencyMs": 0}}},
    ]
    assert tru_chunks == exp_chunks


def test_format_chunk_metadata_with_cache_tokens(model):
    """Test _format_chunk for metadata with cache tokens present."""
    event = {
        "chunk_type": "metadata",
        "data": genai.types.GenerateContentResponseUsageMetadata(
            prompt_token_count=100,
            total_token_count=150,
            cached_content_token_count=25,
        ),
    }

    result = model._format_chunk(event)

    assert result == {
        "metadata": {
            "usage": {
                "inputTokens": 100,
                "outputTokens": 50,
                "totalTokens": 150,
                "cacheReadInputTokens": 25,
            },
            "metrics": {"latencyMs": 0},
        },
    }


def test_format_chunk_metadata_with_zero_cached_tokens(model):
    """Test _format_chunk for metadata when cached_content_token_count is 0."""
    event = {
        "chunk_type": "metadata",
        "data": genai.types.GenerateContentResponseUsageMetadata(
            prompt_token_count=100,
            total_token_count=150,
            cached_content_token_count=0,
        ),
    }

    result = model._format_chunk(event)

    assert result == {
        "metadata": {
            "usage": {
                "inputTokens": 100,
                "outputTokens": 50,
                "totalTokens": 150,
            },
            "metrics": {"latencyMs": 0},
        },
    }


def test_format_chunk_metadata_with_missing_token_counts(model):
    event = {
        "chunk_type": "metadata",
        "data": genai.types.GenerateContentResponseUsageMetadata(
            prompt_token_count=None,
            total_token_count=None,
        ),
    }

    result = model._format_chunk(event)

    assert result == {
        "metadata": {
            "usage": {
                "inputTokens": 0,
                "outputTokens": 0,
                "totalTokens": 0,
            },
            "metrics": {"latencyMs": 0},
        },
    }


def test_format_chunk_metadata_counts_tool_use_as_input_and_thoughts_as_output(model):
    """Tool-use tokens count as input and thinking tokens as output, not folded into output by subtraction.

    Regression for the token miscount catalogued in #3546: total_token_count sums four disjoint buckets
    (prompt + candidates + tool_use_prompt + thoughts), so subtracting only prompt miscounts the input-side
    tool_use_prompt tokens as output.
    """
    event = {
        "chunk_type": "metadata",
        "data": genai.types.GenerateContentResponseUsageMetadata(
            prompt_token_count=100,
            candidates_token_count=20,
            tool_use_prompt_token_count=5,
            thoughts_token_count=30,
            total_token_count=155,
        ),
    }

    result = model._format_chunk(event)

    assert result == {
        "metadata": {
            "usage": {
                "inputTokens": 105,
                "outputTokens": 50,
                "totalTokens": 155,
            },
            "metrics": {"latencyMs": 0},
        },
    }


def test_format_chunk_metadata_with_candidates_and_cache_tokens(model):
    """Test _format_chunk uses candidates for output while still surfacing cache-read tokens."""
    event = {
        "chunk_type": "metadata",
        "data": genai.types.GenerateContentResponseUsageMetadata(
            prompt_token_count=100,
            candidates_token_count=20,
            cached_content_token_count=25,
            total_token_count=120,
        ),
    }

    result = model._format_chunk(event)

    assert result == {
        "metadata": {
            "usage": {
                "inputTokens": 100,
                "outputTokens": 20,
                "totalTokens": 120,
                "cacheReadInputTokens": 25,
            },
            "metrics": {"latencyMs": 0},
        },
    }


@pytest.mark.asyncio
async def test_stream_response_tool_use(gemini_client, model, messages, agenerator, alist):
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[
                                genai.types.Part(
                                    function_call=genai.types.FunctionCall(
                                        args={"expression": "2+2"},
                                        id="c1",
                                        name="calculator",
                                    ),
                                ),
                            ],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    tru_chunks = await alist(model.stream(messages))
    exp_chunks = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {"toolUse": {"name": "calculator", "toolUseId": "c1"}}}},
        {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"expression": "2+2"}'}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
        {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}, "metrics": {"latencyMs": 0}}},
    ]
    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_response_tool_use_with_thought_signature(gemini_client, model, messages, agenerator, alist):
    """Test that tool use responses with thought_signature include reasoningSignature."""
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[
                                genai.types.Part(
                                    function_call=genai.types.FunctionCall(
                                        args={"expression": "2+2"},
                                        id="c1",
                                        name="calculator",
                                    ),
                                    thought_signature=b"abc",
                                ),
                            ],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    tru_chunks = await alist(model.stream(messages))
    exp_chunks = [
        {"messageStart": {"role": "assistant"}},
        {
            "contentBlockStart": {
                "start": {
                    "toolUse": {"name": "calculator", "toolUseId": "c1", "reasoningSignature": "YWJj"},
                },
            },
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"expression": "2+2"}'}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
        {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}, "metrics": {"latencyMs": 0}}},
    ]
    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_response_reasoning(gemini_client, model, messages, agenerator, alist):
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[
                                genai.types.Part(
                                    text="test reason",
                                    thought=True,
                                    thought_signature=b"abc",
                                ),
                            ],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    tru_chunks = await alist(model.stream(messages))
    exp_chunks = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "test reason"}}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"signature": "YWJj"}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
        {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}, "metrics": {"latencyMs": 0}}},
    ]
    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_response_reasoning_signature_survives_aggregation(
    gemini_client, model, messages, agenerator, alist
):
    """Test that a thought signature round-trips from the stream back into a request part.

    Guarantees that a signed thought part keeps its signature through stream aggregation, so the
    signature Gemini requires on a subsequent turn is the one it originally issued.
    """
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[
                                genai.types.Part(
                                    text="test reason",
                                    thought=True,
                                    thought_signature=b"abc",
                                ),
                            ],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    stream = strands.event_loop.streaming.process_stream(model.stream(messages))
    events = await alist(stream)
    message = events[-1]["stop"][1]

    tru_reasoning = message["content"][0]["reasoningContent"]["reasoningText"]
    exp_reasoning = {"text": "test reason", "signature": "YWJj"}
    assert tru_reasoning == exp_reasoning

    # The reasoning text must still reach consumers as its own stream event.
    tru_reasoning_text = [event["reasoningText"] for event in events if "reasoningText" in event]
    exp_reasoning_text = ["test reason"]
    assert tru_reasoning_text == exp_reasoning_text

    # Feeding the aggregated message back must reproduce the original signature bytes.
    tru_part = model._format_request_content_part(message["content"][0], {})
    assert tru_part.thought_signature == b"abc"


@pytest.mark.asyncio
async def test_stream_response_reasoning_signature_on_empty_text_part_survives(
    gemini_client, model, messages, agenerator, alist
):
    """Test that a signature arriving on a separate empty-text part still round-trips.

    Gemini can attach the thought signature to a trailing part that carries no text of its own.
    Gating the signature emission on part.text drops it, so the signature the model requires on a
    subsequent turn is lost.
    """
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[
                                genai.types.Part(text="test reason", thought=True),
                                genai.types.Part(thought=True, thought_signature=b"abc"),
                            ],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    stream = strands.event_loop.streaming.process_stream(model.stream(messages))
    events = await alist(stream)
    message = events[-1]["stop"][1]

    tru_reasoning = message["content"][0]["reasoningContent"]["reasoningText"]
    exp_reasoning = {"text": "test reason", "signature": "YWJj"}
    assert tru_reasoning == exp_reasoning

    # Feeding the aggregated message back must reproduce the original signature bytes.
    tru_part = model._format_request_content_part(message["content"][0], {})
    assert tru_part.thought_signature == b"abc"


@pytest.mark.asyncio
async def test_stream_response_signature_after_text_opens_reasoning_block(
    gemini_client, model, messages, agenerator, alist
):
    """Test that a signature arriving after a text part closes it and opens a reasoning block.

    The signature part is not itself text, so the open text block has to be closed before the
    signature can be emitted; otherwise the signature delta would land inside the text block and
    the round-trip would lose it.
    """
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[
                                genai.types.Part(text="hello"),
                                genai.types.Part(thought=True, thought_signature=b"abc"),
                            ],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    stream = strands.event_loop.streaming.process_stream(model.stream(messages))
    events = await alist(stream)
    message = events[-1]["stop"][1]

    tru_content = message["content"]
    exp_content = [
        {"text": "hello"},
        {"reasoningContent": {"reasoningText": {"text": "", "signature": "YWJj"}}},
    ]
    assert tru_content == exp_content

    # Feeding the aggregated message back must reproduce the original signature bytes.
    tru_part = model._format_request_content_part(message["content"][1], {})
    assert tru_part.thought_signature == b"abc"


@pytest.mark.asyncio
async def test_stream_response_signature_only_part_opens_reasoning_block(
    gemini_client, model, messages, agenerator, alist
):
    """Test that a candidate whose only part carries a signature still emits a reasoning block.

    Nothing has opened a content block yet at that point, so the signature emission has to open one
    itself rather than assume a reasoning block is already in progress.
    """
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[genai.types.Part(thought=True, thought_signature=b"abc")],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    stream = strands.event_loop.streaming.process_stream(model.stream(messages))
    events = await alist(stream)
    message = events[-1]["stop"][1]

    tru_content = message["content"]
    exp_content = [{"reasoningContent": {"reasoningText": {"text": "", "signature": "YWJj"}}}]
    assert tru_content == exp_content

    # Feeding the aggregated message back must reproduce the original signature bytes.
    tru_part = model._format_request_content_part(message["content"][0], {})
    assert tru_part.thought_signature == b"abc"


@pytest.mark.asyncio
async def test_stream_response_reasoning_and_text(gemini_client, model, messages, agenerator, alist):
    """Test that both reasoning and text content are captured in separate blocks."""
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[
                                genai.types.Part(
                                    text="thinking about math",
                                    thought=True,
                                    thought_signature=b"sig1",
                                ),
                            ],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[
                                genai.types.Part(
                                    text="2 + 2 = 4",
                                    thought=False,
                                ),
                            ],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=5,
                ),
            ),
        ]
    )

    tru_chunks = await alist(model.stream(messages))
    exp_chunks = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "thinking about math"}}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"signature": "c2lnMQ=="}}}},
        {"contentBlockStop": {}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": "2 + 2 = 4"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
        {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 4, "totalTokens": 5}, "metrics": {"latencyMs": 0}}},
    ]
    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_response_max_tokens(gemini_client, model, messages, agenerator, alist):
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[genai.types.Part(text="test text")],
                        ),
                        finish_reason="MAX_TOKENS",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    tru_chunks = await alist(model.stream(messages))
    exp_chunks = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": "test text"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "max_tokens"}},
        {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}, "metrics": {"latencyMs": 0}}},
    ]
    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_response_safety_block_with_missing_counts(gemini_client, model, messages, agenerator, alist):
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        finish_reason="SAFETY",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=None,
                    total_token_count=None,
                ),
            ),
        ]
    )

    tru_chunks = await alist(model.stream(messages))
    exp_chunks = [
        {"messageStart": {"role": "assistant"}},
        {"messageStop": {"stopReason": "guardrail_intervened"}},
        {"metadata": {"usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}, "metrics": {"latencyMs": 0}}},
    ]
    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_response_none_candidates(gemini_client, model, messages, agenerator, alist):
    gemini_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=None,
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    tru_chunks = await alist(model.stream(messages))
    exp_chunks = [
        {"messageStart": {"role": "assistant"}},
        {"messageStop": {"stopReason": "end_turn"}},
        {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}, "metrics": {"latencyMs": 0}}},
    ]
    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_response_empty_stream(gemini_client, model, messages, agenerator, alist):
    """Test that empty stream doesn't raise UnboundLocalError.

    When the stream yields no events, the candidate variable must be initialized
    to None to avoid UnboundLocalError when referenced in message_stop chunk.
    """
    gemini_client.aio.models.generate_content_stream.return_value = agenerator([])

    tru_chunks = await alist(model.stream(messages))
    exp_chunks = [
        {"messageStart": {"role": "assistant"}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]
    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_response_throttled_exception(gemini_client, model, messages):
    """Regression test for https://github.com/strands-agents/harness-sdk/issues/3226.

    Vertex AI returns 429s whose message is plain text rather than a JSON document; the status
    attribute alone must be enough to classify them as throttling.
    """
    gemini_client.aio.models.generate_content_stream.side_effect = genai.errors.ClientError(
        429, {"error": {"status": "RESOURCE_EXHAUSTED", "message": "Resource exhausted. Please try again later."}}
    )

    with pytest.raises(ModelThrottledException, match="Resource exhausted. Please try again later."):
        await anext(model.stream(messages))


@pytest.mark.asyncio
async def test_stream_response_context_overflow_exception(gemini_client, model, messages):
    gemini_client.aio.models.generate_content_stream.side_effect = genai.errors.ClientError(
        400,
        {
            "error": {
                "message": "request exceeds the maximum number of tokens (100)",
                "status": "INVALID_ARGUMENT",
            },
        },
    )

    with pytest.raises(ContextWindowOverflowException, match="exceeds the maximum number of tokens"):
        await anext(model.stream(messages))


@pytest.mark.asyncio
async def test_stream_response_client_exception(gemini_client, model, messages):
    gemini_client.aio.models.generate_content_stream.side_effect = genai.errors.ClientError(500, {"status": "INTERNAL"})

    with pytest.raises(genai.errors.ClientError, match="INTERNAL"):
        await anext(model.stream(messages))


@pytest.mark.asyncio
async def test_structured_output(gemini_client, model, messages, model_id, weather_output):
    gemini_client.aio.models.generate_content.return_value = unittest.mock.Mock(parsed=weather_output.model_dump())

    tru_response = await anext(model.structured_output(type(weather_output), messages))
    exp_response = {"output": weather_output}
    assert tru_response == exp_response

    exp_request = {
        "config": {
            "response_mime_type": "application/json",
            "response_schema": weather_output.model_json_schema(),
        },
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content.assert_called_with(**exp_request)


def test_gemini_tools_validation_rejects_function_declarations(model_id):
    tool_with_function_declarations = genai.types.Tool(
        function_declarations=[
            genai.types.FunctionDeclaration(
                name="test_function",
                description="A test function",
            )
        ]
    )

    with pytest.raises(ValueError, match="gemini_tools should not contain FunctionDeclarations"):
        GeminiModel(model_id=model_id, gemini_tools=[tool_with_function_declarations])


def test_gemini_tools_validation_allows_non_function_tools(model_id):
    tool_with_google_search = genai.types.Tool(google_search=genai.types.GoogleSearch())

    model = GeminiModel(model_id=model_id, gemini_tools=[tool_with_google_search])
    assert "gemini_tools" in model.config


def test_gemini_tools_validation_on_update_config(model):
    tool_with_function_declarations = genai.types.Tool(
        function_declarations=[
            genai.types.FunctionDeclaration(
                name="test_function",
                description="A test function",
            )
        ]
    )

    with pytest.raises(ValueError, match="gemini_tools should not contain FunctionDeclarations"):
        model.update_config(gemini_tools=[tool_with_function_declarations])


@pytest.mark.asyncio
async def test_stream_request_with_gemini_tools(gemini_client, messages, model_id):
    google_search_tool = genai.types.Tool(google_search=genai.types.GoogleSearch())
    model = GeminiModel(model_id=model_id, gemini_tools=[google_search_tool])

    await anext(model.stream(messages))

    exp_request = {
        "config": {
            "tools": [
                {"function_declarations": []},
                {"google_search": {}},
            ]
        },
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_gemini_tools_and_function_tools(gemini_client, messages, tool_spec, model_id):
    code_execution_tool = genai.types.Tool(code_execution=genai.types.ToolCodeExecution())
    model = GeminiModel(model_id=model_id, gemini_tools=[code_execution_tool])

    await anext(model.stream(messages, tool_specs=[tool_spec]))

    exp_request = {
        "config": {
            "tools": [
                {
                    "function_declarations": [
                        {
                            "description": tool_spec["description"],
                            "name": tool_spec["name"],
                            "parameters_json_schema": tool_spec["inputSchema"]["json"],
                        }
                    ]
                },
                {"code_execution": {}},
            ]
        },
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.parametrize(
    ("tool_choice", "exp_function_calling_config"),
    [
        ({"auto": {}}, {"mode": "AUTO"}),
        ({"any": {}}, {"mode": "ANY"}),
        ({"tool": {"name": "name"}}, {"allowed_function_names": ["name"], "mode": "ANY"}),
    ],
)
@pytest.mark.asyncio
async def test_stream_request_with_tool_choice(
    gemini_client, model, messages, tool_spec, model_id, tool_choice, exp_function_calling_config
):
    await anext(model.stream(messages, tool_specs=[tool_spec], tool_choice=tool_choice))

    exp_request = {
        "config": {
            "tools": [
                {
                    "function_declarations": [
                        {
                            "description": tool_spec["description"],
                            "name": tool_spec["name"],
                            "parameters_json_schema": tool_spec["inputSchema"]["json"],
                        }
                    ]
                }
            ],
            "tool_config": {"function_calling_config": exp_function_calling_config},
        },
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_request_with_tool_choice_and_no_tool_specs(gemini_client, model, messages, model_id):
    await anext(model.stream(messages, tool_choice={"any": {}}))

    exp_request = {
        "config": {},
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.fixture
def tool_config_param_model(gemini_client, model_id):
    _ = gemini_client

    tool_config = genai.types.ToolConfig(
        function_calling_config=genai.types.FunctionCallingConfig(
            mode=genai.types.FunctionCallingConfigMode.NONE,
            allowed_function_names=["safe_tool"],
        ),
        # A full tool config, so the assertions below pin that a tool choice leaves all of it in place.
        retrieval_config=genai.types.RetrievalConfig(language_code="en-GB"),
    )
    return GeminiModel(model_id=model_id, params={"tool_config": tool_config})


@pytest.mark.parametrize(
    "tool_choice",
    [None, {"auto": {}}, {"any": {}}, {"tool": {"name": "name"}}],
    ids=["no-choice", "auto", "any", "tool"],
)
@pytest.mark.asyncio
async def test_stream_request_tool_config_param_takes_precedence(
    gemini_client, tool_config_param_model, messages, tool_spec, model_id, tool_choice
):
    """An explicit tool config wins over any per-request choice, matching the other providers."""
    await anext(tool_config_param_model.stream(messages, tool_specs=[tool_spec], tool_choice=tool_choice))

    exp_request = {
        "config": {
            "tools": [
                {
                    "function_declarations": [
                        {
                            "description": tool_spec["description"],
                            "name": tool_spec["name"],
                            "parameters_json_schema": tool_spec["inputSchema"]["json"],
                        }
                    ]
                }
            ],
            "tool_config": {
                "function_calling_config": {"mode": "NONE", "allowed_function_names": ["safe_tool"]},
                "retrieval_config": {"language_code": "en-GB"},
            },
        },
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_tool_config_param_set_to_none_still_takes_precedence(
    gemini_client, messages, tool_spec, model_id
):
    """Params owns the key, so an explicit None keeps a tool choice out of the request.

    Matches the sibling providers, which spread params last and therefore let an explicit None win.
    """
    model = GeminiModel(model_id=model_id, params={"tool_config": None})

    await anext(model.stream(messages, tool_specs=[tool_spec], tool_choice={"any": {}}))

    exp_request = {
        "config": {
            "tools": [
                {
                    "function_declarations": [
                        {
                            "description": tool_spec["description"],
                            "name": tool_spec["name"],
                            "parameters_json_schema": tool_spec["inputSchema"]["json"],
                        }
                    ]
                }
            ],
        },
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


@pytest.mark.asyncio
async def test_stream_tool_choice_does_not_persist_into_the_next_request(gemini_client, messages, tool_spec, model_id):
    """A tool choice configures its own request only, so it never lands in the model's own params."""
    model = GeminiModel(model_id=model_id, params={"temperature": 0.5})

    await anext(model.stream(messages, tool_specs=[tool_spec], tool_choice={"any": {}}))
    await anext(model.stream(messages, tool_specs=[tool_spec]))

    exp_request = {
        "config": {
            "temperature": 0.5,
            "tools": [
                {
                    "function_declarations": [
                        {
                            "description": tool_spec["description"],
                            "name": tool_spec["name"],
                            "parameters_json_schema": tool_spec["inputSchema"]["json"],
                        }
                    ]
                }
            ],
        },
        "contents": [{"parts": [{"text": "test"}], "role": "user"}],
        "model": model_id,
    }
    gemini_client.aio.models.generate_content_stream.assert_called_with(**exp_request)


def test_format_tool_choice_unrecognized_strategy(model):
    tru_tool_config = model._format_tool_choice({"unrecognized": {}})
    exp_tool_config = None
    assert tru_tool_config == exp_tool_config


@pytest.mark.asyncio
async def test_stream_tool_choice_no_warning(model, messages, tool_spec, captured_warnings):
    await anext(model.stream(messages, tool_specs=[tool_spec], tool_choice={"auto": {}}))

    assert len(captured_warnings) == 0


@pytest.mark.asyncio
async def test_stream_handles_non_json_error(gemini_client, model, messages, alist):
    error_message = "Invalid API key"
    gemini_client.aio.models.generate_content_stream.side_effect = genai.errors.ClientError(
        400, {"error": {"message": error_message}}
    )

    with pytest.raises(genai.errors.ClientError, match=error_message):
        await alist(model.stream(messages))


@pytest.mark.asyncio
async def test_stream_with_injected_client(model_id, agenerator, alist):
    """Test that stream works with an injected client and doesn't close it."""
    # Create a mock injected client
    mock_injected_client = unittest.mock.Mock()
    mock_injected_client.aio = unittest.mock.AsyncMock()

    mock_injected_client.aio.models.generate_content_stream.return_value = agenerator(
        [
            genai.types.GenerateContentResponse(
                candidates=[
                    genai.types.Candidate(
                        content=genai.types.Content(
                            parts=[genai.types.Part(text="Hello")],
                        ),
                        finish_reason="STOP",
                    ),
                ],
                usage_metadata=genai.types.GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    total_token_count=3,
                ),
            ),
        ]
    )

    # Create model with injected client
    model = GeminiModel(client=mock_injected_client, model_id=model_id)

    messages = [{"role": "user", "content": [{"text": "test"}]}]
    response = model.stream(messages)
    tru_events = await alist(response)

    # Verify events were generated
    assert len(tru_events) > 0

    # Verify the injected client was used
    mock_injected_client.aio.models.generate_content_stream.assert_called_once()


@pytest.mark.asyncio
async def test_structured_output_with_injected_client(model_id, weather_output, alist):
    """Test that structured_output works with an injected client and doesn't close it."""
    # Create a mock injected client
    mock_injected_client = unittest.mock.Mock()
    mock_injected_client.aio = unittest.mock.AsyncMock()

    mock_injected_client.aio.models.generate_content.return_value = unittest.mock.Mock(
        parsed=weather_output.model_dump()
    )

    # Create model with injected client
    model = GeminiModel(client=mock_injected_client, model_id=model_id)

    messages = [{"role": "user", "content": [{"text": "Generate weather"}]}]
    stream = model.structured_output(type(weather_output), messages)
    events = await alist(stream)

    # Verify output was generated
    assert len(events) == 1
    assert events[0] == {"output": weather_output}

    # Verify the injected client was used
    mock_injected_client.aio.models.generate_content.assert_called_once()


def test_init_with_both_client_and_client_args_raises_error():
    """Test that providing both client and client_args raises ValueError."""
    mock_client = unittest.mock.Mock()

    with pytest.raises(ValueError, match="Only one of 'client' or 'client_args' should be provided"):
        GeminiModel(client=mock_client, client_args={"api_key": "test"}, model_id="test-model")


def test_format_request_filters_s3_source_image(model, caplog):
    """Test that images with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.gemini")

    messages = [
        {
            "role": "user",
            "content": [
                {"text": "look at this image"},
                {
                    "image": {
                        "format": "png",
                        "source": {"location": {"type": "s3", "uri": "s3://my-bucket/image.png"}},
                    },
                },
            ],
        },
    ]

    request = model._format_request(messages, None, None, None)

    # Image with S3 source should be filtered, text should remain
    formatted_content = request["contents"][0]["parts"]
    assert len(formatted_content) == 1
    assert "text" in formatted_content[0]
    assert "Location sources are not supported by Gemini" in caplog.text


def test_format_request_skips_message_cache_point(model, caplog):
    caplog.set_level(logging.WARNING, logger="strands.models.gemini")

    messages = [{"role": "user", "content": [{"text": "durable prefix"}, {"cachePoint": {"type": "default"}}]}]

    request = model._format_request(messages, None, None, None)

    assert request["contents"][0]["parts"] == [{"text": "durable prefix"}]
    assert "cachePoint content block is not supported by Gemini" in caplog.text


def test_format_request_filters_location_source_document(model, caplog):
    """Test that documents with Location sources are filtered out with warning."""
    caplog.set_level(logging.WARNING, logger="strands.models.gemini")

    messages = [
        {
            "role": "user",
            "content": [
                {"text": "analyze this document"},
                {
                    "document": {
                        "format": "pdf",
                        "name": "report.pdf",
                        "source": {"location": {"type": "s3", "uri": "s3://my-bucket/report.pdf"}},
                    },
                },
                {
                    "document": {
                        "format": "pdf",
                        "name": "report.pdf",
                        "source": {"location": {"type": "s3", "uri": "s3://my-bucket/report.pdf"}},
                    },
                },
            ],
        },
    ]

    request = model._format_request(messages, None, None, None)

    # Document with S3 source should be filtered, text should remain
    formatted_content = request["contents"][0]["parts"]
    assert len(formatted_content) == 1
    assert "text" in formatted_content[0]
    assert "Location sources are not supported by Gemini" in caplog.text


class TestCountTokens:
    """Tests for GeminiModel.count_tokens native token counting."""

    @pytest.fixture
    def gemini_client(self):
        with unittest.mock.patch.object(strands.models.gemini.genai, "Client") as mock_client_cls:
            mock_client = mock_client_cls.return_value
            mock_client.aio = unittest.mock.AsyncMock()
            yield mock_client

    @pytest.fixture
    def model(self, gemini_client):
        _ = gemini_client
        return GeminiModel(model_id="m1", use_native_token_count=True)

    @pytest.fixture
    def messages(self):
        return [{"role": "user", "content": [{"text": "hello"}]}]

    @pytest.fixture
    def tool_specs(self):
        return [
            {
                "name": "test_tool",
                "description": "A test tool",
                "inputSchema": {"json": {"type": "object", "properties": {}}},
            }
        ]

    @pytest.mark.asyncio
    async def test_native_count_tokens_success(self, model, gemini_client, messages):
        mock_response = unittest.mock.AsyncMock()
        mock_response.total_tokens = 42
        gemini_client.aio.models.count_tokens.return_value = mock_response

        result = await model.count_tokens(messages=messages)

        assert result == 42
        gemini_client.aio.models.count_tokens.assert_called_once()

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_system_prompt(self, model, gemini_client, messages):
        mock_response = unittest.mock.AsyncMock()
        mock_response.total_tokens = 55
        gemini_client.aio.models.count_tokens.return_value = mock_response

        result = await model.count_tokens(messages=messages, system_prompt="Be helpful.")

        assert result > 55  # native (55) + heuristic estimate for system_prompt

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_tool_specs(self, model, gemini_client, messages, tool_specs):
        mock_response = unittest.mock.AsyncMock()
        mock_response.total_tokens = 100
        gemini_client.aio.models.count_tokens.return_value = mock_response

        result = await model.count_tokens(messages=messages, tool_specs=tool_specs)

        assert result > 100  # native (100) + heuristic estimate for tool_specs

    @pytest.mark.asyncio
    async def test_fallback_on_none_total_tokens(self, model, gemini_client, messages):
        mock_response = unittest.mock.AsyncMock()
        mock_response.total_tokens = None
        gemini_client.aio.models.count_tokens.return_value = mock_response

        result = await model.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_on_api_error(self, model, gemini_client, messages):
        gemini_client.aio.models.count_tokens.side_effect = genai.errors.ClientError("Unsupported", response_json={})

        result = await model.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_on_generic_exception(self, model, gemini_client, messages):
        gemini_client.aio.models.count_tokens.side_effect = RuntimeError("Connection failed")

        result = await model.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_logs_debug(self, model, gemini_client, messages, caplog):
        gemini_client.aio.models.count_tokens.side_effect = RuntimeError("API down")

        with caplog.at_level(logging.DEBUG, logger="strands.models.gemini"):
            await model.count_tokens(messages=messages)

        assert any("native token counting failed" in record.message for record in caplog.records)

    @pytest.mark.asyncio
    async def test_skip_native_api_when_use_native_token_count_false(self, gemini_client, messages):
        _ = gemini_client
        model = GeminiModel(model_id="m1", use_native_token_count=False)

        result = await model.count_tokens(messages=messages)

        gemini_client.aio.models.count_tokens.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_skip_native_api_by_default(self, gemini_client, messages):
        _ = gemini_client
        model = GeminiModel(model_id="m1")

        result = await model.count_tokens(messages=messages)

        gemini_client.aio.models.count_tokens.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0
