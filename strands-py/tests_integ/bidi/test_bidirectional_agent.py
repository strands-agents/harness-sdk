"""Parameterized integration tests for bidirectional streaming.

Tests fundamental functionality across multiple model providers (Bedrock, Google, and OpenAI),
including multi-turn conversations, audio I/O, text transcription, and tool execution.

This demonstrates the provider-agnostic design of the bidirectional streaming system.
"""

import asyncio
import logging
import os

import pytest

from strands import tool
from strands.experimental.bidi.agent.agent import BidiAgent
from strands.experimental.bidi.models import GoogleGeminiLiveModel, OpenAIRealtimeModel

from .context import BidirectionalTestContext
from .hook_utils import HookEventCollector

logger = logging.getLogger(__name__)


def create_bedrock_nova_sonic_model(**kwargs):
    """Create a Nova Sonic model without importing its Python 3.12-only SDK during collection."""
    from strands.experimental.bidi.models import BedrockNovaSonicModel

    return BedrockNovaSonicModel(**kwargs)


# Simple calculator tool for testing
@tool
def calculator(operation: str, x: float, y: float) -> float:
    """Perform basic arithmetic operations.

    Args:
        operation: The operation to perform (add, subtract, multiply, divide)
        x: First number
        y: Second number

    Returns:
        Result of the operation
    """
    if operation == "add":
        return x + y
    elif operation == "subtract":
        return x - y
    elif operation == "multiply":
        return x * y
    elif operation == "divide":
        if y == 0:
            raise ValueError("Cannot divide by zero")
        return x / y
    else:
        raise ValueError(f"Unknown operation: {operation}")


# Provider configurations
PROVIDER_CONFIGS = {
    "bedrock_nova_sonic": {
        "model_factory": create_bedrock_nova_sonic_model,
        "model_kwargs": {"region": "us-east-1"},  # Uses v2 by default
        "silence_duration": 2.5,  # Nova Sonic needs 2+ seconds of silence
        "env_vars": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        "skip_reason": "AWS credentials not available",
    },
    "bedrock_nova_sonic_v1": {
        "model_factory": create_bedrock_nova_sonic_model,
        "model_kwargs": {"model_id": "amazon.nova-sonic-v1:0", "region": "us-east-1"},
        "silence_duration": 2.5,  # Nova Sonic v1 needs 2+ seconds of silence
        "env_vars": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        "skip_reason": "AWS credentials not available",
    },
    "openai_realtime": {
        "model_factory": OpenAIRealtimeModel,
        "model_kwargs": {
            "params": {
                "output_modalities": ["audio"],  # OpenAI only supports audio OR text, not both
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": 24000},
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": 0.5,
                            "silence_duration_ms": 700,
                        },
                    },
                    "output": {"format": {"type": "audio/pcm", "rate": 24000}, "voice": "alloy"},
                },
            },
        },
        "silence_duration": 1.0,  # OpenAI has faster VAD
        "env_vars": ["OPENAI_API_KEY"],
        "skip_reason": "OPENAI_API_KEY not available",
    },
    "google_gemini_live": {
        "model_factory": GoogleGeminiLiveModel,
        "model_kwargs": {
            # Uses default model and config (audio output + transcription enabled)
        },
        "silence_duration": 1.5,  # Google Gemini Live has good VAD, similar to OpenAI
        "env_vars": ["GOOGLE_API_KEY"],
        "skip_reason": "GOOGLE_API_KEY not available",
    },
}


def check_provider_available(provider_name: str) -> tuple[bool, str]:
    """Check if a provider's credentials are available.

    Args:
        provider_name: Name of the provider to check.

    Returns:
        Tuple of (is_available, skip_reason).
    """
    config = PROVIDER_CONFIGS[provider_name]
    env_vars = config["env_vars"]

    missing_vars = [var for var in env_vars if not os.getenv(var)]

    if missing_vars:
        return False, f"{config['skip_reason']}: {', '.join(missing_vars)}"

    return True, ""


@pytest.fixture(params=list(PROVIDER_CONFIGS.keys()))
def provider_config(request):
    """Provide configuration for each model provider.

    This fixture is parameterized to run tests against all available providers.
    """
    provider_name = request.param
    config = PROVIDER_CONFIGS[provider_name]

    # Check if provider is available
    is_available, skip_reason = check_provider_available(provider_name)
    if not is_available:
        pytest.skip(skip_reason)

    return {
        "name": provider_name,
        **config,
    }


@pytest.fixture
def hook_collector():
    """Provide a hook event collector for tracking all events."""
    return HookEventCollector()


@pytest.fixture
def agent_with_calculator(provider_config, hook_collector):
    """Provide bidirectional agent with calculator tool for the given provider.

    Note: Session lifecycle (start/end) is handled by BidirectionalTestContext.
    """
    model_factory = provider_config["model_factory"]
    model_kwargs = provider_config["model_kwargs"]

    model = model_factory(**model_kwargs)
    return BidiAgent(
        model=model,
        tools=[calculator],
        system_prompt="You are a helpful assistant with access to a calculator tool. Keep responses brief.",
        hooks=[hook_collector],
    )


@pytest.mark.asyncio
async def test_bidirectional_agent(agent_with_calculator, audio_generator, provider_config, hook_collector):
    """Test multi-turn conversation with follow-up questions across providers.

    This test runs against all configured providers (Bedrock, Google, and OpenAI)
    to validate provider-agnostic functionality.

    Validates:
    - Session lifecycle (start/end via context manager)
    - Audio input streaming
    - Speech-to-text transcription
    - Tool execution (calculator) with hook verification
    - Multi-turn conversation flow
    - Complete, correctly ordered conversation history
    - Text-to-speech audio output
    """
    provider_name = provider_config["name"]
    silence_duration = provider_config["silence_duration"]

    logger.info("provider=<%s> | testing provider", provider_name)

    async with BidirectionalTestContext(agent_with_calculator, audio_generator) as ctx:
        # Turn 1: Simple greeting to test basic audio I/O
        await ctx.say("Hello, can you hear me?")
        # Wait for silence to trigger provider's VAD/silence detection
        await asyncio.sleep(silence_duration)
        await ctx.wait_for_response()

        text_outputs_turn1 = ctx.get_text_outputs()

        # Validate turn 1 - just check we got a response
        assert len(text_outputs_turn1) > 0, f"[{provider_name}] No text output received in turn 1"

        logger.info("provider=<%s> | turn 1 complete received response", provider_name)
        logger.info("provider=<%s>, response=<%s> | turn 1 response", provider_name, text_outputs_turn1[0][:100])

        # Turn 2: Follow-up to test multi-turn conversation
        await ctx.say("What's your name?")
        # Wait for silence to trigger provider's VAD/silence detection
        await asyncio.sleep(silence_duration)
        await ctx.wait_for_response()

        text_outputs_turn2 = ctx.get_text_outputs()

        # Validate turn 2 - check we got more responses
        assert len(text_outputs_turn2) > len(text_outputs_turn1), f"[{provider_name}] No new text output in turn 2"

        logger.info("provider=<%s> | turn 2 complete multi-turn conversation works", provider_name)
        logger.info("provider=<%s>, response_count=<%d> | total responses", provider_name, len(text_outputs_turn2))

        # Validate full conversation
        messages = agent_with_calculator.messages
        assert [message["role"] for message in messages] == ["user", "assistant", "user", "assistant"]
        for message in messages:
            assert len(message["content"]) == 1
            assert message["content"][0]["text"].strip()

        # Validate audio outputs
        audio_outputs = ctx.get_audio_outputs()
        assert len(audio_outputs) > 0, f"[{provider_name}] No audio output received"
        total_audio_bytes = sum(len(audio) for audio in audio_outputs)

        # Verify tool execution hooks if tools were called
        tool_calls = hook_collector.get_tool_calls()
        if len(tool_calls) > 0:
            logger.info("provider=<%s> | tool execution detected", provider_name)
            # Verify hooks are properly paired
            verified_tools = hook_collector.verify_tool_execution()
            logger.info(
                "provider=<%s>, tools_called=<%s> | tool execution hooks verified",
                provider_name,
                verified_tools,
            )
        else:
            logger.info("provider=<%s> | no tools were called during conversation", provider_name)

        # Summary
        logger.info("=" * 60)
        logger.info("provider=<%s> | multi-turn conversation test passed", provider_name)
        logger.info("provider=<%s> | test summary", provider_name)
        logger.info("event_count=<%d> | total events", len(ctx.get_events()))
        logger.info("text_response_count=<%d> | text responses", len(text_outputs_turn2))
        logger.info(
            "audio_chunk_count=<%d>, audio_bytes=<%d> | audio chunks",
            len(audio_outputs),
            total_audio_bytes,
        )
        logger.info(
            "tool_calls=<%d> | tool execution count",
            len(tool_calls),
        )
        logger.info("=" * 60)
