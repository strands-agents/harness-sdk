"""Starter for the bidi proactive restart bug bash."""

import asyncio

from strands.experimental.bidi import models
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiAudioIO
from strands.experimental.bidi.types import (
    BidiConnectionRestartEvent,
    BidiConnectionStartEvent,
    BidiConnectionWarningEvent,
)


class RestartObserver:
    """Print connection lifecycle events."""

    async def start(self, _agent: BidiAgent) -> None:
        return

    async def stop(self) -> None:
        return

    async def __call__(self, event) -> None:
        if isinstance(event, BidiConnectionWarningEvent):
            print(f"\n[event] reconnect warning time_left_s={event.time_left_s}")
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
        system_prompt=(
            "You are testing conversation continuity across connection restarts. "
            "Remember facts the user explicitly asks you to remember. After reconnecting, "
            "continue the conversation without greeting or introducing yourself again."
        ),
    )
    audio_io = BidiAudioIO(audio_processor=True)
    print("Wear headphones.")
    print("Say: Remember that I am traveling to Tokyo on December 1, 2026.")
    print("After the restart event, ask: Where am I traveling, and on what date?")
    print("Press Ctrl+C to stop.")
    await agent.run(
        inputs=[audio_io.input()],
        outputs=[audio_io.output(), RestartObserver()],
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
