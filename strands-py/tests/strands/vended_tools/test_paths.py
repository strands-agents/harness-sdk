"""Tests for the shared sandbox-path validator used by file-related vended tools."""

import pytest

from strands.vended_tools._paths import validate_absolute_path


class TestValidateAbsolutePath:
    def test_accepts_posix_absolute(self):
        validate_absolute_path("/tmp/x.txt")

    def test_accepts_windows_drive_absolute(self):
        validate_absolute_path("C:\\project\\file.txt")

    def test_accepts_unc_share(self):
        validate_absolute_path("\\\\server\\share\\file.txt")

    def test_rejects_relative(self):
        with pytest.raises(ValueError, match="not absolute"):
            validate_absolute_path("relative.txt")

    def test_rejects_posix_parent_traversal(self):
        with pytest.raises(ValueError, match="path traversal is not allowed"):
            validate_absolute_path("/tmp/../etc/passwd")

    def test_rejects_windows_parent_traversal(self):
        # Backslash is the Windows separator and must also be inspected for
        # ``..`` segments so a POSIX-only split cannot hide a traversal.
        with pytest.raises(ValueError, match="path traversal is not allowed"):
            validate_absolute_path("C:\\project\\..\\etc\\hosts")

    def test_accepts_double_dot_substring_inside_segment(self):
        # Only full segments equal to ``..`` are traversals; a filename that
        # happens to contain ``..`` as text is fine.
        validate_absolute_path("/tmp/file..name.txt")
