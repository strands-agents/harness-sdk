"""Starter for the Amazon Nova Sonic provider bug bash."""

import asyncio

from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiAudioIO
from strands.experimental.bidi.models import BedrockNovaSonicModel


async def main() -> None:
    model = BedrockNovaSonicModel(
        region="us-east-1",
    )
    agent = BidiAgent(
        model=model,
        system_prompt=(
            "You are testing Amazon Nova Sonic. Keep normal answers concise, but follow "
            "requests for long responses, interruptions, and remembered facts."
        ),
    )
    audio_io = BidiAudioIO(audio_processor=True)
    print("Wear headphones. Test several turns, interruption, and text/audio continuity. Press Ctrl+C to stop.")
    await agent.run(inputs=[audio_io.input()], outputs=[audio_io.output()])


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
