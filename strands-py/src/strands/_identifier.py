"""Strands identifier utilities."""

import enum
import os
import re
import threading
import time
import uuid


class Identifier(enum.Enum):
    """Strands identifier types."""

    AGENT = "agent"
    SESSION = "session"


def validate(id_: str, type_: Identifier) -> str:
    """Validate strands id.

    Args:
        id_: Id to validate.
        type_: Type of the identifier (e.g., session id, agent id, etc.)

    Returns:
        Validated id.

    Raises:
        ValueError: If id contains path separators.
    """
    if os.path.basename(id_) != id_:
        raise ValueError(f"{type_.value}_id={id_} | id cannot contain path separators")

    return id_


# UUIDv7 monotonic counter state (RFC 9562 method 2), persisted across calls so that ids minted
# inside the same millisecond are still ordered by an incrementing counter.
_uuid7_state_lock = threading.Lock()
_uuid7_last_timestamp_ms = -1
_uuid7_intra_ms_counter = 0


def new_uuid7() -> str:
    """Return a fresh, monotonic UUID version 7 (RFC 9562).

    The 48-bit millisecond timestamp in the high bits makes lexicographic order equal creation
    order, so a set of these ids can be listed oldest-first by sorting alone — no separate index.
    Monotonic across calls, including bursts that mint more than 4096 ids inside one millisecond.

    ``uuid.uuid7`` is only available in Python 3.14+, below the SDK's floor, hence this
    implementation.
    """
    global _uuid7_last_timestamp_ms, _uuid7_intra_ms_counter

    with _uuid7_state_lock:
        now_ms = int(time.time() * 1000)
        if now_ms > _uuid7_last_timestamp_ms:
            _uuid7_last_timestamp_ms = now_ms
            # Seed in the low half of the 12-bit field (fresh randomness for uniqueness) so at
            # least 2048 increments fit before overflow.
            _uuid7_intra_ms_counter = int.from_bytes(os.urandom(2), "big") & 0x07FF
        else:
            _uuid7_intra_ms_counter += 1
            if _uuid7_intra_ms_counter > 0x0FFF:
                # Counter exhausted within this millisecond: borrow from the clock by advancing
                # the timestamp 1ms (RFC 9562 method 1), keeping ids strictly increasing rather
                # than wrapping the counter field backwards.
                _uuid7_last_timestamp_ms += 1
                _uuid7_intra_ms_counter = int.from_bytes(os.urandom(2), "big") & 0x07FF
        counter = _uuid7_intra_ms_counter
        timestamp_ms = _uuid7_last_timestamp_ms

    # Layout: 48-bit ms timestamp | version(7) | 12-bit counter | variant(0b10) | 62 random bits.
    value = (timestamp_ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= (counter & 0x0FFF) << 64
    value |= 0b10 << 62
    value |= int.from_bytes(os.urandom(8), "big") & ((1 << 62) - 1)
    return str(uuid.UUID(int=value))


# ``\A...\Z`` (not ``^...$``) so a trailing newline cannot slip past into a value derived from
# the id, such as a storage key.
_UUID7_PATTERN = re.compile(r"\A[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")


def is_uuid7(value: str) -> bool:
    """Return True if the string is a canonical lowercase UUID version 7.

    Args:
        value: The string to check.
    """
    return _UUID7_PATTERN.match(value) is not None
