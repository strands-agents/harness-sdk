import base64
import builtins
import sys
import unittest.mock

import numpy as np
import pytest
import pytest_asyncio

from strands.experimental.bidi._audio import _BidiAudioProcessor
from strands.experimental.bidi.io.audio import BidiAudioIO, BidiAudioProcessorConfig, _BidiAudioBuffer
from strands.experimental.bidi.models import AudioCapable
from strands.experimental.bidi.types.events import BidiAudioInputEvent, BidiAudioStreamEvent, BidiInterruptionEvent


def _fake_audio_processor(processor=None):
    """Patch the module-level AudioProcessor with a test double."""
    processor = processor or unittest.mock.MagicMock()
    processor_class = unittest.mock.MagicMock(return_value=processor)
    processor_patch = unittest.mock.patch("strands.experimental.bidi._audio.AudioProcessor", processor_class)
    return processor_patch, processor_class, processor


def _create_processor(
    *,
    input_rate=16000,
    output_rate=16000,
    num_channels=1,
    echo_cancellation=True,
    stream_delay_ms=0,
    far_buffer_size=100,
):
    """Create and start an audio processor."""
    processor = _BidiAudioProcessor(
        echo_cancellation=echo_cancellation,
        stream_delay_ms=stream_delay_ms,
        far_buffer_size=far_buffer_size if echo_cancellation else None,
    )
    processor.start(
        input_rate=input_rate,
        output_rate=output_rate,
        num_channels=num_channels,
    )
    return processor


@pytest.fixture
def audio_buffer():
    buffer = _BidiAudioBuffer(size=1)
    buffer.start()
    yield buffer
    buffer.stop()


@pytest.fixture
def agent():
    mock = unittest.mock.MagicMock()
    mock.model = unittest.mock.MagicMock(spec=AudioCapable)
    mock.model.get_audio_config.return_value = {
        "input_rate": 24000,
        "output_rate": 16000,
        "channels": 2,
        "format": "test-format",
    }
    return mock


@pytest.fixture
def aec_agent():
    mock = unittest.mock.MagicMock()
    mock.model = unittest.mock.MagicMock(spec=AudioCapable)
    mock.model.get_audio_config.return_value = {
        "input_rate": 16000,
        "output_rate": 16000,
        "channels": 1,
        "format": "pcm",
    }
    return mock


@pytest.fixture
def agent_mixed_rates():
    mock = unittest.mock.MagicMock()
    mock.model = unittest.mock.MagicMock(spec=AudioCapable)
    mock.model.get_audio_config.return_value = {
        "input_rate": 16000,
        "output_rate": 24000,
        "channels": 1,
        "format": "pcm",
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


def test_bidi_audio_buffer_put(audio_buffer):
    audio_buffer.put(b"test-chunk")

    tru_chunk = audio_buffer.get()
    exp_chunk = b"test-chunk"
    assert tru_chunk == exp_chunk


def test_bidi_audio_buffer_put_full(audio_buffer):
    audio_buffer.put(b"test-chunk-1")
    audio_buffer.put(b"test-chunk-2")

    tru_chunk = audio_buffer.get()
    exp_chunk = b"test-chunk-2"
    assert tru_chunk == exp_chunk


def test_bidi_audio_buffer_get_padding(audio_buffer):
    audio_buffer.put(b"test-chunk")

    tru_chunk = audio_buffer.get(11)
    exp_chunk = b"test-chunk\x00"
    assert tru_chunk == exp_chunk


def test_bidi_audio_buffer_clear(audio_buffer):
    audio_buffer.put(b"test-chunk")
    audio_buffer.clear()

    tru_byte = audio_buffer.get(1)
    exp_byte = b"\x00"
    assert tru_byte == exp_byte


def test_bidi_audio_buffer_clear_discards_partial_data(audio_buffer):
    audio_buffer.put(b"ab")
    assert audio_buffer.get(1) == b"a"

    audio_buffer.clear()

    assert audio_buffer.get(1) == b"\x00"


def test_bidi_audio_buffer_stop_when_full():
    # A bounded buffer can be full at teardown (e.g. after a stall while the consumer is paused). stop()
    # can skip the shutdown sentinel because queued data is already available to unblock a consumer.
    buffer = _BidiAudioBuffer(size=2)
    buffer.start()
    buffer.put(b"a")
    buffer.put(b"b")

    buffer.stop()  # must not raise queue.Full


@pytest.mark.asyncio
async def test_bidi_audio_io_input(audio_input):
    audio_input._callback(b"test-audio")

    tru_event = await audio_input()
    exp_event = BidiAudioInputEvent(
        audio=base64.b64encode(b"test-audio").decode("utf-8"),
        channels=2,
        format="test-format",
        sample_rate=24000,
    )
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
        format="test-format",
        sample_rate=16000,
    )
    await audio_output(audio_event)

    tru_data, _ = audio_output._callback(None, frame_count=4)
    exp_data = b"test-aud"
    assert tru_data == exp_data


@pytest.mark.asyncio
async def test_bidi_audio_io_output_interrupt(audio_output):
    audio_event = BidiAudioStreamEvent(
        audio=base64.b64encode(b"test-audio").decode("utf-8"),
        channels=2,
        format="test-format",
        sample_rate=16000,
    )
    await audio_output(audio_event)
    interrupt_event = BidiInterruptionEvent(reason="user_speech")
    await audio_output(interrupt_event)

    tru_data, _ = audio_output._callback(None, frame_count=1)
    exp_data = b"\x00\x00"
    assert tru_data == exp_data


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
# echo_cancellation toggle behaviour
# ---------------------------------------------------------------------------


def test_processor_construction_respects_echo_cancellation_flag():
    processor_patch, processor_class, _ = _fake_audio_processor()
    with processor_patch:
        _create_processor(echo_cancellation=False)

    assert processor_class.call_args.kwargs["echo_cancellation"] is False


def test_ec_off_processes_capture_with_none_reference():
    frame = np.ones(160, dtype=np.int16) * 1000
    cleaned = np.zeros(160, dtype=np.int16)

    processor = unittest.mock.MagicMock()
    processor.process.return_value = cleaned
    processor_patch, _, _ = _fake_audio_processor(processor)

    with processor_patch:
        proc = _create_processor(echo_cancellation=False)
        proc.process(frame.tobytes())

    assert len(processor.process.call_args.args) == 2
    np.testing.assert_array_equal(processor.process.call_args.args[0], frame)
    assert processor.process.call_args.args[1] is None


def test_process_empty_input_returns_empty():
    # b"" is the shutdown sentinel emitted by _BidiAudioBuffer.stop(); it must not reach the C extension.
    processor = unittest.mock.MagicMock()
    processor_patch, _, _ = _fake_audio_processor(processor)

    with processor_patch:
        proc = _create_processor()
        result = proc.process(b"")

    assert result == b""
    processor.process.assert_not_called()


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
    module_name = "strands.experimental.bidi._audio"
    module = sys.modules.pop(module_name)
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
# _BidiAudioProcessor startup and native processor construction
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("rate", "expected"), [(16000, 160), (24000, 240), (48000, 480)])
def test_processor_calculates_frames_per_buffer(rate, expected):
    assert _BidiAudioProcessor.frames_per_buffer(rate) == expected


def test_processor_construction_builds_audio_processor_with_config():
    processor_patch, processor_class, _ = _fake_audio_processor()
    with processor_patch:
        _create_processor(stream_delay_ms=20)

    processor_class.assert_called_once_with(
        sample_rate=16000,
        num_channels=1,
        echo_cancellation=True,
        noise_suppression=True,
        auto_gain_control=True,
        stream_delay_ms=20,
    )


@pytest.mark.parametrize("rate", [8000, 16000, 24000, 44100, 48000, 96000, 384000])
def test_processor_construction_passes_input_rate_to_audio_processor(rate):
    processor_patch, processor_class, _ = _fake_audio_processor()
    with processor_patch:
        _create_processor(input_rate=rate, output_rate=rate)

    assert processor_class.call_args.kwargs["sample_rate"] == rate


# ---------------------------------------------------------------------------
# _BidiAudioProcessor far data behaviour
# ---------------------------------------------------------------------------


def test_process_passes_reference_to_processor():
    frame = np.ones(160, dtype=np.int16) * 1000
    ref = np.ones(160, dtype=np.int16) * 500
    cleaned = np.ones(160, dtype=np.int16) * 200

    processor = unittest.mock.MagicMock()
    processor.process.return_value = cleaned
    processor_patch, _, _ = _fake_audio_processor(processor)

    with processor_patch:
        proc = _create_processor()
        proc.add_far_data(ref.tobytes())
        result = proc.process(frame.tobytes())

    near_arg, far_arg = processor.process.call_args[0]
    np.testing.assert_array_equal(near_arg, frame)
    np.testing.assert_array_equal(far_arg, ref)
    np.testing.assert_array_equal(np.frombuffer(result, dtype=np.int16), cleaned)


def test_process_passes_silence_when_no_reference():
    # The WebRTC processor rejects a None far-end frame when echo cancellation is on, so an empty
    # reference buffer must be filled with zeros of the same length as the mic frame.
    frame = np.ones(160, dtype=np.int16) * 1000
    cleaned = np.zeros(160, dtype=np.int16)

    processor = unittest.mock.MagicMock()
    processor.process.return_value = cleaned
    processor_patch, _, _ = _fake_audio_processor(processor)

    with processor_patch:
        proc = _create_processor()
        proc.process(frame.tobytes())

    near_arg, far_arg = processor.process.call_args[0]
    assert far_arg is not None
    assert far_arg.shape == near_arg.shape
    np.testing.assert_array_equal(far_arg, np.zeros(160, dtype=np.int16))


def test_reference_overflow_drops_oldest():
    processor = unittest.mock.MagicMock()
    processor.process.return_value = np.zeros(2, dtype=np.int16)
    processor_patch, _, _ = _fake_audio_processor(processor)
    with processor_patch:
        proc = _create_processor(far_buffer_size=2)
        proc.add_far_data(b"\x01\x01\x01\x01")
        proc.add_far_data(b"\x02\x02\x02\x02")
        proc.add_far_data(b"\x03\x03\x03\x03")

        # The oldest complete frame was dropped on overflow.
        proc.process(np.zeros(2, dtype=np.int16).tobytes())

    ref = processor.process.call_args.args[1]
    np.testing.assert_array_equal(ref, np.frombuffer(b"\x02\x02\x02\x02", dtype=np.int16))


def test_clear_far_buffer_drains_reference_but_keeps_filter():
    processor = unittest.mock.MagicMock()
    processor.process.return_value = np.zeros(2, dtype=np.int16)
    processor_patch, _, _ = _fake_audio_processor(processor)

    with processor_patch:
        proc = _create_processor()
        proc.add_far_data(b"\x01\x02\x03\x04")
        proc.clear_far_data()

        # Buffer drained: reference for a 2-sample mic frame is silence.
        proc.process(np.zeros(2, dtype=np.int16).tobytes())

    ref = processor.process.call_args.args[1]
    np.testing.assert_array_equal(ref, np.zeros(2, dtype=np.int16))
    # Interruption must NOT reset the converged AEC filter.
    processor.reset.assert_not_called()


# ---------------------------------------------------------------------------
# Reference resampling (edge case: output rate != input rate)
# ---------------------------------------------------------------------------


def test_resample_same_rate_unchanged():
    proc = _create_processor()
    samples = np.array([100, 200, 300, 400], dtype=np.int16)
    np.testing.assert_array_equal(proc._resample(samples), samples)


def test_resample_downsample_length():
    proc = _create_processor(output_rate=24000)
    samples = np.arange(240, dtype=np.int16)
    result = proc._resample(samples)
    assert len(result) == round(240 * (16000 / 24000))


def test_resample_upsample_length():
    proc = _create_processor(input_rate=32000)
    samples = np.arange(160, dtype=np.int16)
    result = proc._resample(samples)
    assert len(result) == round(160 * (32000 / 16000))


# ---------------------------------------------------------------------------
# Stream wiring: buffer alignment and end-to-end callback flow
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_input_aligns_buffer_to_10ms_when_echo_cancellation_on(py_audio, aec_agent):
    processor_patch, _, _ = _fake_audio_processor()
    with processor_patch:
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
async def test_input_keeps_configured_buffer_when_echo_cancellation_off(py_audio, aec_agent):
    processor_patch, _, _ = _fake_audio_processor()
    with processor_patch:
        audio_io = BidiAudioIO(
            audio_processor=BidiAudioProcessorConfig(echo_cancellation=False),
            input_frames_per_buffer=1024,
        )
        input_ = audio_io.input()
        await input_.start(aec_agent)

    assert py_audio.open.call_args.kwargs["frames_per_buffer"] == 1024
    await input_.stop()


def test_mic_buffer_bounded_to_reference_horizon_when_ec_on():
    # The mic buffer must share the reference buffer's frame bound so both evict in lockstep under a stall,
    # using the configured input buffer size when it is below the processing cap.
    processor_patch, _, _ = _fake_audio_processor()
    with processor_patch:
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


def test_mic_buffer_uses_configured_size_when_ec_off(pyaudio_module):
    _ = pyaudio_module
    # With echo cancellation off there is no reference to align to, so the user's sizing is respected.
    processor_patch, _, _ = _fake_audio_processor()
    with processor_patch:
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
async def test_output_aligns_buffer_to_10ms_at_output_rate(py_audio, agent_mixed_rates):
    # Output stream runs at output_rate (24k here). frame_count is measured in samples at the stream's
    # own rate, so the buffer must be sized off output_rate (240 = 10ms@24k), NOT input_rate (which would
    # give 160 = 6.67ms@24k and produce short, zero-padded reference frames).
    processor_patch, _, _ = _fake_audio_processor()
    with processor_patch:
        audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
        output = audio_io.output()
        await output.start(agent_mixed_rates)

    assert py_audio.open.call_args.kwargs["frames_per_buffer"] == 240
    await output.stop()


@pytest.mark.asyncio
async def test_output_aligns_buffer_to_10ms_matched_rates(py_audio, aec_agent):
    processor_patch, _, _ = _fake_audio_processor()
    with processor_patch:
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
async def test_mixed_rate_reference_matches_mic_frame_length(py_audio, agent_mixed_rates):
    # End-to-end regression for the output-rate bug: with a correctly sized output buffer, a 10ms speaker
    # frame at 24k resamples to exactly a 10ms mic frame at 16k (320 bytes), so the reference is fully real
    # audio with no zero-padding.
    from strands.experimental.bidi.types.events import BidiAudioStreamEvent

    processor = unittest.mock.MagicMock()
    processor.process.return_value = np.zeros(160, dtype=np.int16)
    processor_patch, _, _ = _fake_audio_processor(processor)
    with processor_patch:
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
async def test_output_records_reference_at_playback(py_audio, aec_agent):
    from strands.experimental.bidi.types.events import BidiAudioStreamEvent

    processor_patch, _, _ = _fake_audio_processor()
    with processor_patch:
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
async def test_output_clears_reference_on_interruption(py_audio, aec_agent):
    from strands.experimental.bidi.types.events import BidiAudioStreamEvent, BidiInterruptionEvent

    processor_patch, _, _ = _fake_audio_processor()
    with processor_patch:
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
async def test_input_applies_audio_processing(py_audio, aec_agent):
    frame = np.ones(160, dtype=np.int16) * 1000
    cleaned = np.ones(160, dtype=np.int16) * 200

    processor = unittest.mock.MagicMock()
    processor.process.return_value = cleaned
    processor_patch, _, _ = _fake_audio_processor(processor)

    with processor_patch:
        audio_io = BidiAudioIO(audio_processor=BidiAudioProcessorConfig())
        input_ = audio_io.input()
        await input_.start(aec_agent)

        input_._buffer.put(frame.tobytes())
        event = await input_()

        await input_.stop()

    result = np.frombuffer(base64.b64decode(event.audio), dtype=np.int16)
    np.testing.assert_array_equal(result, cleaned)


# ---------------------------------------------------------------------------
# Real pywebrtc-audio library contract (skipped when the extra is not installed)
#
# The tests above mock the C extension. These exercise the actual library — pure
# compute, no audio hardware — to catch contract drift the mocks cannot (e.g. the
# far=None-when-EC-on rejection, empty-frame rejection, and output length).
# ---------------------------------------------------------------------------


def test_real_library_roundtrip_and_contract():
    pytest.importorskip("pywebrtc_audio")

    # Echo cancellation on: first frame with an empty reference buffer must not crash (the empty buffer is
    # zero-filled, never passed as None), and output length matches input.
    proc = _create_processor()

    mic = (np.ones(160, dtype=np.int16) * 1000).tobytes()
    out = proc.process(mic)
    assert len(out) == len(mic)

    # With a recorded reference the pairing still yields a matching-length frame.
    proc.add_far_data((np.ones(160, dtype=np.int16) * 500).tobytes())
    assert len(proc.process(mic)) == len(mic)

    # The empty shutdown sentinel is returned unchanged rather than reaching the C extension.
    assert proc.process(b"") == b""

    # With echo cancellation on, the library rejects a None far-end frame. This is why an empty playback
    # buffer must be zero-filled before invoking the native processor.
    with pytest.raises(ValueError):
        proc._processor.process(np.zeros(160, dtype=np.int16), None)


def test_real_library_echo_cancellation_off_still_processes():
    pytest.importorskip("pywebrtc_audio")

    # Echo cancellation off: no reference is used (far=None) and the frame is still processed by noise
    # suppression / AGC. Assert the output actually differs from the input, so the test fails if the config
    # were ignored (a length-only check would pass even on an identity pass-through).
    proc = _create_processor(echo_cancellation=False)

    rng = np.random.default_rng(0)
    out = np.array([], dtype=np.int16)
    frame = np.array([], dtype=np.int16)
    for _ in range(50):  # let noise suppression / AGC engage
        frame = (rng.standard_normal(160) * 300).astype(np.int16)
        out = np.frombuffer(proc.process(frame.tobytes()), dtype=np.int16)

    assert len(out) == len(frame)
    assert not np.array_equal(out, frame)
