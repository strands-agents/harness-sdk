"""Combined smoke test for bidi features."""

import asyncio

from strands import tool
from strands.experimental.bidi import models
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiAudioIO
from strands.experimental.bidi.types import (
    BidiConnectionRestartEvent,
    BidiConnectionStartEvent,
    BidiInterruptionEvent,
)


@tool
def trip_lookup(destination: str) -> dict:
    """Return a test itinerary for a destination.

    Args:
        destination: Destination to look up.
    """
    print(f"\n[tool] trip_lookup(destination={destination!r})")
    return {"destination": destination, "departure_date": "December 1, 2026"}


class EventObserver:
    """Print interruption and connection events."""

    async def start(self, _agent: BidiAgent) -> None:
        return

    async def stop(self) -> None:
        return

    async def __call__(self, event) -> None:
        if isinstance(event, BidiInterruptionEvent):
            print(f"\n[event] interruption reason={event.reason}")
        elif isinstance(event, BidiConnectionRestartEvent):
            print(f"\n[event] restart reason={event.reason} turn_interrupted={event.turn_interrupted}")
        elif isinstance(event, BidiConnectionStartEvent):
            print(f"\n[event] connection started id={event.connection_id}")


async def main() -> None:
    connection = {"restart_after_s": 30}

    # Pick one model provider. Keep only one model line uncommented.
    model = models.BedrockNovaSonicModel(connection=connection)
    # model = models.GoogleGeminiLiveModel(connection=connection)
    # model = models.OpenAIRealtimeModel(connection=connection)

    agent = BidiAgent(
        model=model,
        tools=[trip_lookup],
        system_prompt=(
            "You are testing bidirectional streaming. Use trip_lookup when asked about "
            "a trip, remember facts the user asks you to remember, and give a long "
            "answer when asked so the user can interrupt."
        ),
    )
    audio_io = BidiAudioIO(audio_processor=True)

    print("Wear headphones. Echo cancellation is enabled.")
    print("Try a trip lookup, ask the model to remember a fact, and interrupt a long answer.")
    print("After the restart event, ask the model to recall the fact. Press Ctrl+C to stop.")
    await agent.run(
        inputs=[audio_io.input()],
        outputs=[audio_io.output(), EventObserver()],
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
