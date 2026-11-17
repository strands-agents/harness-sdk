"""Per-model conformance: every listed model does what the model table says about it.

One row per model; each row carries its provider's skip mark, so a missing key skips only that provider's rows. A row's
declared capabilities are the ones the built model reports, since a provider turns off what it cannot use.
"""

import pytest

import strands
from strands import Agent
from strands.types.exceptions import ModelThrottledException
from tests_integ.models import providers

MODELS = [
    pytest.param(provider, model_id, expected_window, id=f"{provider.id}-{model_id}", marks=provider.mark)
    for provider, model_id, expected_window in [
        (providers.anthropic, "claude-opus-5-5", 1_000_000),
        (providers.anthropic, "claude-sonnet-5-5", 1_000_000),
        (providers.anthropic, "claude-haiku-5-5", 1_000_000),
        (providers.gemini, "gemini-4-hydrogen", 1_048_576),
        (providers.gemini, "gemini-4-argon", 1_048_576),
        (providers.gemini, "gemini-3.8-flash", 1_048_576),
        (providers.bedrock, "us.xai.grok-4.7", 524_288),
        (providers.bedrock, "mistral.mistral-large-3-675b-instruct", 256_000),
        (providers.bedrock, "openai.gpt-oss-120b-1:0", 128_000),
        (providers.bedrock, "global.anthropic.claude-opus-5", 1_000_000),
        (providers.bedrock, "global.anthropic.claude-opus-5-5", 1_000_000),
        (providers.bedrock, "global.anthropic.claude-sonnet-5", 1_000_000),
        (providers.bedrock, "global.anthropic.claude-sonnet-5-5", 1_000_000),
        (providers.bedrock, "global.anthropic.claude-haiku-5-5", 1_000_000),
        (providers.bedrock, "global.anthropic.claude-haiku-4-5-20251001-v1:0", 200_000),
        (providers.bedrock, "us.amazon.nova-2-lite-v1:0", 1_000_000),
        (providers.bedrock, "us.amazon.nova-pro-v1:0", 300_000),
        (providers.mantle, "google.gemma-4-31b", 256_000),
        (providers.mantle, "openai.gpt-oss-120b", 128_000),
        (providers.mantle_responses, "google.gemma-4-31b", 256_000),
        (providers.mantle_responses, "openai.gpt-oss-120b", 128_000),
        (providers.openai, "chat-latest", 272_000),
        (providers.mistral, "mistral-medium-3-5", 262_144),
        (providers.mistral, "mistral-large-4-0", 1_048_576),
        (providers.mistral, "ministral-14b-2512", 262_144),
        (providers.mistral, "mistral-small-2603", 262_144),
        (providers.mistral, "codestral-2508", 256_000),
    ]
    if provider is not None
]

FORCED_TOOL_CHOICE_MARKS = {
    model_id: pytest.mark.xfail(
        strict=True, reason="the table says this model cannot be forced to call a tool; the provider accepts it"
    )
    for model_id in ("claude-haiku-5-5", "global.anthropic.claude-haiku-5-5")
}

# Provider error text meaning the model cannot be forced to call a tool.
FORCED_TOOL_CHOICE_REFUSALS = (
    'tool_choice: type "tool" and "any" are not supported',
    "doesn't support the toolConfig.toolChoice",
)

# Longer than any listed model's cache minimum. The lines differ because repeated lines trip a content filter.
CACHED_TEXT = "\n".join(f"Shelf {number} holds {number * 37} copies of volume {number}." for number in range(500))


@strands.tool
def echo(value: str) -> str:
    """Echo the given value back."""
    return value


@pytest.fixture
def model(provider, model_id):
    model = provider.create_model()
    model.update_config(model_id=model_id)
    return model


@pytest.mark.parametrize(("provider", "model_id", "expected_window"), MODELS)
def test_context_window_limit_resolves(model, expected_window):
    assert model.get_config()["context_window_limit"] == expected_window


@pytest.mark.parametrize(("provider", "model_id", "expected_window"), MODELS)
def test_tool_use_turn_completes(model, expected_window):
    agent = Agent(model=model, tools=[echo], load_tools_from_directory=False, callback_handler=None)

    result = agent("Use the echo tool to echo the value 'pineapple'.")

    assert result.stop_reason == "end_turn"
    assert any(block.get("toolUse") for message in agent.messages for block in message["content"])


@pytest.mark.asyncio
@pytest.mark.parametrize(("provider", "model_id", "expected_window"), MODELS)
async def test_forced_tool_choice_is_accepted_or_refused_as_declared(request, model, model_id, expected_window, alist):
    declared = model.model_info.capabilities.forced_tool_choice
    if declared is None:
        pytest.skip("the model declares nothing about forced tool choice")
    if model_id in FORCED_TOOL_CHOICE_MARKS:
        request.applymarker(FORCED_TOOL_CHOICE_MARKS[model_id])
    messages = [{"role": "user", "content": [{"text": "Hello there!"}]}]

    # A model that accepts a forced call can still end a turn without one, so only a tool use or a refusal is final.
    tru_outcome = "no tool use"
    for _ in range(3):
        try:
            events = await alist(model.stream(messages, tool_specs=[echo.tool_spec], tool_choice={"any": {}}))
        except ModelThrottledException as error:
            pytest.skip(f"not validated: {error}")
        except Exception as error:
            if not any(refusal in str(error) for refusal in FORCED_TOOL_CHOICE_REFUSALS):
                raise
            tru_outcome = "refused"
            break
        if any("toolUse" in event.get("contentBlockStart", {}).get("start", {}) for event in events):
            tru_outcome = "accepted"
            break

    exp_outcome = "accepted" if declared else "refused"
    assert tru_outcome == exp_outcome


@pytest.mark.parametrize(("provider", "model_id", "expected_window"), MODELS)
def test_cache_point_is_read_by_a_repeated_request(model, expected_window, quiet_strands_logging):
    if model.model_info.capabilities.prompt_caching != "cache_points":
        pytest.skip("the model does not declare cache points")

    def cache_read_tokens() -> int:
        agent = Agent(
            model=model,
            system_prompt=[{"text": CACHED_TEXT}, {"cachePoint": {"type": "default"}}],
            load_tools_from_directory=False,
            callback_handler=None,
        )
        return agent("Reply with OK.").metrics.accumulated_usage.get("cacheReadInputTokens", 0)

    cache_read_tokens()

    # On a Bedrock inference profile a repeat can write again before one reads, so one miss is not a failure.
    assert any(cache_read_tokens() > 0 for _ in range(3))
