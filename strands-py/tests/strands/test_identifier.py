import uuid
from unittest.mock import patch

import pytest

from strands import _identifier


@pytest.mark.parametrize("type_", list(_identifier.Identifier))
def test_validate(type_):
    tru_id = _identifier.validate("abc", type_)
    exp_id = "abc"
    assert tru_id == exp_id


@pytest.mark.parametrize("type_", list(_identifier.Identifier))
def test_validate_invalid(type_):
    id_ = "a/../b"
    with pytest.raises(ValueError, match=f"{type_.value}={id_} | id cannot contain path separators"):
        _identifier.validate(id_, type_)


def test_new_uuid7_is_valid_uuidv7():
    """Generated ids are valid version-7 UUIDs and pass the predicate."""
    generated_id = _identifier.new_uuid7()
    parsed = uuid.UUID(generated_id)
    assert parsed.version == 7
    assert (parsed.int >> 62) & 0b11 == 0b10  # RFC 4122 variant
    assert _identifier.is_uuid7(generated_id)


def test_uuid7_ids_sort_in_creation_order():
    """Ids minted in sequence sort lexicographically into creation order."""
    ids = [_identifier.new_uuid7() for _ in range(1000)]
    assert len(set(ids)) == len(ids)
    assert ids == sorted(ids)


def test_uuid7_ids_stay_monotonic_past_counter_overflow():
    """Minting >4096 ids in one millisecond keeps them unique, valid v7, and strictly increasing.

    Guards the 12-bit intra-millisecond counter: on overflow it must borrow from the clock, not
    wrap backwards, which would break the sort-equals-creation-order property callers rely on.
    """
    with patch.object(_identifier.time, "time", return_value=1_000.0):
        ids = [_identifier.new_uuid7() for _ in range(20_000)]

    assert len(set(ids)) == len(ids)  # unique
    assert all(uuid.UUID(generated_id).version == 7 for generated_id in ids)  # valid v7
    assert all((uuid.UUID(generated_id).int >> 62) & 0b11 == 0b10 for generated_id in ids)  # variant intact
    assert all(ids[index] < ids[index + 1] for index in range(len(ids) - 1))  # strictly increasing


@pytest.mark.parametrize(
    "bad_id",
    [
        "not-a-uuid",
        "00000000-0000-4000-8000-000000000000",  # version 4, not 7
        "",
    ],
)
def test_is_uuid7_rejects_non_uuidv7(bad_id):
    """Malformed strings and non-v7 UUIDs are rejected."""
    assert not _identifier.is_uuid7(bad_id)


def test_is_uuid7_rejects_trailing_newline():
    """A trailing newline cannot slip past the pattern (\\A...\\Z, not ^...$)."""
    assert not _identifier.is_uuid7(_identifier.new_uuid7() + "\n")
