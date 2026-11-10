"""Tests for _async module."""

import pytest

from strands._async import run_async


def test_run_async_with_return_value():
    """Test run_async returns correct value."""

    async def async_with_value():
        return 42

    result = run_async(async_with_value)
    assert result == 42


def test_run_async_exception_propagation():
    """Test that exceptions are properly propagated."""

    async def async_with_exception():
        raise ValueError("test exception")

    with pytest.raises(ValueError, match="test exception"):
        run_async(async_with_exception)
