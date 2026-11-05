"""Tests for FileSessionManager symlink attack protection."""

import json
import os
import platform
import stat
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from strands.session.file_session_manager import FileSessionManager
from strands.types.exceptions import SessionException


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    with tempfile.TemporaryDirectory() as td:
        yield td


@pytest.fixture
def file_manager(temp_dir):
    """Create FileSessionManager for testing."""
    return FileSessionManager(session_id="test", storage_dir=temp_dir)


class TestDefaultStorageDir:
    """Tests for secure default storage directory."""

    def test_default_not_in_tmp(self):
        """Default storage dir should NOT be in /tmp."""
        default_dir = FileSessionManager._default_storage_dir()
        assert not default_dir.startswith(tempfile.gettempdir()), (
            f"Default dir {default_dir} should not be under {tempfile.gettempdir()}"
        )

    def test_default_under_home(self):
        """Default storage dir should be under the user's home directory."""
        default_dir = FileSessionManager._default_storage_dir()
        home = str(Path.home())
        assert default_dir.startswith(home), f"Default dir {default_dir} should be under {home}"

    def test_default_is_strands_sessions(self):
        """Default dir should be ~/.strands/sessions on every platform."""
        default_dir = FileSessionManager._default_storage_dir()
        assert default_dir == str(Path.home() / ".strands" / "sessions")

    @pytest.mark.skipif(platform.system() == "Windows", reason="Unix-only test")
    def test_storage_dir_permissions(self, temp_dir):
        """Storage directory should be created with mode 0o700."""
        storage = os.path.join(temp_dir, "new_sessions")
        FileSessionManager(session_id="test", storage_dir=storage)
        mode = stat.S_IMODE(os.stat(storage).st_mode)
        assert mode == 0o700, f"Expected 0o700, got {oct(mode)}"


class TestSymlinkProtection:
    """Tests for symlink attack prevention."""

    @pytest.mark.skipif(platform.system() == "Windows", reason="Symlinks need Unix")
    def test_write_refuses_symlink_target(self, file_manager, temp_dir):
        """_write_file should refuse to write to a symlink."""
        target_file = os.path.join(temp_dir, "real_target.txt")
        with open(target_file, "w") as f:
            f.write("original content")

        # Create a symlink where the session file would go
        symlink_path = os.path.join(temp_dir, "evil_symlink.json")
        os.symlink(target_file, symlink_path)

        with pytest.raises(SessionException, match="symlink"):
            file_manager._write_file(symlink_path, {"injected": True})

        # Verify target was NOT overwritten
        with open(target_file) as f:
            assert f.read() == "original content"

    @pytest.mark.skipif(platform.system() == "Windows", reason="Symlinks need Unix")
    def test_read_refuses_symlink_target(self, file_manager, temp_dir):
        """_read_file should refuse to read through a symlink."""
        # Create a real JSON file
        real_file = os.path.join(temp_dir, "real.json")
        with open(real_file, "w") as f:
            json.dump({"secret": "***"}, f)

        # Create a symlink pointing to it
        symlink_path = os.path.join(temp_dir, "sneaky_link.json")
        os.symlink(real_file, symlink_path)

        with pytest.raises(SessionException, match="symlink"):
            file_manager._read_file(symlink_path)

    @pytest.mark.skipif(platform.system() == "Windows", reason="Symlinks need Unix")
    def test_write_uses_unpredictable_temp(self, file_manager, temp_dir):
        """_write_file should NOT use a predictable temp name derivable from the target path."""
        target = os.path.join(temp_dir, "session.json")

        captured_tmp_names = []
        real_mkstemp = tempfile.mkstemp

        def spy_mkstemp(*args, **kwargs):
            fd, tmp_path = real_mkstemp(*args, **kwargs)
            captured_tmp_names.append(tmp_path)
            return fd, tmp_path

        with patch(
            "strands.session.file_session_manager.tempfile.mkstemp",
            side_effect=spy_mkstemp,
        ):
            file_manager._write_file(target, {"key": "value"})

        # Verify the file was written correctly
        with open(target) as f:
            data = json.load(f)
        assert data == {"key": "value"}

        # The atomic write must go through mkstemp (not a hand-rolled name).
        assert captured_tmp_names, "expected _write_file to allocate a temp file via mkstemp"
        tmp_path = captured_tmp_names[0]
        # Pin unpredictability: the temp name must NOT be the predictable
        # "<target>.tmp" pattern (the exact symlink target this fix removed).
        # Reverting mkstemp back to f"{path}.tmp" must fail here.
        assert tmp_path != target + ".tmp"
        assert os.path.basename(target) not in os.path.basename(tmp_path)

        # Verify no leftover .tmp file (mkstemp files are cleaned up)
        leftover_tmps = [f for f in os.listdir(temp_dir) if f.endswith(".tmp")]
        assert len(leftover_tmps) == 0

    @pytest.mark.skipif(platform.system() == "Windows", reason="Symlinks need Unix")
    def test_write_cleans_up_on_failure(self, file_manager, temp_dir):
        """_write_file should clean up temp file on serialization failure."""
        target = os.path.join(temp_dir, "session.json")

        # Pass non-serializable data to trigger json.dump failure
        class NotSerializable:
            pass

        with pytest.raises(TypeError):
            file_manager._write_file(target, {"bad": NotSerializable()})

        # No temp files should remain
        all_files = os.listdir(temp_dir)
        tmp_files = [f for f in all_files if ".strands_" in f or f.endswith(".tmp")]
        assert len(tmp_files) == 0

    @pytest.mark.skipif(platform.system() == "Windows", reason="Symlinks need Unix")
    def test_symlink_attack_scenario(self, temp_dir):
        """Full symlink attack scenario should be blocked."""
        # Simulate: attacker creates session dir with symlink before victim
        session_dir = os.path.join(temp_dir, "session_victim")
        os.makedirs(session_dir, exist_ok=True)

        # Attacker plants a symlink where session.json would be written
        attacker_target = os.path.join(temp_dir, "attacker_wins.txt")
        with open(attacker_target, "w") as f:
            f.write("attacker original file")

        session_file = os.path.join(session_dir, "session.json")
        os.symlink(attacker_target, session_file)

        # Victim creates FileSessionManager
        fm = FileSessionManager(session_id="test", storage_dir=temp_dir)

        # Write should be blocked
        with pytest.raises(SessionException, match="symlink"):
            fm._write_file(session_file, {"session_id": "victim"})

        # Attacker's file should be untouched
        with open(attacker_target) as f:
            assert f.read() == "attacker original file"


class TestAtomicWrite:
    """Tests for atomic write behavior."""

    def test_write_is_atomic(self, file_manager, temp_dir):
        """Written files should have complete content (no partial writes)."""
        target = os.path.join(temp_dir, "atomic_test.json")
        large_data = {"key_" + str(i): "value_" + str(i) for i in range(1000)}

        file_manager._write_file(target, large_data)

        with open(target) as f:
            result = json.load(f)
        assert result == large_data

    def test_write_overwrites_existing(self, file_manager, temp_dir):
        """_write_file should correctly overwrite existing files."""
        target = os.path.join(temp_dir, "overwrite_test.json")

        file_manager._write_file(target, {"version": 1})
        file_manager._write_file(target, {"version": 2})

        with open(target) as f:
            result = json.load(f)
        assert result == {"version": 2}
