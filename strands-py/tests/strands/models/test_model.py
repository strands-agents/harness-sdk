import json
import math
from unittest.mock import MagicMock

import pytest
from pydantic import BaseModel

from strands.hooks.events import AfterInvocationEvent
from strands.models import CacheConfig
from strands.models import Model as SAModel
from strands.models.model import _ModelPlugin


class Person(BaseModel):
    name: str
    age: int


class TestModel(SAModel):
    def update_config(self, **model_config):
        return model_config

    def get_config(self):
        return

    async def structured_output(self, output_model, prompt=None, system_prompt=None, **kwargs):
        yield {"output": output_model(name="test", age=20)}

    async def stream(self, messages, tool_specs=None, system_prompt=None):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": f"Processed {len(messages)} messages"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 10, "outputTokens": 15, "totalTokens": 25},
                "metrics": {"latencyMs": 100},
            }
        }


@pytest.fixture
def model():
    return TestModel()


@pytest.fixture
def messages():
    return [
        {
            "role": "user",
            "content": [{"text": "hello"}],
        },
    ]


@pytest.fixture
def tool_specs():
    return [
        {
            "name": "test_tool",
            "description": "A test tool",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "input": {"type": "string"},
                    },
                    "required": ["input"],
                },
            },
        },
    ]


@pytest.fixture
def model_plugin():
    return _ModelPlugin()


@pytest.fixture
def system_prompt():
    return "s1"


@pytest.mark.asyncio
async def test_stream(model, messages, tool_specs, system_prompt, alist):
    response = model.stream(messages, tool_specs, system_prompt)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": "Processed 1 messages"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
        {
            "metadata": {
                "usage": {"inputTokens": 10, "outputTokens": 15, "totalTokens": 25},
                "metrics": {"latencyMs": 100},
            }
        },
    ]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_structured_output(model, messages, system_prompt, alist):
    response = model.structured_output(Person, prompt=messages, system_prompt=system_prompt)
    events = await alist(response)

    tru_output = events[-1]["output"]
    exp_output = Person(name="test", age=20)
    assert tru_output == exp_output


@pytest.mark.asyncio
async def test_stream_without_tool_choice_parameter(messages, alist):
    """Test that model implementations without tool_choice parameter are still valid."""

    class LegacyModel(SAModel):
        def update_config(self, **model_config):
            return model_config

        def get_config(self):
            return

        async def structured_output(self, output_model, prompt=None, system_prompt=None, **kwargs):
            yield {"output": output_model(name="test", age=20)}

        async def stream(self, messages, tool_specs=None, system_prompt=None):
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockDelta": {"delta": {"text": "Legacy model works"}}}
            yield {"messageStop": {"stopReason": "end_turn"}}

    model = LegacyModel()
    response = model.stream(messages)
    events = await alist(response)

    assert len(events) == 3
    assert events[1]["contentBlockDelta"]["delta"]["text"] == "Legacy model works"


@pytest.mark.asyncio
async def test_stream_with_tool_choice_parameter(messages, tool_specs, system_prompt, alist):
    """Test that model can accept tool_choice parameter."""

    class ModernModel(SAModel):
        def update_config(self, **model_config):
            return model_config

        def get_config(self):
            return

        async def structured_output(self, output_model, prompt=None, system_prompt=None, **kwargs):
            yield {"output": output_model(name="test", age=20)}

        async def stream(self, messages, tool_specs=None, system_prompt=None, *, tool_choice=None, **kwargs):
            yield {"messageStart": {"role": "assistant"}}
            if tool_choice:
                yield {"contentBlockDelta": {"delta": {"text": f"Tool choice: {tool_choice}"}}}
            else:
                yield {"contentBlockDelta": {"delta": {"text": "No tool choice"}}}
            yield {"messageStop": {"stopReason": "end_turn"}}

    model = ModernModel()

    # Test with tool_choice="auto"
    response = model.stream(messages, tool_specs, system_prompt, tool_choice="auto")
    events = await alist(response)
    assert events[1]["contentBlockDelta"]["delta"]["text"] == "Tool choice: auto"

    # Test with tool_choice="any"
    response = model.stream(messages, tool_specs, system_prompt, tool_choice="any")
    events = await alist(response)
    assert events[1]["contentBlockDelta"]["delta"]["text"] == "Tool choice: any"

    # Test with tool_choice={"type": "tool", "name": "test_tool"}
    response = model.stream(messages, tool_specs, system_prompt, tool_choice={"tool": {"name": "SampleModel"}})
    events = await alist(response)
    assert events[1]["contentBlockDelta"]["delta"]["text"] == "Tool choice: {'tool': {'name': 'SampleModel'}}"

    # Test without tool_choice
    response = model.stream(messages, tool_specs, system_prompt)
    events = await alist(response)
    assert events[1]["contentBlockDelta"]["delta"]["text"] == "No tool choice"


def test_context_window_limit_from_dict_config():
    class DictConfigModel(SAModel):
        def update_config(self, **model_config):
            pass

        def get_config(self):
            return {"context_window_limit": 200_000}

        async def structured_output(self, output_model, prompt=None, system_prompt=None, **kwargs):
            yield {}

        async def stream(self, messages, tool_specs=None, system_prompt=None):
            yield {}

    assert DictConfigModel().context_window_limit == 200_000


def test_context_window_limit_none_when_not_configured(model):
    assert model.context_window_limit is None


def test_stateful_false(model):
    """Model.stateful defaults to False."""
    assert not model.stateful


def test_model_plugin_clears_messages_when_stateful(model_plugin):
    """Messages are cleared when model is stateful."""
    agent = MagicMock()
    agent.model.stateful = True
    agent._model_state = {"response_id": "resp_123"}
    agent.messages = [{"role": "user", "content": [{"text": "hello"}]}]

    event = AfterInvocationEvent(agent=agent, invocation_state={})
    model_plugin._on_after_invocation(event)

    assert agent.messages == []


def test_model_plugin_preserves_messages_when_not_stateful(model_plugin):
    """Messages are preserved when model is not stateful."""
    agent = MagicMock()
    agent.model.stateful = False
    agent._model_state = {}
    agent.messages = [{"role": "user", "content": [{"text": "hello"}]}]

    event = AfterInvocationEvent(agent=agent, invocation_state={})
    model_plugin._on_after_invocation(event)

    assert len(agent.messages) == 1


@pytest.mark.asyncio
async def test_count_tokens_empty_messages(model):
    assert await model.count_tokens(messages=[]) == 0


@pytest.mark.asyncio
async def test_count_tokens_system_prompt_only(model):
    result = await model.count_tokens(messages=[], system_prompt="You are a helpful assistant.")
    assert result == 7  # ceil(28/4)


@pytest.mark.asyncio
async def test_count_tokens_text_messages(model, messages):
    result = await model.count_tokens(messages=messages)
    assert result == 2  # ceil(5/4)


@pytest.mark.asyncio
async def test_count_tokens_with_tool_specs(model, messages, tool_specs):
    without_tools = await model.count_tokens(messages=messages)
    with_tools = await model.count_tokens(messages=messages, tool_specs=tool_specs)
    assert without_tools == 2  # ceil(5/4)
    assert with_tools == 84  # ceil(5/4) + ceil(164/2)


@pytest.mark.asyncio
async def test_count_tokens_with_system_prompt(model, messages, system_prompt):
    without_prompt = await model.count_tokens(messages=messages)
    with_prompt = await model.count_tokens(messages=messages, system_prompt=system_prompt)
    assert without_prompt == 2  # ceil(5/4)
    assert with_prompt == 3  # ceil(5/4) + ceil(2/4)


@pytest.mark.asyncio
async def test_count_tokens_combined(model, messages, tool_specs, system_prompt):
    result = await model.count_tokens(messages=messages, tool_specs=tool_specs, system_prompt=system_prompt)
    assert result == 85  # ceil(5/4) + ceil(164/2) + ceil(2/4)


@pytest.mark.asyncio
async def test_count_tokens_tool_use_block(model):
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "123",
                        "name": "my_tool",
                        "input": {"query": "test"},
                    }
                }
            ],
        }
    ]
    result = await model.count_tokens(messages=messages)
    # name "my_tool" ceil(7/4)=2 + json.dumps(input) ceil(17/2)=9 = 11
    assert result == 11


@pytest.mark.asyncio
async def test_count_tokens_tool_result_block(model):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "123",
                        "content": [{"text": "tool output here"}],
                        "status": "success",
                    }
                }
            ],
        }
    ]
    result = await model.count_tokens(messages=messages)
    assert result == 4  # ceil(16/4)


@pytest.mark.asyncio
async def test_count_tokens_tool_result_with_json(model):
    obj = {"x": "lorem ipsum " * 1000}
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "123",
                        "content": [{"json": obj}],
                        "status": "success",
                    }
                }
            ],
        }
    ]
    result = await model.count_tokens(messages=messages)
    assert result == math.ceil(len(json.dumps(obj)) / 2)
    assert result > 0


@pytest.mark.asyncio
async def test_count_tokens_tool_result_with_text_and_json(model):
    text = "Here is the data"
    obj = {"key": "value", "count": 42}
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "123",
                        "content": [
                            {"text": text},
                            {"json": obj},
                        ],
                        "status": "success",
                    }
                }
            ],
        }
    ]
    result = await model.count_tokens(messages=messages)
    assert result == math.ceil(len(text) / 4) + math.ceil(len(json.dumps(obj)) / 2)


@pytest.mark.asyncio
async def test_count_tokens_reasoning_block(model):
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "reasoningContent": {
                        "reasoningText": {
                            "text": "Let me think about this step by step.",
                        }
                    }
                }
            ],
        }
    ]
    result = await model.count_tokens(messages=messages)
    assert result == 10  # ceil(37/4)


@pytest.mark.asyncio
async def test_count_tokens_skips_binary_content(model):
    messages = [
        {
            "role": "user",
            "content": [{"image": {"format": "png", "source": {"bytes": b"fake image data"}}}],
        }
    ]
    assert await model.count_tokens(messages=messages) == 0


@pytest.mark.asyncio
async def test_count_tokens_tool_result_with_bytes_only(model):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "123",
                        "content": [{"image": {"format": "png", "source": {"bytes": b"image data"}}}],
                        "status": "success",
                    }
                }
            ],
        }
    ]
    result = await model.count_tokens(messages=messages)
    assert result == 0


@pytest.mark.asyncio
async def test_count_tokens_tool_result_with_text_and_bytes(model):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "123",
                        "content": [
                            {"text": "Here is the screenshot"},
                            {"image": {"format": "png", "source": {"bytes": b"image data"}}},
                        ],
                        "status": "success",
                    }
                }
            ],
        }
    ]
    result = await model.count_tokens(messages=messages)
    assert result > 0


@pytest.mark.asyncio
async def test_count_tokens_guard_content_block(model):
    messages = [
        {
            "role": "assistant",
            "content": [{"guardContent": {"text": {"text": "This content was filtered by guardrails."}}}],
        }
    ]
    result = await model.count_tokens(messages=messages)
    assert result == 10  # ceil(40/4)


@pytest.mark.asyncio
async def test_count_tokens_tool_use_with_bytes(model):
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "123",
                        "name": "my_tool",
                        "input": {"data": b"binary data"},
                    }
                }
            ],
        }
    ]
    result = await model.count_tokens(messages=messages)
    # Should still count the tool name even though input has non-serializable bytes
    assert result == 2  # ceil(7/4) name only


@pytest.mark.asyncio
async def test_count_tokens_non_serializable_tool_spec(model, messages):
    tool_specs = [
        {
            "name": "test",
            "description": "a tool",
            "inputSchema": {"json": {"default": b"bytes"}},
        }
    ]
    result = await model.count_tokens(messages=messages, tool_specs=tool_specs)
    # Should still count the message tokens even though tool spec fails
    assert result == 2  # ceil(5/4) only, tool spec skipped


@pytest.mark.asyncio
async def test_count_tokens_citations_block(model):
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "citationsContent": {
                        "content": [{"text": "According to the document, the answer is 42."}],
                        "citations": [],
                    }
                }
            ],
        }
    ]
    result = await model.count_tokens(messages=messages)
    assert result == 11  # ceil(44/4)


@pytest.mark.asyncio
async def test_count_tokens_system_prompt_content(model):
    result = await model.count_tokens(
        messages=[],
        system_prompt_content=[{"text": "You are a helpful assistant."}],
    )
    assert result == 7  # ceil(28/4)


@pytest.mark.asyncio
async def test_count_tokens_system_prompt_content_with_cache_point(model):
    result = await model.count_tokens(
        messages=[],
        system_prompt_content=[
            {"text": "You are a helpful assistant."},
            {"cachePoint": {"type": "default"}},
        ],
    )
    assert result == 7  # ceil(28/4), cachePoint adds 0


@pytest.mark.asyncio
async def test_count_tokens_system_prompt_content_takes_priority(model):
    content_only = await model.count_tokens(
        messages=[],
        system_prompt_content=[{"text": "Short."}],
    )
    # When both are provided, system_prompt_content wins — system_prompt is ignored
    both = await model.count_tokens(
        messages=[],
        system_prompt="This is a much longer system prompt that should have more tokens.",
        system_prompt_content=[{"text": "Short."}],
    )
    assert content_only == 2  # ceil(6/4)
    assert content_only == both


@pytest.mark.asyncio
async def test_count_tokens_all_inputs(model):
    messages = [
        {"role": "user", "content": [{"text": "hello world"}]},
        {"role": "assistant", "content": [{"text": "hi there"}]},
    ]
    result = await model.count_tokens(
        messages=messages,
        tool_specs=[{"name": "test", "description": "a test tool", "inputSchema": {"json": {}}}],
        system_prompt="Be helpful.",
        system_prompt_content=[{"text": "Additional system context."}],
    )
    # system_prompt_content (7) + "hello world" (3) + "hi there" (2) + tool_spec (38) = 50
    assert result == 50


class TestHeuristicEstimation:
    """Tests for _estimate_tokens_with_heuristic."""

    def test_all_content_types(self):
        """One call covering text, toolUse, toolResult, reasoning, guard, citations, system prompt, tool specs."""
        from strands.models.model import _estimate_tokens_with_heuristic

        messages = [
            {"role": "user", "content": [{"text": "hello world!"}]},
            {
                "role": "assistant",
                "content": [
                    {"toolUse": {"toolUseId": "1", "name": "my_tool", "input": {"q": "test"}}},
                    {"reasoningContent": {"reasoningText": {"text": "Let me think."}}},
                    {"guardContent": {"text": {"text": "Filtered."}}},
                    {"citationsContent": {"content": [{"text": "Citation."}]}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"toolResult": {"toolUseId": "1", "content": [{"text": "tool output here"}]}},
                ],
            },
        ]
        result = _estimate_tokens_with_heuristic(
            messages=messages,
            tool_specs=[{"name": "test", "description": "a tool"}],
            system_prompt="ignored",
            system_prompt_content=[{"text": "Be helpful."}],
        )
        assert result > 0

    def test_non_serializable_inputs(self):
        """Heuristic gracefully handles non-serializable tool input and tool specs."""
        from strands.models.model import _estimate_tokens_with_heuristic

        result = _estimate_tokens_with_heuristic(
            messages=[
                {
                    "role": "assistant",
                    "content": [
                        {"toolUse": {"toolUseId": "1", "name": "my_tool", "input": {"data": b"bytes"}}},
                    ],
                },
            ],
            tool_specs=[{"name": "t", "inputSchema": {"json": {"default": b"bytes"}}}],
        )
        assert result == 2  # only tool name counted: ceil(len("my_tool") / 4)

    @pytest.mark.asyncio
    async def test_model_uses_heuristic(self, model):
        """Model.count_tokens uses heuristic estimation."""
        result = await model.count_tokens(messages=[{"role": "user", "content": [{"text": "hello world!"}]}])
        assert result == 3  # ceil(12 / 4)


class TestEstimateUtilization:
    """Tests for Model.estimate_utilization."""

    class ConfigurableModel(SAModel):
        def __init__(self, context_window_limit=None):
            self._config = {"context_window_limit": context_window_limit}

        def update_config(self, **model_config):
            self._config.update(model_config)

        def get_config(self):
            return self._config

        async def structured_output(self, output_model, prompt=None, system_prompt=None, **kwargs):
            yield {}

        async def stream(self, messages, tool_specs=None, system_prompt=None):
            yield {}

    def test_returns_ratio_of_tokens_to_limit(self):
        """Returns input_tokens / context_window_limit when limit is configured."""
        model = self.ConfigurableModel(context_window_limit=100_000)

        assert model.estimate_utilization(50_000) == 0.5

    def test_uses_default_when_limit_not_set(self):
        """Falls back to DEFAULT_CONTEXT_WINDOW_LIMIT (200_000) when not configured."""
        model = self.ConfigurableModel(context_window_limit=None)

        assert model.estimate_utilization(100_000) == 100_000 / 200_000

    def test_returns_above_one_on_overflow(self):
        """Returns > 1.0 when tokens exceed the limit."""
        model = self.ConfigurableModel(context_window_limit=1000)

        assert model.estimate_utilization(1500) > 1.0

    def test_returns_zero_for_zero_tokens(self):
        """Returns 0 for zero input tokens."""
        model = self.ConfigurableModel(context_window_limit=100_000)

        assert model.estimate_utilization(0) == 0

    def test_handles_zero_context_window_limit(self):
        """Falls back to default when context_window_limit is 0."""
        model = self.ConfigurableModel(context_window_limit=0)

        assert model.estimate_utilization(100_000) == 100_000 / 200_000

    def test_warns_only_once(self):
        """Logs the fallback warning only on the first call."""
        model = self.ConfigurableModel(context_window_limit=None)

        model.estimate_utilization(1000)
        model.estimate_utilization(2000)

        assert model._utilization_limit_warned is True


class TestCacheConfig:
    """Tests for the CacheConfig dataclass."""

    def test_cache_key_defaults_to_none(self):
        """cache_key defaults to None."""
        assert CacheConfig().cache_key is None

    def test_cache_key_round_trips(self):
        """cache_key preserves the value it was constructed with."""
        assert CacheConfig(cache_key="tenant-42").cache_key == "tenant-42"
