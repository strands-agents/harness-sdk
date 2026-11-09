"""Prompt caching survives content that is rebuilt on every model call.

A cache read only happens when a previous request wrote an entry ending at a cache point. Content
regenerated every call — injected context, a live token count — has to sit behind that cache point, or
each request writes a fresh entry and reads none.

The failure is invisible in totals: a thrashing request and a reading request report near-identical
``inputTokens``, only split differently across the cache counters. So these assert
``cacheReadInputTokens`` directly. Nothing else distinguishes the two.

Not decorated with ``retry_on_flaky``: a retry would read the cache entry the failed attempt just
wrote and pass, hiding the regression it exists to catch.

Runs against Bedrock and, when their API keys are set, Anthropic and the OpenAI Responses API — each
reports the cached portion in the separate cache counters, so the same assertions hold for each.
"""

import os
import uuid
from collections.abc import Callable

import pytest

from strands import Agent
from strands.models import BedrockModel, Model
from strands.models.anthropic import AnthropicModel
from strands.models.model import CacheConfig
from strands.vended_plugins.context_injector import ContextInjector

# One place to bump on the next model rotation.
BEDROCK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
ANTHROPIC_MODEL_ID = "claude-opus-4-8"
OPENAI_MODEL_ID = "gpt-6-luna"
MAX_TOKENS = 512

# Enough tokens ahead of the cache point to clear every provider's minimum cacheable prefix.
DURABLE_PREFIX = "The subject prefers concise written answers. " * 700


def _bedrock_model() -> BedrockModel:
    return BedrockModel(
        model_id=BEDROCK_MODEL_ID,
        cache_config=CacheConfig(strategy="auto"),
        max_tokens=MAX_TOKENS,
    )


def _anthropic_model() -> AnthropicModel:
    return AnthropicModel(
        client_args={"api_key": os.getenv("ANTHROPIC_API_KEY")},
        model_id=ANTHROPIC_MODEL_ID,
        cache_config=CacheConfig(strategy="auto"),
        max_tokens=MAX_TOKENS,
    )


def _openai_responses_model() -> Model:
    from strands.models.openai_responses import OpenAIResponsesModel

    return OpenAIResponsesModel(
        model_id=OPENAI_MODEL_ID,
        cache_config=CacheConfig(strategy="auto"),
        params={"max_output_tokens": MAX_TOKENS},
    )


@pytest.fixture(
    params=[
        pytest.param(_bedrock_model, id="bedrock"),
        pytest.param(
            _anthropic_model,
            id="anthropic",
            marks=pytest.mark.skipif(
                "ANTHROPIC_API_KEY" not in os.environ,
                reason="ANTHROPIC_API_KEY environment variable missing",
            ),
        ),
        pytest.param(
            _openai_responses_model,
            id="openai-responses",
            marks=pytest.mark.skipif(
                "OPENAI_API_KEY" not in os.environ,
                reason="OPENAI_API_KEY environment variable missing",
            ),
        ),
    ]
)
def make_model(request) -> Callable[[], Model]:
    return request.param


@pytest.fixture
def usage_per_call():
    """Per-call token usage, in call order, captured by wrapping the model's stream()."""
    captured: list[dict[str, int]] = []

    def record(model: Model) -> Model:
        original_stream = model.stream

        async def stream(*args, **kwargs):
            async for event in original_stream(*args, **kwargs):
                usage = event.get("metadata", {}).get("usage") if "metadata" in event else None
                if usage:
                    captured.append(
                        {
                            "uncached": usage.get("inputTokens", 0),
                            "write": usage.get("cacheWriteInputTokens", 0),
                            "read": usage.get("cacheReadInputTokens", 0),
                        }
                    )
                yield event

        model.stream = stream
        return model

    record.captured = captured
    return record


def _first_prompt() -> str:
    # A nonce per run, so an entry cached by an earlier run cannot make a broken placement look fixed.
    return f"Dossier {uuid.uuid4()}. {DURABLE_PREFIX}\n\nTurn 1: reply OK."


def test_injected_context_leaves_the_durable_prefix_cacheable(make_model, usage_per_call, quiet_strands_logging):
    """A ContextInjector appends text that differs every call; the prefix ahead of it still reads."""
    call_count = {"value": 0}

    def render_content(context):
        call_count["value"] += 1
        return f"<runtime>call={call_count['value']}</runtime>"

    agent = Agent(
        model=usage_per_call(make_model()),
        callback_handler=None,
        load_tools_from_directory=False,
        plugins=[ContextInjector(render_content)],
    )

    agent(_first_prompt())
    agent("Turn 2: reply OK.")

    first_call, second_call = usage_per_call.captured[0], usage_per_call.captured[1]
    assert first_call["write"] > 0, "turn 1 wrote no cache entry, so turn 2 has nothing to read"
    assert second_call["read"] > 0, "turn 2 read nothing: the cache point is not ahead of the injected text"
    assert second_call["write"] < first_call["write"], "turn 2 rewrote the prefix instead of reusing it"


def test_agentic_context_status_leaves_the_durable_prefix_cacheable(make_model, usage_per_call, quiet_strands_logging):
    """The agentic <context-status> block carries a live token count, so it changes every call."""
    agent = Agent(
        model=usage_per_call(make_model()),
        context_manager="agentic",
        callback_handler=None,
        load_tools_from_directory=False,
    )

    agent(_first_prompt())
    agent("Turn 2: reply OK.")

    first_call, second_call = usage_per_call.captured[0], usage_per_call.captured[1]
    assert first_call["write"] > 0, "turn 1 wrote no cache entry, so turn 2 has nothing to read"
    assert second_call["read"] > 0, "turn 2 read nothing: the cache point is not ahead of the status line"
    assert second_call["write"] < first_call["write"], "turn 2 rewrote the prefix instead of reusing it"
