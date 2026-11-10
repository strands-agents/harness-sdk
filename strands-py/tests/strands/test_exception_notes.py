"""Tests for exception note utilities."""

import sys
import traceback
import unittest.mock

import pytest

from strands import _exception_notes
from strands._exception_notes import add_exception_note


@pytest.mark.skipif(sys.version_info < (3, 11), reason="This test requires Python 3.11 or higher (need add_note)")
def test_add_exception_note_python_311_plus():
    """Test add_exception_note uses add_note in Python 3.11+."""
    exception = ValueError("original message")

    add_exception_note(exception, "test note")

    assert traceback.format_exception(exception) == ["ValueError: original message\n", "test note\n"]


def test_add_exception_note_python_310():
    """Test add_exception_note modifies args in Python 3.10."""
    with unittest.mock.patch.object(_exception_notes, "supports_add_note", False):
        exception = ValueError("original message")

        add_exception_note(exception, "test note")

        assert traceback.format_exception(exception) == ["ValueError: original message\ntest note\n"]


def test_add_exception_note_python_310_no_args():
    """Test add_exception_note handles exception with no args in Python 3.10."""
    with unittest.mock.patch.object(_exception_notes, "supports_add_note", False):
        exception = ValueError()
        exception.args = ()

        add_exception_note(exception, "test note")

        assert traceback.format_exception(exception) == ["ValueError: test note\n"]


def test_add_exception_note_python_310_multiple_args():
    """Test add_exception_note preserves additional args in Python 3.10."""
    with unittest.mock.patch.object(_exception_notes, "supports_add_note", False):
        exception = ValueError("original message", "second arg")

        add_exception_note(exception, "test note")

        assert traceback.format_exception(exception) == ["ValueError: ('original message\\ntest note', 'second arg')\n"]
