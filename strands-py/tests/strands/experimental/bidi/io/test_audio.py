import base64
import builtins
import importlib
import os
import subprocess
import sys
import unittest.mock
from pathlib import Path

import numpy as np
import pytest
import pytest_asyncio

import strands.experimental.bidi.io as bidi_io
from strands.experimental.bidi.io import BidiAudioIO, BidiAudioProcessorConfig
from strands.experimental.bidi.models import AudioCapable
from strands.experimental.bidi.types import (
    BidiAudioStreamEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
)
from strands.types.media import AudioBlock


def test_io_rejects_unknown_export():
    with pytest.raises(AttributeError, match="UnknownBidiIO"):
        bidi_io.__getattr__("UnknownBidiIO")


def test_bidi_root_does_not_import_optional_dependencies():
    project_root = Path(__file__).resolve().parents[5]
    env = os.environ.copy()
    python_path = str(project_root / "src")
    if existing_python_path := env.get("PYTHONPATH"):
        python_path = os.pathsep.join((python_path, existing_python_path))
    env["PYTHONPATH"] = python_path

    code = """
import sys

import strands.experimental.bidi

optional_modules = (
    "aws_sdk_bedrock_runtime",
    "google.genai",
    "prompt_toolkit",
    "pyaudio",
    "rich",
    "websockets",
)
loaded = [name for name in optional_modules if name in sys.modules]
if loaded:
    raise AssertionError(f"optional dependencies imported eagerly: {loaded}")
"""
    subprocess.run([sys.executable, "-c", code], check=True, env=env)


@pytest.fixture
def agent():
    mock = unittest.mock.MagicMock()
    mock.model = unittest.mock.MagicMock(spec=AudioCapable)
    mock.model.get_audio_config.return_value = {
        "input": {"sample_rate": 24000, "channels": 2, "format": "pcm"},
        "output": {"sample_rate": 16000, "channels": 2, "format": "pcm"},
    }
    return mock


@pytest.fixture
def aec_agent():
    mock = unittest.mock.MagicMock()
    mock.model = unittest.mock.MagicMock(spec=AudioCapable)
    mock.model.get_audio_config.return_value = {
        "input": {"sample_rate": 16000, "channels": 1, "format": "pcm"},
        "output": {"sample_rate": 16000, "channels": 1, "format": "pcm"},
    }
    return mock


@pytest.fixture
def agent_mixed_rates():
    mock = unittest.mock.MagicMock()
    mock.model = unittest.mock.MagicMock(spec=AudioCapable)
    mock.model.get_audio_config.return_value = {
        "input": {"sample_rate": 16000, "channels": 1, "format": "pcm"},
        "output": {"sample_rate": 24000, "channels": 1, "format": "pcm"},
    }
    return mock


@pytest.fixture
def pyaudio_module():
    module = unittest.mock.MagicMock()
    module.paInt16 = 8
    module.paContinue = 0
    module.get_sample_size.return_value = 2
    with unittest.mock.patch("strands.experimental.bidi.io.audio.pyaudio", module):
        yield module


@pytest.fixture
def py_audio(pyaudio_module):
    return pyaudio_module.PyAudio.return_value


@pytest.fixture
def config():
    return {
        "input_buffer_size": 1,
        "input_device_index": 1,
        "input_frames_per_buffer": 1024,
        "output_buffer_size": 2,
        "output_device_index": 2,
        "output_frames_per_buffer": 2048,
    }


@pytest.fixture
def audio_io(py_audio, config):
    _ = py_audio
    return BidiAudioIO(**config)


@pytest_asyncio.fixture
async def audio_input(audio_io, agent):
    input_ = audio_io.input()
    await input_.start(agent)
    yield input_
    await input_.stop()


@pytest_asyncio.fixture
async def audio_output(audio_io, agent):
    output = audio_io.output()
    await output.start(agent)
    yield output
    await output.stop()


@pytest.mark.asyncio
async def test_bidi_audio_io_input(audio_input):
    audio_input._callback(b"test-audio")

    tru_event = await audio_input()
    exp_event = AudioBlock(format="pcm", source={"bytes": b"test-audio"})
    assert tru_event == exp_event


def test_bidi_audio_io_input_configs(pyaudio_module, py_audio, audio_input):
    py_audio.open.assert_called_once_with(
        channels=2,
        format=pyaudio_module.paInt16,
        frames_per_buffer=1024,
        input=True,
        input_device_index=1,
        rate=24000,
        stream_callback=audio_input._callback,
    )


@pytest.mark.asyncio
async def test_bidi_audio_io_output(audio_output):
    audio_event = BidiAudioStreamEvent(
        audio=base64.b64encode(b"test-audio").decode("utf-8"),
        channels=2,
        format="pcm",
        sample_rate=16000,
    )
    await audio_output(audio_event)

    tru_data, _ = audio_output._callback(None, frame_count=2)
    exp_data = b"test-aud"
    assert tru_data == exp_data


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stream",
    [
        {"format": "wav", "sample_rate": 16000, "channels": 2},
        {"format": "pcm", "sample_rate": 24000, "channels": 2},
        {"format": "pcm", "sample_rate": 16000, "channels": 1},
    ],
)
async def test_bidi_audio_io_output_rejects_changed_format(audio_output, stream):
    event = BidiAudioStreamEvent(audio=base64.b64encode(b"audio").decode(), **stream)
    with pytest.raises(ValueError, match="does not match the playback format"):
        await audio_output(event)

    tru_data, _ = audio_output._callback(None, frame_count=1)
    exp_data = b"\x00\x00\x00\x00"
    assert tru_data == exp_data


@pytest.mark.asyncio
async def test_bidi_audio_io_output_interrupt(audio_output):
    transcript_output = unittest.mock.AsyncMock()
    audio_output._transcript_output = transcript_output
    audio_event = BidiAudioStreamEvent(
        audio=base64.b64encode(b"test-audio").decode("utf-8"),
        channels=2,
        format="pcm",
        sample_rate=16000,
    )
    await audio_output(audio_event)
    interrupt_event = BidiInterruptionEvent(reason="user_speech")
    await audio_output(interrupt_event)

    tru_data, _ = audio_output._callback(None, frame_count=1)
    exp_data = b"\x00\x00\x00\x00"
    assert tru_data == exp_data
    transcript_output.assert_any_await(interrupt_event)


@pytest.mark.asyncio
async def test_response_complete_is_forwarded_to_transcript_output(audio_output):
    transcript_output = unittest.mock.AsyncMock()
    audio_output._transcript_output = transcript_output
    audio_output._buffer.put(b"\x01\x02\x03\x04")
    event = BidiResponseCompleteEvent(response_id="response-1", stop_reason="complete")

    await audio_output(event)

    transcript_output.assert_awaited_once_with(event)


def test_bidi_audio_io_output_configs(pyaudio_module, py_audio, audio_output):
    py_audio.open.assert_called_once_with(
        channels=2,
        format=pyaudio_module.paInt16,
        frames_per_buffer=2048,
        output=True,
        output_device_index=2,
        rate=16000,
        stream_callback=audio_output._callback,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("direction", ["input", "output"])
async def test_bidi_audio_io_start_rejects_model_without_audio_capability(pyaudio_module, direction):
    agent = unittest.mock.MagicMock()
    agent.model = object()
    audio_io = BidiAudioIO()
    io = audio_io.input() if direction == "input" else audio_io.output()

    with pytest.raises(TypeError, match="BidiAudioIO requires a model that implements AudioCapable"):
        await io.start(agent)

    pyaudio_module.PyAudio.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("direction", ["input", "output"])
@pytest.mark.parametrize("format", ["wav", "opus", "mp3"])
async def test_bidi_audio_io_start_rejects_unsupported_encoding(pyaudio_module, agent, direction, format):
    agent.model.get_audio_config.return_value[direction]["format"] = format
    audio_io = BidiAudioIO()
    channel = audio_io.input() if direction == "input" else audio_io.output()

    with pytest.raises(ValueError, match="requires signed 16-bit PCM"):
        await channel.start(agent)
    pyaudio_module.PyAudio.assert_not_called()


@pytest.mark.asyncio
async def test_echo_cancellation_rejects_different_channel_counts(pyaudio_module, aec_agent):
    aec_agent.model.get_audio_config.return_value["output"]["channels"] = 2
    audio_io = BidiAudioIO(audio_processor=True)
    with pytest.raises(ValueError, match="matching input and output channel counts"):
        await audio_io.input().start(aec_agent)
    pyaudio_module.PyAudio.assert_not_called()


# ===========================================================================
# Audio processing (echo cancellation, noise suppression, AGC)
# ===========================================================================

# ---------------------------------------------------------------------------
# BidiAudioProcessorConfig defaults and validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("audio_processor", [True, BidiAudioProcessorConfig()], ids=["boolean", "config"])
def test_audio_processor_uses_defaults(audio_processor):
    audio_io = BidiAudioIO(audio_processor=audio_processor)

    assert audio_io._config["audio_processor"] == BidiAudioProcessorConfig(echo_cancellation=True, stream_delay_ms=0)
    if isinstance(audio_processor, dict):
        assert audio_processor == BidiAudioProcessorConfig()
        assert audio_io._config["audio_processor"] is not audio_processor
    assert audio_io._config["audio_processor"] is audio_io._audio_processor_config
    assert audio_io._audio_processor is not None


def test_config_rejects_negative_delay():
    with pytest.raises(ValueError, match="stream_delay_ms"):
        BidiAudioIO(audio_processor=BidiAudioProcessorConfig(stream_delay_ms=-5))


def test_config_rejects_excessive_delay():
    with pytest.raises(ValueError, match="stream_delay_ms"):
        BidiAudioIO(audio_processor=BidiAudioProcessorConfig(stream_delay_ms=5000))


def test_config_allows_disabling_echo_cancellation():
    # Headset case: noise suppression / AGC without echo cancellation.
    config = BidiAudioProcessorConfig(echo_cancellation=False)
    audio_io = BidiAudioIO(audio_processor=config)

    assert config == BidiAudioProcessorConfig(echo_cancellation=False)
    assert audio_io._config["audio_processor"] == BidiAudioProcessorConfig(echo_cancellation=False, stream_delay_ms=0)
    assert audio_io._audio_processor is not None
    assert audio_io._audio_processor._far_buffer is None


def test_config_rejects_stream_delay_when_echo_cancellation_is_off():
    with pytest.raises(ValueError, match="requires echo cancellation"):
        BidiAudioIO(audio_processor=BidiAudioProcessorConfig(echo_cancellation=False, stream_delay_ms=10))


# ---------------------------------------------------------------------------
# BidiAudioIO construction and enablement
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("config", [{}, {"audio_processor": False}], ids=["default", "false"])
def test_no_audio_processor_when_processing_disabled(config):
    audio_io = BidiAudioIO(**config)
    input_ = audio_io.input()

    assert audio_io._config["audio_processor"] is None
    assert audio_io._audio_processor_config is None
    assert audio_io._audio_processor is None
    assert input_._audio_processor is None
    assert audio_io.output()._audio_processor is None


def test_audio_processor_shared_between_input_and_output():
    audio_processor_config = BidiAudioProcessorConfig(stream_delay_ms=20)
    audio_io = BidiAudioIO(audio_processor=audio_processor_config)
    input_ = audio_io.input()
    output = audio_io.output()

    assert audio_processor_config == BidiAudioProcessorConfig(stream_delay_ms=20)
    assert audio_io._config["audio_processor"] == BidiAudioProcessorConfig(echo_cancellation=True, stream_delay_ms=20)
    assert audio_io._config["audio_processor"] is not audio_processor_config
    assert audio_io._config["audio_processor"] is audio_io._audio_processor_config
    assert input_._audio_processor is audio_io._audio_processor
    assert output._audio_processor is audio_io._audio_processor


def test_audio_module_import_error_includes_install_instruction():
    module_name = "strands.experimental.bidi._audio.processor"
    module = importlib.import_module(module_name)
    sys.modules.pop(module_name)
    original_import = builtins.__import__

    def import_without_pywebrtc(name, *args, **kwargs):
        if name == "pywebrtc_audio":
            raise ModuleNotFoundError("No module named 'pywebrtc_audio'", name=name)
        return original_import(name, *args, **kwargs)

    try:
        with unittest.mock.patch("builtins.__import__", side_effect=import_without_pywebrtc):
            with pytest.raises(
                ImportError,
                match=(
                    r"No module named 'pywebrtc_audio'.*Audio processing requires this optional dependency"
                    r".*pip install 'strands-agents\[bidi-aec\]'"
                ),
            ):
                BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
    finally:
        sys.modules[module_name] = module


def test_audio_config_is_keyword_only():
    # BidiAudioIO takes only keyword configuration.
    with pytest.raises(TypeError):
        BidiAudioIO(BidiAudioProcessorConfig())  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Stream wiring: buffer alignment and end-to-end callback flow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_input_aligns_buffer_to_10ms_when_echo_cancellation_on(py_audio, aec_agent, mock_audio_processor):
    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
    input_ = audio_io.input()
    await input_.start(aec_agent)

    # 10ms at 16kHz = 160 samples.
    assert py_audio.open.call_args.kwargs["frames_per_buffer"] == 160
    await input_.stop()


@pytest.mark.asyncio
async def test_input_keeps_configured_buffer_when_processing_off(py_audio, aec_agent):
    audio_io = BidiAudioIO(input_frames_per_buffer=1024)
    input_ = audio_io.input()
    await input_.start(aec_agent)

    assert py_audio.open.call_args.kwargs["frames_per_buffer"] == 1024
    await input_.stop()


@pytest.mark.asyncio
async def test_input_keeps_configured_buffer_when_echo_cancellation_off(py_audio, aec_agent, mock_audio_processor):
    audio_io = BidiAudioIO(
        audio_processor=BidiAudioProcessorConfig(echo_cancellation=False),
        input_frames_per_buffer=1024,
    )
    input_ = audio_io.input()
    await input_.start(aec_agent)

    assert py_audio.open.call_args.kwargs["frames_per_buffer"] == 1024
    await input_.stop()


def test_mic_buffer_bounded_to_reference_horizon_when_ec_on(mock_audio_processor):
    # The mic buffer must share the reference buffer's frame bound so both evict in lockstep under a stall,
    # using the configured input buffer size when it is below the processing cap.
    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig(), input_buffer_size=2)
    input_ = audio_io.input()

    assert audio_io._config["audio_processor"] == BidiAudioProcessorConfig(echo_cancellation=True, stream_delay_ms=0)
    assert audio_io._config["input_buffer_size"] == 2
    assert input_._buffer._size == 2
    assert audio_io._audio_processor._far_buffer_size == 2


def test_mic_buffer_defaults_to_processing_limit():
    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig(), input_buffer_size=None)
    input_ = audio_io.input()

    assert audio_io._config["input_buffer_size"] == 100
    assert input_._buffer._size == 100
    assert audio_io._audio_processor._far_buffer_size == 100


@pytest.mark.parametrize("input_buffer_size", [-1, 0, 101, 9999])
def test_mic_buffer_rejects_invalid_size_when_ec_on(input_buffer_size):
    with pytest.raises(ValueError, match="input_buffer_size"):
        BidiAudioIO(audio_processor=BidiAudioProcessorConfig(), input_buffer_size=input_buffer_size)


def test_mic_buffer_uses_configured_size_when_ec_off(pyaudio_module, mock_audio_processor):
    _ = pyaudio_module
    # With echo cancellation off there is no reference to align to, so the user's sizing is respected.
    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig(echo_cancellation=False), input_buffer_size=7)
    input_ = audio_io.input()

    assert input_._buffer._size == 7


@pytest.mark.parametrize(
    "config",
    [
        {"input_frames_per_buffer": 160},
        {"output_frames_per_buffer": 160},
        {"input_frames_per_buffer": 160, "output_frames_per_buffer": 160},
    ],
)
def test_frames_per_buffer_rejected_when_ec_on(config):
    with pytest.raises(ValueError, match="calculated automatically"):
        BidiAudioIO(audio_processor=BidiAudioProcessorConfig(), **config)


@pytest.mark.asyncio
async def test_output_aligns_buffer_to_10ms_at_output_rate(py_audio, agent_mixed_rates, mock_audio_processor):
    # Output stream runs at output_rate (24k here). frame_count is measured in samples at the stream's
    # own rate, so the buffer must be sized off output_rate (240 = 10ms@24k), NOT input_rate (which would
    # give 160 = 6.67ms@24k and produce short, zero-padded reference frames).
    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
    output = audio_io.output()
    await output.start(agent_mixed_rates)

    assert py_audio.open.call_args.kwargs["frames_per_buffer"] == 240
    await output.stop()


@pytest.mark.asyncio
async def test_output_aligns_buffer_to_10ms_matched_rates(py_audio, aec_agent, mock_audio_processor):
    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
    output = audio_io.output()
    await output.start(aec_agent)

    # 10ms at 16kHz = 160 samples.
    assert py_audio.open.call_args.kwargs["frames_per_buffer"] == 160
    await output.stop()


@pytest.mark.asyncio
async def test_output_keeps_configured_buffer_when_processing_off(py_audio, aec_agent):
    audio_io = BidiAudioIO(output_frames_per_buffer=2048)
    output = audio_io.output()
    await output.start(aec_agent)

    assert py_audio.open.call_args.kwargs["frames_per_buffer"] == 2048
    await output.stop()


@pytest.mark.asyncio
async def test_output_keeps_configured_buffer_when_echo_cancellation_off(py_audio, aec_agent):
    audio_io = BidiAudioIO(
        audio_processor=BidiAudioProcessorConfig(echo_cancellation=False),
        output_frames_per_buffer=2048,
    )
    output = audio_io.output()
    await output.start(aec_agent)

    assert py_audio.open.call_args.kwargs["frames_per_buffer"] == 2048
    assert output._audio_processor is None
    await output.stop()


@pytest.mark.asyncio
async def test_input_start_replaces_far_buffer(py_audio, aec_agent):
    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
    input_ = audio_io.input()

    await input_.start(aec_agent)
    first_far_buffer = audio_io._audio_processor._far_buffer
    audio_io._audio_processor.add_far_data(b"\x01\x02")
    await input_.stop()

    await input_.start(aec_agent)

    assert audio_io._audio_processor._far_buffer is not first_far_buffer
    assert audio_io._audio_processor._get_far_data() == b""
    await input_.stop()


@pytest.mark.asyncio
async def test_mixed_rate_reference_matches_mic_frame_length(py_audio, agent_mixed_rates, mock_audio_processor):
    # End-to-end regression for the output-rate bug: with a correctly sized output buffer, a 10ms speaker
    # frame at 24k resamples to exactly a 10ms mic frame at 16k (320 bytes), so the reference is fully real
    # audio with no zero-padding.
    from strands.experimental.bidi.types import BidiAudioStreamEvent

    processor = mock_audio_processor.return_value
    processor.process.return_value = np.zeros(160, dtype=np.int16)
    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
    input_ = audio_io.input()
    output = audio_io.output()
    await input_.start(agent_mixed_rates)
    await output.start(agent_mixed_rates)

    # One 10ms playback frame at 24k = 240 samples = 480 bytes.
    speaker_frame = (np.arange(240, dtype=np.int16)).tobytes()
    await output(
        BidiAudioStreamEvent(
            audio=base64.b64encode(speaker_frame).decode("utf-8"),
            channels=1,
            format="pcm",
            sample_rate=24000,
        )
    )
    output._callback(None, frame_count=240)

    # A 10ms mic frame at 16k = 160 samples = 320 bytes. The resampled reference must fill it with real
    # audio (not zero-padded silence).
    mic = np.zeros(160, dtype=np.int16)
    input_._audio_processor.process(mic.tobytes())
    ref = processor.process.call_args.args[1]
    assert ref.shape == mic.shape
    # With the bug, only ~107 samples of real reference arrive and the trailing ~53 are zero-padded.
    # With the fix, the resampled ramp fills the whole frame, so the final samples are non-zero.
    assert ref[-1] != 0 and ref[-10] != 0

    await input_.stop()
    await output.stop()


@pytest.mark.asyncio
async def test_output_records_reference_at_playback(py_audio, aec_agent, mock_audio_processor):
    from strands.experimental.bidi.types import BidiAudioStreamEvent

    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
    input_ = audio_io.input()
    output = audio_io.output()
    await input_.start(aec_agent)
    await output.start(aec_agent)

    audio_data = b"\x10\x20\x30\x40"
    await output(
        BidiAudioStreamEvent(
            audio=base64.b64encode(audio_data).decode("utf-8"),
            channels=1,
            format="pcm",
            sample_rate=16000,
        )
    )

    # Reference is written only when audio actually exits the speaker (callback).
    assert audio_io._audio_processor._get_far_data() == b""

    played, _ = output._callback(None, frame_count=2)
    assert played == audio_data

    assert audio_io._audio_processor._get_far_data() == audio_data

    await input_.stop()
    await output.stop()


@pytest.mark.asyncio
async def test_output_clears_reference_on_interruption(py_audio, aec_agent, mock_audio_processor):
    from strands.experimental.bidi.types import BidiAudioStreamEvent, BidiInterruptionEvent

    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
    input_ = audio_io.input()
    output = audio_io.output()
    await input_.start(aec_agent)
    await output.start(aec_agent)

    audio_data = b"\x10\x20\x30\x40"
    await output(
        BidiAudioStreamEvent(
            audio=base64.b64encode(audio_data).decode("utf-8"),
            channels=1,
            format="pcm",
            sample_rate=16000,
        )
    )
    output._callback(None, frame_count=2)

    await output(BidiInterruptionEvent(reason="user_speech"))

    assert audio_io._audio_processor._get_far_data() == b""
    await input_.stop()
    await output.stop()


@pytest.mark.asyncio
async def test_input_applies_audio_processing(py_audio, aec_agent, mock_audio_processor):
    frame = np.ones(160, dtype=np.int16) * 1000
    cleaned = np.ones(160, dtype=np.int16) * 200

    processor = mock_audio_processor.return_value
    processor.process.return_value = cleaned

    audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
    input_ = audio_io.input()
    await input_.start(aec_agent)

    input_._buffer.put(frame.tobytes())
    event = await input_()

    await input_.stop()

    result = np.frombuffer(event.source["bytes"], dtype=np.int16)
    np.testing.assert_array_equal(result, cleaned)
