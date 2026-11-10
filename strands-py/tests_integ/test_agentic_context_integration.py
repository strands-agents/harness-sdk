"""Integration tests for the agentic context manager with a real Bedrock model.

These tests validate end-to-end behavior of ``context_manager="agentic"``:

1. **Basic functionality** - the agent responds normally and works alongside user tools.
2. **Middleware injection** - the ``<context-status>`` block is injected into messages sent to
   the model (and only when agentic mode is enabled).
3. **Tool invocation** - the model can actually call summarize_context / truncate_context / pin.
4. **End-to-end coherence** - the agent stays coherent after compressing its own context.

They make real Bedrock API calls and rely on default AWS credential resolution.
"""

import pytest

import strands
from strands import Agent
from strands.models import BedrockModel
from strands.types.content import Messages


@pytest.fixture
def model():
    """Real Bedrock model for integration testing."""
    return BedrockModel(max_tokens=1024)


def _last_text(result) -> str:
    """Concatenate the text blocks of an agent result's final message."""
    return "".join(block.get("text", "") for block in result.message["content"])


def _has_context_status(messages: Messages) -> bool:
    """True if the last message carries a ``<context-status>`` text block."""
    if not messages:
        return False
    last = messages[-1]
    return any("<context-status>" in block.get("text", "") for block in last["content"])


class TestBasicFunctionality:
    def test_agent_responds_normally_with_agentic_enabled(self, model):
        agent = Agent(model=model, context_manager="agentic", callback_handler=None)

        result = agent("What is 2 + 2? Reply with just the number.")

        assert result.stop_reason == "end_turn"
        assert result.message["role"] == "assistant"
        assert "4" in _last_text(result)

    def test_works_alongside_user_defined_tools(self, model):
        @strands.tool
        def calculator(a: int, b: int) -> str:
            """Add two numbers."""
            return str(a + b)

        agent = Agent(model=model, context_manager="agentic", tools=[calculator], callback_handler=None)

        result = agent("Use the calculator tool to add 17 and 25.")

        assert result.stop_reason == "end_turn"
        has_calc_call = any(
            block.get("toolUse", {}).get("name") == "calculator" for msg in agent.messages for block in msg["content"]
        )
        assert has_calc_call


class TestMiddlewareContextInjection:
    def test_context_status_present_in_messages_sent_to_model(self, model):
        seen_messages: list[Messages] = []
        original_stream = model.stream

        def capturing_stream(messages, *args, **kwargs):
            seen_messages.append(messages)
            return original_stream(messages, *args, **kwargs)

        model.stream = capturing_stream

        agent = Agent(model=model, context_manager="agentic", callback_handler=None)
        agent("Say hi.")

        assert any(_has_context_status(messages) for messages in seen_messages)

    def test_context_status_contains_usage_and_remaining(self, model):
        seen_messages: list[Messages] = []
        original_stream = model.stream

        def capturing_stream(messages, *args, **kwargs):
            seen_messages.append(messages)
            return original_stream(messages, *args, **kwargs)

        model.stream = capturing_stream

        agent = Agent(model=model, context_manager="agentic", callback_handler=None)
        agent("Hello.")

        status_text = ""
        for messages in seen_messages:
            if not messages:
                continue
            for block in messages[-1]["content"]:
                if "<context-status>" in block.get("text", ""):
                    status_text = block["text"]
                    break
            if status_text:
                break

        assert "<used>" in status_text
        assert "<remaining>" in status_text
        assert "</context-status>" in status_text

    def test_context_status_not_injected_when_not_agentic(self, model):
        seen_messages: list[Messages] = []
        original_stream = model.stream

        def capturing_stream(messages, *args, **kwargs):
            seen_messages.append(messages)
            return original_stream(messages, *args, **kwargs)

        model.stream = capturing_stream

        agent = Agent(model=model, callback_handler=None)
        agent("Say hi.")

        assert not any(_has_context_status(messages) for messages in seen_messages)


class TestToolInvocationBehavior:
    def test_model_uses_summarize_context_when_asked(self, model):
        agent = Agent(
            model=model,
            context_manager="agentic",
            callback_handler=None,
            system_prompt=(
                "You are a helpful assistant. When the user asks you to compress or summarize "
                "context, use your summarize_context tool."
            ),
        )

        agent("Tell me about the solar system in 2 sentences.")
        agent("Tell me about the ocean in 2 sentences.")
        agent("Tell me about mountains in 2 sentences.")
        agent("Please use summarize_context to compress the older parts of our conversation.")

        has_summarize_call = any(
            block.get("toolUse", {}).get("name") == "summarize_context"
            for msg in agent.messages
            for block in msg["content"]
        )
        assert has_summarize_call

    @pytest.mark.timeout(120)
    def test_summarize_context_replaces_older_messages(self, model):
        agent = Agent(
            model=model,
            context_manager="agentic",
            callback_handler=None,
            system_prompt=(
                "When asked to compress, call summarize_context with keep_recent=2 and "
                "summary_ratio=0.6, then stop. Keep responses to 1 sentence."
            ),
        )

        agent("The sky is blue.")
        agent("Grass is green.")
        agent("Water is wet.")
        agent("Fire is hot.")
        agent("Ice is cold.")
        agent("Snow is white.")

        agent("Compress context using summarize_context with keep_recent=2 and summary_ratio=0.6.")

        has_original_grass_msg = any(
            msg["role"] == "user" and any(block.get("text") == "Grass is green." for block in msg["content"])
            for msg in agent.messages
        )
        assert not has_original_grass_msg

    @pytest.mark.timeout(120)
    def test_truncate_context_drops_messages(self, model):
        agent = Agent(
            model=model,
            context_manager="agentic",
            callback_handler=None,
            system_prompt=(
                "When asked to truncate, call truncate_context with keep_recent=4 then stop. "
                "Keep responses to 1 sentence."
            ),
        )

        agent("Message one.")
        agent("Message two.")
        agent("Message three.")
        agent("Message four.")

        message_count_before = len(agent.messages)

        agent("Truncate context, keep only recent 4 messages.")

        assert len(agent.messages) < message_count_before

    @pytest.mark.timeout(180)
    def test_pin_protects_messages_from_truncation(self, model):
        agent = Agent(
            model=model,
            context_manager="agentic",
            callback_handler=None,
            system_prompt=(
                "When asked to pin, use the pin_context tool. When asked to truncate, use "
                "truncate_context. Keep responses to 1 sentence."
            ),
        )

        agent("IMPORTANT: The secret code is ZEBRA-9.")
        agent("Pin the first message using indices [0].")
        agent("Some filler conversation.")
        agent("More filler conversation.")
        agent("Truncate context, keep only recent 2 messages.")

        has_secret = any("ZEBRA-9" in block.get("text", "") for msg in agent.messages for block in msg["content"])
        assert has_secret


class TestEndToEndBehavior:
    @pytest.mark.timeout(120)
    def test_agent_remains_coherent_after_summarization(self, model):
        agent = Agent(
            model=model,
            context_manager="agentic",
            callback_handler=None,
            system_prompt="You are a helpful assistant. When asked to summarize context, use summarize_context.",
        )

        agent("My name is Alice and I live in Portland.")
        agent("I have a dog named Biscuit.")
        agent("My favorite food is pizza.")
        agent("Please use summarize_context to compress our conversation history.")

        result = agent("What is my name?")
        assert "alice" in _last_text(result).lower()
