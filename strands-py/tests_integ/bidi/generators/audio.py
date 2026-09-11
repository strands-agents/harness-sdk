"""Audio generation utilities using Amazon Polly for test audio input.

Provides text-to-speech conversion for generating realistic audio test data
without requiring physical audio devices or pre-recorded files.
"""

import base64
import hashlib
import logging
from pathlib import Path
from typing import Literal

import boto3

logger = logging.getLogger(__name__)

# Audio format constants matching Nova Sonic requirements
NOVA_SONIC_SAMPLE_RATE = 16000
NOVA_SONIC_CHANNELS = 1
NOVA_SONIC_FORMAT = "pcm"

# Polly configuration
POLLY_VOICE_ID = "Matthew"  # US English male voice
POLLY_ENGINE = "neural"  # Higher quality neural engine

# Cache directory for generated audio
CACHE_DIR = Path(__file__).parent.parent / ".audio_cache"


class AudioGenerator:
    """Generate test audio using Amazon Polly with caching."""

    def __init__(self, region: str = "us-east-1"):
        """Initialize audio generator with Polly client.

        Args:
            region: AWS region for Polly service.
        """
        self.polly_client = boto3.client("polly", region_name=region)
        self._ensure_cache_dir()

    def _ensure_cache_dir(self) -> None:
        """Create cache directory if it doesn't exist."""
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def _get_cache_key(self, text: str, voice_id: str) -> str:
        """Generate cache key from text and voice."""
        content = f"{text}:{voice_id}".encode()
        return hashlib.md5(content).hexdigest()

    def _get_cache_path(self, cache_key: str) -> Path:
        """Get cache file path for given key."""
        return CACHE_DIR / f"{cache_key}.pcm"

    async def generate_audio(
        self,
        text: str,
        voice_id: str = POLLY_VOICE_ID,
        use_cache: bool = True,
    ) -> bytes:
        """Generate audio from text using Polly with caching.

        Args:
            text: Text to convert to speech.
            voice_id: Polly voice ID to use.
            use_cache: Whether to use cached audio if available.

        Returns:
            Raw PCM audio bytes at 16kHz mono (Nova Sonic format).
        """
        # Check cache first
        if use_cache:
            cache_key = self._get_cache_key(text, voice_id)
            cache_path = self._get_cache_path(cache_key)

            if cache_path.exists():
                logger.debug("text_preview=<%s> | using cached audio", text[:50])
                return cache_path.read_bytes()

        # Generate audio with Polly
        logger.debug("text_preview=<%s> | generating audio with polly", text[:50])

        try:
            response = self.polly_client.synthesize_speech(
                Text=text,
                OutputFormat="pcm",  # Raw PCM format
                VoiceId=voice_id,
                Engine=POLLY_ENGINE,
                SampleRate=str(NOVA_SONIC_SAMPLE_RATE),
            )

            # Read audio data
            audio_data = response["AudioStream"].read()

            # Cache for future use
            if use_cache:
                cache_path.write_bytes(audio_data)
                logger.debug("cache_path=<%s> | cached audio", cache_path)

            return audio_data

        except Exception as e:
            logger.error("error=<%s> | polly audio generation failed", e)
            raise

    def create_audio_input_event(
        self,
        audio_data: bytes,
        format: Literal["pcm", "wav", "opus", "mp3"] = NOVA_SONIC_FORMAT,
        sample_rate: int = NOVA_SONIC_SAMPLE_RATE,
        channels: int = NOVA_SONIC_CHANNELS,
    ) -> dict:
        """Create BidiAudioInputEvent from raw audio data.

        Args:
            audio_data: Raw audio bytes.
            format: Audio format.
            sample_rate: Sample rate in Hz.
            channels: Number of audio channels.

        Returns:
            BidiAudioInputEvent dict ready for agent.send().
        """
        # Convert bytes to base64 string for JSON compatibility
        audio_b64 = base64.b64encode(audio_data).decode("utf-8")

        return {
            "type": "bidi_audio_input",
            "audio": audio_b64,
            "format": format,
            "sample_rate": sample_rate,
            "channels": channels,
        }

    def clear_cache(self) -> None:
        """Clear all cached audio files."""
        if CACHE_DIR.exists():
            for cache_file in CACHE_DIR.glob("*.pcm"):
                cache_file.unlink()
            logger.info("Audio cache cleared")


# Convenience function for quick audio generation
async def generate_test_audio(text: str, use_cache: bool = True) -> dict:
    """Generate test audio input event from text.

    Convenience function that creates an AudioGenerator and returns
    a ready-to-use BidiAudioInputEvent.

    Args:
        text: Text to convert to speech.
        use_cache: Whether to use cached audio.

    Returns:
        BidiAudioInputEvent dict ready for agent.send().
    """
    generator = AudioGenerator()
    audio_data = await generator.generate_audio(text, use_cache=use_cache)
    return generator.create_audio_input_event(audio_data)
