"""Starter for the bidi tool-calling bug bash."""

import asyncio
import time

from strands import tool
from strands.experimental.bidi import models
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiAudioIO


@tool
def trip_lookup(destination: str, wait_seconds: int = 0) -> dict:
    """Return a test itinerary for a destination.

    Args:
        destination: Destination to look up.
        wait_seconds: Number of seconds to wait before returning.
    """
    print(f"\n[tool] trip_lookup(destination={destination!r}, wait_seconds={wait_seconds})")
    if wait_seconds:
        time.sleep(wait_seconds)
    if destination.lower() == "error":
        raise ValueError("test trip lookup failure")
    return {"destination": destination, "departure_date": "December 1, 2026"}


async def main() -> None:
    # Pick one model provider. Keep only one model line uncommented.
    model = models.BedrockNovaSonicModel()
    # model = models.GoogleGeminiLiveModel()
    # model = models.OpenAIRealtimeModel()

    agent = BidiAgent(
        model=model,
        tools=[trip_lookup],
        system_prompt=(
            "You are testing tool calling. When the user asks for a trip lookup, use trip_lookup and report its result."
        ),
    )
    audio_io = BidiAudioIO(audio_processor=True)
    print("Wear headphones. Ask for a trip to Tokyo, destination error, or a 20-second wait. Press Ctrl+C to stop.")
    await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
