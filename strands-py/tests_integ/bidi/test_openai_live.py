"""GPT-Live integration tests.

GPT-Live is billed per session second and requires project access, so these tests run only when
``STRANDS_TEST_GPT_LIVE=true`` and ``OPENAI_API_KEY`` are set.
"""

import asyncio
import os

import pytest

from strands import tool
from strands.bidi import BidiAgent
from strands.bidi.types import BidiResponseStartEvent
from strands.experimental.bidi.models.openai_live import OpenAILiveModel

from .context import BidirectionalTestContext

pytestmark = pytest.mark.skipif(
    os.getenv("STRANDS_TEST_GPT_LIVE") != "true" or not os.getenv("OPENAI_API_KEY"),
    reason="set STRANDS_TEST_GPT_LIVE=true and OPENAI_API_KEY to run GPT-Live tests",
)

LIVE_PROMPT = """You are a brief, friendly voice assistant.
Backchannel policy: Use few backchannels.
Interruption policy: Stop speaking when the user interrupts. Listen to what they say.
Delegation policy:
Backend tools:
- Orders: look up the shipping status of an order by its number.
Delegate to the backend when:
- The user asks about an order.
Do not delegate to the backend when:
- The user greets you.
Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting."""

BACKEND_PROMPT = "Use lookup_order to answer order questions. Return the status in one short sentence."


def create_model(**kwargs):
    return OpenAILiveModel(
        model_id="gpt-live-1",
        backend_model_id=os.getenv("STRANDS_TEST_GPT_LIVE_BACKEND", "gpt-6-luna"),
        backend_instructions=BACKEND_PROMPT,
        params={"audio": {"format": {"type": "audio/pcm", "rate": 16000}}},
        **kwargs,
    )


@pytest.fixture
def lookup_calls():
    return []


@pytest.fixture
def lookup_order(lookup_calls):
    @tool
    def lookup_order(order_number: str) -> str:
        """Look up the shipping status of an order.

        Args:
            order_number: The order number.
        """
        lookup_calls.append(order_number)
        return f"Order {order_number} shipped today and arrives tomorrow."

    return lookup_order


async def wait_until(predicate, timeout):
    async def poll():
        while not predicate():
            await asyncio.sleep(0.1)

    await asyncio.wait_for(poll(), timeout=timeout)


def connection_ids(ctx):
    return [event["connection_id"] for event in ctx.get_events() if event.get("type") == "bidi_connection_start"]


def transcript_text(ctx, role):
    return " ".join(
        event["transcript"]
        for event in ctx.get_events()
        if event.get("type") == "bidi_transcript_block" and event.get("role") == role
    )


@pytest.mark.asyncio
async def test_conversation_round_trip(audio_generator):
    agent = BidiAgent(model=create_model(), system_prompt=LIVE_PROMPT)

    async with BidirectionalTestContext(agent, audio_generator) as ctx:
        await ctx.say("Hello, can you hear me?")
        await ctx.wait_for_response(timeout=30)
        await wait_until(lambda: transcript_text(ctx, "user"), timeout=15)

        assert ctx.get_audio_outputs()
        assert transcript_text(ctx, "assistant").strip()
        assert any(isinstance(event, BidiResponseStartEvent) for event in ctx.get_events())


@pytest.mark.asyncio
async def test_delegated_tool_result_is_spoken(audio_generator, lookup_order, lookup_calls):
    agent = BidiAgent(model=create_model(), tools=[lookup_order], system_prompt=LIVE_PROMPT)

    async with BidirectionalTestContext(agent, audio_generator) as ctx:
        await ctx.say("What is the status of order four two one five?")
        await wait_until(lambda: lookup_calls, timeout=45)
        await wait_until(lambda: "tomorrow" in transcript_text(ctx, "assistant").lower(), timeout=45)

    assert len(lookup_calls) == 1
    tool_uses = [block for message in agent.messages for block in message["content"] if "toolUse" in block]
    assert tool_uses[0]["toolUse"]["name"] == "lookup_order"


@pytest.mark.asyncio
async def test_proactive_restart_keeps_context(audio_generator):
    model = create_model(connection={"restart_after_s": 25})
    agent = BidiAgent(model=model, system_prompt=LIVE_PROMPT)

    async with BidirectionalTestContext(agent, audio_generator) as ctx:
        await ctx.say("My name is Priya. Please remember it.")
        await ctx.wait_for_response(timeout=30)
        await wait_until(lambda: len(set(connection_ids(ctx))) >= 2, timeout=60)
        ctx.clear_events()
        await ctx.say("What is my name?")
        await wait_until(lambda: "priya" in transcript_text(ctx, "assistant").lower(), timeout=45)


@pytest.mark.asyncio
async def test_graceful_close_reports_usage(audio_generator):
    model = create_model()
    agent = BidiAgent(model=model, system_prompt=LIVE_PROMPT)

    async with BidirectionalTestContext(agent, audio_generator) as ctx:
        await ctx.say("Hi there.")
        await ctx.wait_for_response(timeout=30)

    assert model.usage_seconds > 0
