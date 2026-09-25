import numpy as np
import pytest

from strands.experimental.bidi._audio.processor import AudioProcessor


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
    processor = AudioProcessor(
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


# ---------------------------------------------------------------------------
# echo_cancellation toggle behaviour
# ---------------------------------------------------------------------------


def test_processor_construction_respects_echo_cancellation_flag(mock_audio_processor):
    _create_processor(echo_cancellation=False)

    assert mock_audio_processor.call_args.kwargs["echo_cancellation"] is False


@pytest.mark.parametrize("output_rate", [None, 16000])
def test_ec_off_processes_capture_with_none_reference(mock_audio_processor, output_rate):
    frame = np.ones(160, dtype=np.int16) * 1000
    cleaned = np.zeros(160, dtype=np.int16)

    processor = mock_audio_processor.return_value
    processor.process.return_value = cleaned

    proc = _create_processor(echo_cancellation=False, output_rate=output_rate)
    proc.process(frame.tobytes())

    near_frame, reference_frame = processor.process.call_args.args
    np.testing.assert_array_equal(near_frame, frame)
    assert reference_frame is None


def test_process_empty_input_returns_empty(mock_audio_processor):
    # b"" is the shutdown sentinel emitted by AudioBuffer.stop(); it must not reach the C extension.
    processor = mock_audio_processor.return_value

    proc = _create_processor()
    result = proc.process(b"")

    assert result == b""
    processor.process.assert_not_called()


# ---------------------------------------------------------------------------
# AudioProcessor startup and native processor construction
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("rate", "expected"), [(16000, 160), (24000, 240), (48000, 480)])
def test_processor_calculates_frames_per_buffer(rate, expected):
    assert AudioProcessor.frames_per_buffer(rate) == expected


def test_processor_construction_builds_audio_processor_with_config(mock_audio_processor):
    _create_processor(stream_delay_ms=20)

    mock_audio_processor.assert_called_once_with(
        sample_rate=16000,
        num_channels=1,
        echo_cancellation=True,
        noise_suppression=True,
        auto_gain_control=True,
        stream_delay_ms=20,
    )


@pytest.mark.parametrize("num_channels", [0, 2])
@pytest.mark.parametrize("echo_cancellation", [False, True])
def test_processor_start_rejects_non_mono_audio(mock_audio_processor, num_channels, echo_cancellation):
    with pytest.raises(ValueError, match="Audio processing currently supports only mono audio"):
        _create_processor(num_channels=num_channels, echo_cancellation=echo_cancellation)

    mock_audio_processor.assert_not_called()


def test_processor_start_requires_output_rate_for_echo_cancellation(mock_audio_processor):
    with pytest.raises(ValueError, match="Echo cancellation requires output_rate"):
        _create_processor(output_rate=None)

    mock_audio_processor.assert_not_called()


@pytest.mark.parametrize("rate", [8000, 16000, 24000, 44100, 48000, 96000, 384000])
def test_processor_construction_passes_input_rate_to_audio_processor(rate, mock_audio_processor):
    _create_processor(input_rate=rate, output_rate=rate)

    assert mock_audio_processor.call_args.kwargs["sample_rate"] == rate


# ---------------------------------------------------------------------------
# AudioProcessor far data behaviour
# ---------------------------------------------------------------------------


def test_process_passes_reference_to_processor(mock_audio_processor):
    frame = np.ones(160, dtype=np.int16) * 1000
    ref = np.ones(160, dtype=np.int16) * 500
    cleaned = np.ones(160, dtype=np.int16) * 200

    processor = mock_audio_processor.return_value
    processor.process.return_value = cleaned

    proc = _create_processor()
    proc.add_far_data(ref.tobytes())
    result = proc.process(frame.tobytes())

    near_arg, far_arg = processor.process.call_args[0]
    np.testing.assert_array_equal(near_arg, frame)
    np.testing.assert_array_equal(far_arg, ref)
    np.testing.assert_array_equal(np.frombuffer(result, dtype=np.int16), cleaned)


def test_process_passes_silence_when_no_reference(mock_audio_processor):
    # The WebRTC processor rejects a None far-end frame when echo cancellation is on, so an empty
    # reference buffer must be filled with zeros of the same length as the mic frame.
    frame = np.ones(160, dtype=np.int16) * 1000
    cleaned = np.zeros(160, dtype=np.int16)

    processor = mock_audio_processor.return_value
    processor.process.return_value = cleaned

    proc = _create_processor()
    proc.process(frame.tobytes())

    near_arg, far_arg = processor.process.call_args[0]
    assert far_arg is not None
    assert far_arg.shape == near_arg.shape
    np.testing.assert_array_equal(far_arg, np.zeros(160, dtype=np.int16))


def test_reference_overflow_drops_oldest(mock_audio_processor):
    processor = mock_audio_processor.return_value
    processor.process.return_value = np.zeros(2, dtype=np.int16)
    proc = _create_processor(far_buffer_size=2)
    proc.add_far_data(b"\x01\x01\x01\x01")
    proc.add_far_data(b"\x02\x02\x02\x02")
    proc.add_far_data(b"\x03\x03\x03\x03")

    # The oldest complete frame was dropped on overflow.
    proc.process(np.zeros(2, dtype=np.int16).tobytes())

    ref = processor.process.call_args.args[1]
    np.testing.assert_array_equal(ref, np.frombuffer(b"\x02\x02\x02\x02", dtype=np.int16))


def test_clear_far_buffer_drains_reference_but_keeps_filter(mock_audio_processor):
    processor = mock_audio_processor.return_value
    processor.process.return_value = np.zeros(2, dtype=np.int16)

    proc = _create_processor()
    proc.add_far_data(b"\x01\x02\x03\x04")
    proc.clear_far_data()

    # Buffer drained: reference for a 2-sample mic frame is silence.
    proc.process(np.zeros(2, dtype=np.int16).tobytes())

    ref = processor.process.call_args.args[1]
    np.testing.assert_array_equal(ref, np.zeros(2, dtype=np.int16))
    # Barge-in must NOT reset the converged AEC filter.
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
    proc = _create_processor(echo_cancellation=False, output_rate=None)

    rng = np.random.default_rng(0)
    out = np.array([], dtype=np.int16)
    frame = np.array([], dtype=np.int16)
    for _ in range(50):  # let noise suppression / AGC engage
        frame = (rng.standard_normal(160) * 300).astype(np.int16)
        out = np.frombuffer(proc.process(frame.tobytes()), dtype=np.int16)

    assert len(out) == len(frame)
    assert not np.array_equal(out, frame)
