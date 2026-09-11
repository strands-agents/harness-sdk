"""Tests for JSONSerializableDict class."""

import copy
import pickle

import pytest

from strands.types.json_dict import JSONSerializableDict


def test_set_and_get():
    """Test basic set and get operations."""
    state = JSONSerializableDict()
    state.set("key", "value")
    assert state.get("key") == "value"


def test_get_nonexistent_key():
    """Test getting nonexistent key returns None."""
    state = JSONSerializableDict()
    assert state.get("nonexistent") is None


def test_get_entire_state():
    """Test getting entire state when no key specified."""
    state = JSONSerializableDict()
    state.set("key1", "value1")
    state.set("key2", "value2")

    result = state.get()
    assert result == {"key1": "value1", "key2": "value2"}


def test_initialize_and_get_entire_state():
    """Test getting entire state when no key specified."""
    state = JSONSerializableDict({"key1": "value1", "key2": "value2"})

    result = state.get()
    assert result == {"key1": "value1", "key2": "value2"}


def test_initialize_with_error():
    with pytest.raises(ValueError, match="not JSON serializable"):
        JSONSerializableDict({"object", object()})


def test_delete():
    """Test deleting keys."""
    state = JSONSerializableDict()
    state.set("key1", "value1")
    state.set("key2", "value2")

    state.delete("key1")

    assert state.get("key1") is None
    assert state.get("key2") == "value2"


def test_delete_nonexistent_key():
    """Test deleting nonexistent key doesn't raise error."""
    state = JSONSerializableDict()
    state.delete("nonexistent")  # Should not raise


def test_json_serializable_values():
    """Test that only JSON-serializable values are accepted."""
    state = JSONSerializableDict()

    # Valid JSON types
    state.set("string", "test")
    state.set("int", 42)
    state.set("bool", True)
    state.set("list", [1, 2, 3])
    state.set("dict", {"nested": "value"})
    state.set("null", None)

    # Invalid JSON types should raise ValueError
    with pytest.raises(ValueError, match="not JSON serializable"):
        state.set("function", lambda x: x)

    with pytest.raises(ValueError, match="not JSON serializable"):
        state.set("object", object())


def test_key_validation():
    """Test key validation for set and delete operations."""
    state = JSONSerializableDict()

    # Invalid keys for set
    with pytest.raises(ValueError, match="Key cannot be None"):
        state.set(None, "value")

    with pytest.raises(ValueError, match="Key cannot be empty"):
        state.set("", "value")

    with pytest.raises(ValueError, match="Key must be a string"):
        state.set(123, "value")

    # Invalid keys for delete
    with pytest.raises(ValueError, match="Key cannot be None"):
        state.delete(None)

    with pytest.raises(ValueError, match="Key cannot be empty"):
        state.delete("")


def test_initial_state():
    """Test initialization with initial state."""
    initial = {"key1": "value1", "key2": "value2"}
    state = JSONSerializableDict(initial_state=initial)

    assert state.get("key1") == "value1"
    assert state.get("key2") == "value2"
    assert state.get() == initial


# ============================================================================
# Version Tracking Tests
# ============================================================================


def test_version_is_zero_after_initialization():
    """Test that _get_version() returns 0 after initialization."""
    state = JSONSerializableDict()
    assert state._get_version() == 0


def test_version_is_zero_after_initialization_with_initial_state():
    """Test that _get_version() returns 0 when initialized with initial_state."""
    state = JSONSerializableDict(initial_state={"key": "value"})
    assert state._get_version() == 0


def test_version_increments_after_set():
    """Test that _get_version() increments after set() is called."""
    state = JSONSerializableDict()
    assert state._get_version() == 0

    state.set("key", "value")
    assert state._get_version() == 1

    state.set("key2", "value2")
    assert state._get_version() == 2


def test_version_increments_after_delete():
    """Test that _get_version() increments after delete() is called."""
    state = JSONSerializableDict(initial_state={"key": "value"})
    assert state._get_version() == 0

    state.delete("key")
    assert state._get_version() == 1


def test_version_increments_after_delete_nonexistent_key():
    """Test that _get_version() increments after delete() on nonexistent key."""
    state = JSONSerializableDict()
    assert state._get_version() == 0

    state.delete("nonexistent")
    assert state._get_version() == 1


def test_version_increments_independently():
    """Test that version increments independently for each operation."""
    state = JSONSerializableDict()
    initial_version = state._get_version()

    state.set("key1", "value1")
    version_after_first_set = state._get_version()
    assert version_after_first_set == initial_version + 1

    state.set("key2", "value2")
    version_after_second_set = state._get_version()
    assert version_after_second_set == version_after_first_set + 1

    state.delete("key1")
    version_after_delete = state._get_version()
    assert version_after_delete == version_after_second_set + 1


@pytest.mark.parametrize("clone", [copy.deepcopy, lambda state: pickle.loads(pickle.dumps(state))])
def test_clone_round_trips_and_is_independent(clone):
    state = JSONSerializableDict({"key": {"nested": [1, 2]}})
    state.set("other", "value")

    cloned = clone(state)
    cloned.set("key", "changed")

    tru_original = (state.get(), state._get_version())
    exp_original = ({"key": {"nested": [1, 2]}, "other": "value"}, 1)
    assert tru_original == exp_original

    tru_cloned = (cloned.get(), cloned._get_version())
    exp_cloned = ({"key": "changed", "other": "value"}, 2)
    assert tru_cloned == exp_cloned
