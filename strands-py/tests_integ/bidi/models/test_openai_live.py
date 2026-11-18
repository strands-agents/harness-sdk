"""Exercise OpenAI Live audio and Responses tool execution with BidiAgent."""

import asyncio
import base64
import os
from importlib import import_module

import pytest

from strands import tool
from strands.bidi import BidiAgent
from strands.bidi.types import AudioDelta

pytest.importorskip("openai.resources.live.live", exc_type=ImportError)
live = import_module("strands.bidi.models.openai.live")
pytestmark = pytest.mark.skipif(not os.getenv("OPENAI_API_KEY"), reason="OPENAI_API_KEY is required")


@pytest.mark.asyncio
async def test_tool_result_reaches_backend_and_voice():
    @tool
    def lookup_delivery_code() -> str:
        """Look up the user's delivery code."""
        return "Cobalt 17"

    model = live.OpenAILiveModel(
        model_id="gpt-live-1",
        delegation_config={
            "type": "responses",
            "model_id": "gpt-6-luna",
            "max_output_tokens": 512,
            "reasoning": {"effort": "low"},
        },
    )
    agent = BidiAgent(
        model=model,
        tools=[lookup_delivery_code],
        system_prompt=(
            "Delegate delivery-code requests to the Responses model. "
            "Use the delivery-code tool and speak its returned code aloud. Keep answers brief."
        ),
    )
    prompts = iter(["Please look up my delivery code and say it aloud."])
    silence = AudioDelta("pcm", {"bytes": bytes(960)})
    text = transcript = ""
    audible = tool_used = complete = False

    async def input_stream():
        # Live requires continuous, paced PCM even between utterances.
        await asyncio.sleep(0.02)
        return next(prompts, silence)

    async def output_stream(event):
        nonlocal text, transcript, audible, tool_used, complete
        event_type = event.get("type")
        if event_type == "bidi_text_delta":
            text += event.delta
        elif event_type == "bidi_transcript_delta" and event.role == "assistant":
            transcript += event.delta
        elif event_type == "bidi_audio_delta":
            assert (event.format, event.sample_rate, event.channels) == ("pcm", 24000, 1)
            audible |= any(base64.b64decode(event.audio, validate=True))
        elif event_type == "bidi_tool_use_blocks":
            tool_used = any(tool_use["name"] == lookup_delivery_code.tool_name for tool_use in event.tool_uses)

        if (
            tool_used
            and audible
            and "cobalt" in text.lower()
            and "17" in text
            and "cobalt" in transcript.lower()
            and any(number in transcript.lower() for number in ("17", "seventeen"))
        ):
            complete = True
            run_task.cancel()

    run_task = asyncio.create_task(agent.run(inputs=[input_stream], outputs=[output_stream]))
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(run_task, timeout=45)
    assert complete, "Live ended before the tool result reached the backend and voice"
