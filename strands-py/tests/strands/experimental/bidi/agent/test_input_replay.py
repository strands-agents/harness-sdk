from strands.experimental.bidi.agent._input_replay import _InputReplayBuffer
from strands.experimental.bidi.types import AudioDelta


def _delta(data: bytes) -> AudioDelta:
    return AudioDelta(format="pcm", source={"bytes": data})


def test_snapshot_returns_deltas_within_window_oldest_first():
    buffer = _InputReplayBuffer(window_s=2.0)
    old, mid, new = _delta(b"old"), _delta(b"mid"), _delta(b"new")
    buffer.append(old, now=0.0)
    buffer.append(mid, now=1.5)
    buffer.append(new, now=2.5)

    assert buffer.snapshot(now=3.0) == [mid, new]


def test_snapshot_keeps_deltas_for_a_later_restart():
    buffer = _InputReplayBuffer(window_s=2.0)
    delta = _delta(b"a")
    buffer.append(delta, now=0.0)

    assert buffer.snapshot(now=1.0) == [delta]
    assert buffer.snapshot(now=1.5) == [delta]


def test_byte_cap_drops_oldest_deltas():
    buffer = _InputReplayBuffer(window_s=60.0, max_bytes=6)
    first, second, third = _delta(b"aaa"), _delta(b"bbb"), _delta(b"ccc")
    buffer.append(first, now=0.0)
    buffer.append(second, now=0.1)
    buffer.append(third, now=0.2)

    assert buffer.snapshot(now=0.3) == [second, third]


def test_clear_forgets_retained_audio():
    buffer = _InputReplayBuffer()
    buffer.append(_delta(b"a"), now=0.0)

    buffer.clear()

    assert buffer.snapshot(now=0.0) == []
