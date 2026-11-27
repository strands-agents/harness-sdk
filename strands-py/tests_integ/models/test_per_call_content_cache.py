"""Prompt caching on GPT survives a tool loop whose latest user message carries text rebuilt on every model call.

Only ``cacheReadInputTokens`` tells a reading request from one that rewrites its prefix each call, so the tests
assert it directly. The Mantle model authenticates with the ambient AWS credential chain.
"""

import uuid

from strands import Agent, tool
from strands.models import BedrockModel, Model
from strands.models.model import CacheConfig
from strands.models.openai_responses import OpenAIResponsesModel
from strands.vended_plugins.context_injector import ContextInjector


@tool
def lookup_inventory(item: str) -> str:
    """Look up how many units of an item are in stock.

    Args:
        item: The item to look up.
    """
    return {"widgets": "17", "gadgets": "4", "gizmos": "9"}.get(item, "0")


def _cache_reads_after_first_call(model: Model) -> list[int]:
    """Run a tool loop of at least three model calls with per-call text injected before each.

    Returns the cached input tokens each model call after the first read.
    """
    reads: list[int] = []
    original_stream = model.stream

    async def stream(*args, **kwargs):
        async for event in original_stream(*args, **kwargs):
            usage = event["metadata"].get("usage") if "metadata" in event else None
            if usage:
                reads.append(usage.get("cacheReadInputTokens", 0))
            yield event

    model.stream = stream
    calls = {"value": 0}

    def render_content(context):
        calls["value"] += 1
        return f"<call>{calls['value']}</call>"

    agent = Agent(
        model=model,
        tools=[lookup_inventory],
        callback_handler=None,
        # A nonce per run makes the first call a cold write; the repeat clears every minimum cacheable prefix.
        system_prompt=(
            f"Session {uuid.uuid4()}. You are an inventory assistant.\n"
            + "Report stock counts exactly as the tool returns them. " * 400
        ),
        plugins=[ContextInjector(render_content, trigger="everyTurn")],
    )

    result = agent(
        "Look up widgets, then gadgets, then gizmos, one tool call at a time, and say which has the most stock."
    )

    assert result.stop_reason == "end_turn"
    assert len([message for message in agent.messages if message["role"] == "assistant"]) >= 3
    assert len(reads) >= 3
    return reads[1:]


def test_reads_the_cache_on_a_later_call_through_the_responses_api_on_bedrock_mantle():
    model = OpenAIResponsesModel(
        model_id="openai.gpt-6-luna",
        bedrock_mantle_config={"region": "us-east-1"},
        cache_config=CacheConfig(strategy="auto"),
    )

    reads = _cache_reads_after_first_call(model)

    assert max(reads) > 0


def test_reads_the_cache_on_a_later_call_through_converse():
    model = BedrockModel(
        model_id="us.openai.gpt-6-luna", region_name="us-east-1", cache_config=CacheConfig(strategy="auto")
    )

    reads = _cache_reads_after_first_call(model)

    assert max(reads) > 0
