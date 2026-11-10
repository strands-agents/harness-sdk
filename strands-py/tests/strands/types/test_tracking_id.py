"""Tests for the durable message tracking id and its generator."""

from uuid import UUID

from strands.types.content import Message, _ensure_tracking_id, _generate_tracking_id


def test_generate_tracking_id_is_unique():
    ids = {_generate_tracking_id() for _ in range(1000)}
    assert len(ids) == 1000


def test_generate_tracking_id_is_canonical_uuid_v4():
    tracking_id = _generate_tracking_id()
    assert isinstance(tracking_id, str)
    parsed = UUID(tracking_id)  # raises if not a valid UUID
    # Canonical hyphenated form, matching the TypeScript SDK's crypto.randomUUID() shape.
    assert str(parsed) == tracking_id
    assert parsed.version == 4


def test_tracking_id_does_not_affect_role_and_content():
    msg: Message = {"role": "assistant", "content": [{"text": "hello"}], "tracking_id": "abc123"}
    assert msg["role"] == "assistant"
    assert msg["content"] == [{"text": "hello"}]


def test_ensure_tracking_id_assigns_when_absent():
    msg: Message = {"role": "user", "content": [{"text": "hi"}]}
    returned = _ensure_tracking_id(msg)
    assert isinstance(msg["tracking_id"], str) and msg["tracking_id"]
    # Returns the assigned id for caller convenience.
    assert returned == msg["tracking_id"]


def test_ensure_tracking_id_preserves_existing():
    msg: Message = {"role": "user", "content": [{"text": "hi"}], "tracking_id": "caller-supplied"}
    returned = _ensure_tracking_id(msg)
    assert msg["tracking_id"] == "caller-supplied"
    assert returned == "caller-supplied"


def test_ensure_tracking_id_replaces_empty_id():
    # An empty tracking id cannot serve as a durable key, so it is treated as absent and replaced.
    msg: Message = {"role": "user", "content": [{"text": "hi"}], "tracking_id": ""}
    _ensure_tracking_id(msg)
    assert msg["tracking_id"]
    UUID(msg["tracking_id"])  # raises if not a valid UUID
