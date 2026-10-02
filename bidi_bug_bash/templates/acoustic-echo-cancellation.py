"""Starter for the bidi acoustic echo cancellation bug bash."""

import asyncio

from strands.experimental.bidi import models
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiAudioIO


async def main() -> None:
    # Pick one model provider. Keep only one model line uncommented.
    model = models.BedrockNovaSonicModel(
        audio={
            "input": {"sample_rate": 16000},
            "output": {"sample_rate": 16000},
        }
    )
    # model = models.GoogleGeminiLiveModel(audio={"input": {"sample_rate": 16000}})
    # model = models.OpenAIRealtimeModel()

    agent = BidiAgent(
        model=model,
        system_prompt=(
            "You are testing acoustic echo cancellation. Give long spoken answers when "
            "asked so the tester can remain silent and check for speaker feedback."
        ),
    )

    # Compare these settings one at a time.
    audio_io = BidiAudioIO(audio_processor=True)  # Echo cancellation on.
    # audio_io = BidiAudioIO(audio_processor={"echo_cancellation": False})  # Echo cancellation off.
    # audio_io = BidiAudioIO()  # All microphone processing off.

    print("Use speakers, ask for a long answer, and remain silent. Press Ctrl+C to stop.")
    await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
