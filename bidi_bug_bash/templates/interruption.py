"""Starter for the bidi interruption bug bash."""

import asyncio

from strands.experimental.bidi import models
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiAudioIO
from strands.experimental.bidi.types import (
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
)


class EventObserver:
    """Print interruption and response-boundary events."""

    async def start(self, _agent: BidiAgent) -> None:
        return

    async def stop(self) -> None:
        return

    async def __call__(self, event) -> None:
        if isinstance(event, BidiInterruptionEvent):
            print(f"\n[event] interruption reason={event.reason}")
        elif isinstance(event, BidiResponseCompleteEvent):
            print(f"\n[event] response complete id={event.response_id} reason={event.stop_reason}")


async def main() -> None:
    # Pick one model provider. Keep only one model line uncommented.
    # model = models.BedrockNovaSonicModel()
    # model = models.GoogleGeminiLiveModel()
    model = models.OpenAIRealtimeModel()

    agent = BidiAgent(
        model=model,
        system_prompt=(
            "You are testing interruption handling. Give detailed spoken answers when "
            "asked, and immediately address the user's latest speech after interruption."
        ),
    )
    audio_io = BidiAudioIO(audio_processor=True)
    print("Wear headphones. Ask for a long answer, then speak while the model is talking. Press Ctrl+C to stop.")
    await agent.run(
        inputs=[audio_io.input()],
        outputs=[audio_io.output(), EventObserver()],
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
