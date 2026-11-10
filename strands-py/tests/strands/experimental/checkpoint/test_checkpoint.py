"""Tests for strands.experimental.checkpoint — Checkpoint serialization."""

import pytest

from strands.experimental.checkpoint import CHECKPOINT_SCHEMA_VERSION, Checkpoint
from strands.types.exceptions import CheckpointException


def test_checkpoint_to_dict_from_dict_round_trip():
    checkpoint = Checkpoint(position="after_model", cycle_index=1)
    data = checkpoint.to_dict()
    restored = Checkpoint.from_dict(data)

    # Full-object equality catches any future-added field that isn't round-tripped
    # correctly, without requiring this test to be updated for every new field.
    assert restored == checkpoint
    # schema_version is init=False, so it is always set to the current constant —
    # asserted once explicitly since dataclass equality covers it via __eq__.
    assert restored.schema_version == CHECKPOINT_SCHEMA_VERSION


def test_checkpoint_init_schema_version_immutable():
    checkpoint = Checkpoint(position="after_tools")
    assert checkpoint.schema_version == CHECKPOINT_SCHEMA_VERSION


def test_checkpoint_init_defaults():
    checkpoint = Checkpoint(position="after_model")
    assert checkpoint.cycle_index == 0


def test_checkpoint_from_dict_schema_version_mismatch_raises():
    data = Checkpoint(position="after_model").to_dict()
    data["schema_version"] = "0.0"
    with pytest.raises(CheckpointException, match="not compatible with current version"):
        Checkpoint.from_dict(data)


def test_checkpoint_from_dict_missing_schema_version_raises():
    data = {"position": "after_model", "cycle_index": 0}
    with pytest.raises(CheckpointException, match="not compatible with current version"):
        Checkpoint.from_dict(data)


def test_checkpoint_from_dict_unknown_fields_warns(caplog):
    data = Checkpoint(position="after_tools").to_dict()
    data["unknown_future_field"] = "something"
    restored = Checkpoint.from_dict(data)
    assert restored.position == "after_tools"
    assert "unknown_future_field" in caplog.text


def test_checkpoint_from_dict_ignores_legacy_reserved_fields(caplog):
    # Checkpoints serialized before snapshot/app_data were removed must still
    # deserialize: the now-unknown keys are warned about and dropped.
    data = {
        "position": "after_tools",
        "cycle_index": 2,
        "snapshot": {"messages": []},
        "app_data": {"workflow_id": "wf-123"},
        "schema_version": CHECKPOINT_SCHEMA_VERSION,
    }
    restored = Checkpoint.from_dict(data)
    assert restored == Checkpoint(position="after_tools", cycle_index=2)
    assert not hasattr(restored, "snapshot")
    assert not hasattr(restored, "app_data")
    assert "snapshot" in caplog.text and "app_data" in caplog.text
