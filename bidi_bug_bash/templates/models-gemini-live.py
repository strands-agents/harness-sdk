"""Starter for the Google Gemini Live provider bug bash."""

import asyncio

from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiAudioIO
from strands.experimental.bidi.models import GoogleGeminiLiveModel


async def main() -> None:
    model = GoogleGeminiLiveModel()
    agent = BidiAgent(
        model=model,
        system_prompt=(
            "You are testing Gemini Live. Keep normal answers concise, but follow "
            "requests for long responses, interruptions, and remembered facts."
        ),
    )
    audio_io = BidiAudioIO(audio_processor=True)
    print("Wear headphones. Test several turns, interruption, and session continuity. Press Ctrl+C to stop.")
    await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
