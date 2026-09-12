"""Test context manager for bidirectional streaming tests.

Provides a high-level interface for testing bidirectional streaming agents
with continuous background threads that mimic real-world usage patterns.
"""

import asyncio
import base64
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from strands.experimental.bidi.agent.agent import BidiAgent

    from .generators.audio import AudioGenerator

logger = logging.getLogger(__name__)

# Constants for timing and buffering
QUEUE_POLL_TIMEOUT = 0.05  # 50ms - balance between responsiveness and CPU usage
SILENCE_INTERVAL = 0.05  # 50ms - send silence every 50ms when queue empty
AUDIO_CHUNK_DELAY = 0.01  # 10ms - small delay between audio chunks


class BidirectionalTestContext:
    """Manages threads and generators for bidirectional streaming tests.

    Mimics real-world usage with continuous background threads:
    - Audio input thread (microphone simulation with silence padding)
    - Event collection thread (captures all model outputs)

    Generators feed data into threads via queues for natural conversation flow.

    Example:
        async with BidirectionalTestContext(agent, audio_generator) as ctx:
            await ctx.say("What is 5 plus 3?")
            await ctx.wait_for_response()
            assert "8" in " ".join(ctx.get_text_outputs())
    """

    def __init__(
        self,
        agent: "BidiAgent",
        audio_generator: "AudioGenerator | None" = None,
        silence_chunk_size: int = 1024,
        audio_chunk_size: int = 1024,
    ):
        """Initialize test context.

        Args:
            agent: BidiAgent instance.
            audio_generator: AudioGenerator for text-to-speech.
            silence_chunk_size: Size of silence chunks in bytes.
            audio_chunk_size: Size of audio chunks for streaming.
        """
        self.agent = agent
        self.audio_generator = audio_generator
        self.silence_chunk_size = silence_chunk_size
        self.audio_chunk_size = audio_chunk_size

        # Queue for thread communication
        self.input_queue = asyncio.Queue()  # Handles both audio and text input

        # Event storage (thread-safe)
        self._event_queue = asyncio.Queue()  # Events from collection thread
        self._response_completions = asyncio.Queue()
        self.events = []  # Cached events for test access

        # Control flags
        self.active = False
        self.threads = []

    async def __aenter__(self):
        """Start context manager, agent session, and background threads."""
        # Start agent session
        await self.agent.start()
        logger.debug("Agent session started")

        await self.start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Stop context manager, cleanup threads, and end agent session."""
        # End agent session FIRST - this will cause receive() to exit cleanly
        if self.agent._started:
            await self.agent.stop()
            logger.debug("Agent session stopped")

        # Then stop the context threads
        await self.stop()

        return False

    async def start(self):
        """Start all background threads."""
        self.active = True

        self.threads = [
            asyncio.create_task(self._input_thread()),
            asyncio.create_task(self._event_collection_thread()),
        ]

        logger.debug("Test context started with %d threads", len(self.threads))

    async def stop(self):
        """Stop all threads gracefully."""
        if not self.active:
            logger.debug("stop() called but already stopped")
            return

        logger.debug("stop() called - stopping threads")
        self.active = False

        # Cancel all threads
        for task in self.threads:
            if not task.done():
                task.cancel()

        # Wait for cancellation
        await asyncio.gather(*self.threads, return_exceptions=True)

        logger.debug("Test context stopped")

    # === User-facing methods ===

    async def say(self, text: str):
        """Convert text to audio and queue audio chunks to be sent to model.

        Args:
            text: Text to convert to speech and send as audio.

        Raises:
            ValueError: If audio generator is not available.
        """
        if not self.audio_generator:
            raise ValueError("Audio generator not available. Pass audio_generator to BidirectionalTestContext.")

        # Generate audio via Polly
        audio_data = await self.audio_generator.generate_audio(text)

        # Split into chunks and queue each chunk
        for i in range(0, len(audio_data), self.audio_chunk_size):
            chunk = audio_data[i : i + self.audio_chunk_size]
            chunk_event = self.audio_generator.create_audio_input_event(chunk)
            await self.input_queue.put({"type": "audio_chunk", "data": chunk_event})

        logger.debug("audio_bytes=<%d>, text_preview=<%s> | queued audio for text", len(audio_data), text[:50])

    async def send(self, data: str | dict) -> None:
        """Send data directly to model (text, image, etc.).

        Args:
            data: Data to send to model. Can be:
                - str: Text input
                - dict: Custom event (e.g., image, audio)
        """
        await self.input_queue.put({"type": "direct", "data": data})
        logger.debug("data_type=<%s> | queued direct send", type(data).__name__)

    async def wait_for_response(
        self,
        timeout: float = 15.0,
    ) -> None:
        """Wait for the next model response to complete.

        Args:
            timeout: Maximum time to wait in seconds.

        Raises:
            TimeoutError: If a response completion event is not received before the timeout.
        """
        try:
            await asyncio.wait_for(self._response_completions.get(), timeout=timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(f"timeout={timeout} | response completion event not received") from None

    def get_events(self, event_type: str | None = None) -> list[dict]:
        """Get collected events, optionally filtered by type.

        Drains the event queue and caches events for subsequent calls.

        Args:
            event_type: Optional event type to filter by (e.g., "textOutput").

        Returns:
            List of events, filtered if event_type specified.
        """
        # Drain queue into cache (non-blocking)
        while not self._event_queue.empty():
            try:
                event = self._event_queue.get_nowait()
                self.events.append(event)
            except asyncio.QueueEmpty:
                break

        if event_type:
            return [e for e in self.events if event_type in e]
        return self.events.copy()

    def get_text_outputs(self) -> list[str]:
        """Extract text outputs from collected events.

        Handles both new TypedEvent format and legacy event formats.

        Returns:
            List of text content strings.
        """
        texts = []
        for event in self.get_events():  # Drain queue first
            # Handle new TypedEvent format (bidi_transcript_stream)
            if event.get("type") == "bidi_transcript_stream":
                text = event.get("delta", "")
                if text:
                    texts.append(text)
            elif event.get("type") == "bidi_transcript_complete":
                text = event.get("transcript", "")
                if text:
                    texts.append(text)
            # Handle legacy textOutput events (Nova Sonic, OpenAI)
            elif "textOutput" in event:
                text = event["textOutput"].get("text", "")
                if text:
                    texts.append(text)
            # Handle legacy transcript events (Gemini Live)
            elif "transcript" in event:
                text = event["transcript"].get("text", "")
                if text:
                    texts.append(text)
        return texts

    def get_audio_outputs(self) -> list[bytes]:
        """Extract audio outputs from collected events.

        Returns:
            List of audio data bytes.
        """
        # Drain queue first to get latest events
        events = self.get_events()
        audio_data = []
        for event in events:
            # Handle new TypedEvent format (bidi_audio_stream)
            if event.get("type") == "bidi_audio_stream":
                audio_b64 = event.get("audio")
                if audio_b64:
                    # Decode base64 to bytes
                    audio_data.append(base64.b64decode(audio_b64))
            # Handle legacy audioOutput events
            elif "audioOutput" in event:
                data = event["audioOutput"].get("audioData")
                if data:
                    audio_data.append(data)
        return audio_data

    def get_tool_uses(self) -> list[dict]:
        """Extract tool use events from collected events.

        Returns:
            List of tool use events.
        """
        # Drain queue first to get latest events
        events = self.get_events()
        return [event["toolUse"] for event in events if "toolUse" in event]

    def has_interruption(self) -> bool:
        """Check if any interruption was detected.

        Returns:
            True if interruption detected in events.
        """
        return any("interruptionDetected" in event for event in self.events)

    def clear_events(self):
        """Clear collected events (useful for multi-turn tests)."""
        self.events.clear()
        logger.debug("Events cleared")

    # === Background threads ===

    async def _input_thread(self):
        """Continuously handle input to model.

        - Sends queued audio chunks immediately
        - Sends silence chunks periodically when queue is empty (simulates microphone)
        - Sends direct data to model
        """
        try:
            logger.debug("active=<%s> | input thread starting", self.active)
            while self.active:
                try:
                    # Check for queued input (non-blocking with short timeout)
                    input_item = await asyncio.wait_for(self.input_queue.get(), timeout=QUEUE_POLL_TIMEOUT)

                    if input_item["type"] == "audio_chunk":
                        # Send pre-generated audio chunk
                        await self.agent.send(input_item["data"])
                        await asyncio.sleep(AUDIO_CHUNK_DELAY)

                    elif input_item["type"] == "direct":
                        # Send data directly to agent
                        await self.agent.send(input_item["data"])
                        data_repr = (
                            str(input_item["data"])[:50]
                            if isinstance(input_item["data"], str)
                            else type(input_item["data"]).__name__
                        )
                        logger.debug("data=<%s> | sent direct data", data_repr)

                except asyncio.TimeoutError:
                    # No input queued - send silence chunk to simulate continuous microphone input
                    if self.audio_generator:
                        silence = self._generate_silence_chunk()
                        await self.agent.send(silence)
                        await asyncio.sleep(SILENCE_INTERVAL)

        except asyncio.CancelledError:
            logger.debug("Input thread cancelled")
            raise  # Re-raise to properly propagate cancellation
        except Exception as e:
            logger.exception("error=<%s> | input thread error", e)
        finally:
            logger.debug("active=<%s> | input thread stopped", self.active)

    async def _event_collection_thread(self):
        """Continuously collect events from model."""
        try:
            async for event in self.agent.receive():
                if not self.active:
                    break

                # Thread-safe: put in queue instead of direct append
                await self._event_queue.put(event)
                if event.get("type") == "bidi_response_complete" and event.get("stop_reason") == "complete":
                    self._response_completions.put_nowait(event)
                logger.debug("event_type=<%s> | event collected", event.get("type", "unknown"))

        except asyncio.CancelledError:
            logger.debug("Event collection thread cancelled")
            raise  # Re-raise to properly propagate cancellation
        except Exception as e:
            logger.error("error=<%s> | event collection thread error", e)

    def _generate_silence_chunk(self) -> dict:
        """Generate silence chunk for background audio.

        Returns:
            BidiAudioInputEvent with silence data.
        """
        silence = b"\x00" * self.silence_chunk_size
        return self.audio_generator.create_audio_input_event(silence)
