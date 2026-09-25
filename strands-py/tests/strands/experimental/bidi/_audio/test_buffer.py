import pytest

from strands.experimental.bidi._audio.buffer import AudioBuffer


@pytest.fixture
def audio_buffer():
    buffer = AudioBuffer(size=1)
    buffer.start()
    yield buffer
    buffer.stop()


def test_audio_buffer_put(audio_buffer):
    audio_buffer.put(b"test-chunk")

    tru_chunk = audio_buffer.get()
    exp_chunk = b"test-chunk"
    assert tru_chunk == exp_chunk


def test_audio_buffer_put_full(audio_buffer):
    audio_buffer.put(b"test-chunk-1")
    audio_buffer.put(b"test-chunk-2")

    tru_chunk = audio_buffer.get()
    exp_chunk = b"test-chunk-2"
    assert tru_chunk == exp_chunk


def test_audio_buffer_get_padding(audio_buffer):
    audio_buffer.put(b"test-chunk")

    tru_chunk = audio_buffer.get(11)
    exp_chunk = b"test-chunk\x00"
    assert tru_chunk == exp_chunk


def test_audio_buffer_clear(audio_buffer):
    audio_buffer.put(b"test-chunk")
    audio_buffer.clear()

    tru_byte = audio_buffer.get(1)
    exp_byte = b"\x00"
    assert tru_byte == exp_byte


def test_audio_buffer_clear_discards_partial_data(audio_buffer):
    audio_buffer.put(b"ab")
    assert audio_buffer.get(1) == b"a"

    audio_buffer.clear()

    assert audio_buffer.get(1) == b"\x00"


def test_audio_buffer_stop_when_full():
    # A bounded buffer can be full at teardown (e.g. after a stall while the consumer is paused). stop()
    # can skip the shutdown sentinel because queued data is already available to unblock a consumer.
    buffer = AudioBuffer(size=2)
    buffer.start()
    buffer.put(b"a")
    buffer.put(b"b")

    buffer.stop()  # must not raise queue.Full
