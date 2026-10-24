"""Tests for the host execution environment (``NotASandboxLocalEnvironment``).

Mirrors ``strands-ts/src/sandbox/__tests__/not-a-sandbox-local-environment.test.node.ts``.
Command and code execution spawn a real ``sh``; file operations hit the host
filesystem directly. These require a POSIX shell, so they are skipped on Windows.
"""

import os
import sys

import pytest

from strands.sandbox import FileInfo
from strands.sandbox.errors import SandboxPathNotFoundError
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment

WINDOWS = sys.platform == "win32"
# Commands run in ``sh`` on POSIX and in PowerShell on Windows; each pair means the same thing.
PRINT_CWD = "(Get-Location).Path" if WINDOWS else "pwd"
FAIL_WITH_STDERR = "[Console]::Error.WriteLine('oops'); exit 3" if WINDOWS else "echo oops >&2; exit 3"
PRINT_GREETING = "echo $env:GREETING" if WINDOWS else "printenv GREETING"
PYTHON = "python" if WINDOWS else "python3"
# PowerShell and Windows Python end lines with \r\n.
EOL = "\r\n" if WINDOWS else "\n"


@pytest.fixture
def sandbox() -> NotASandboxLocalEnvironment:
    return NotASandboxLocalEnvironment()


# ---- execute ----


@pytest.mark.asyncio
async def test_execute_runs_a_command(sandbox):
    result = await sandbox.execute("echo hello")
    assert result.exit_code == 0
    assert result.stdout == f"hello{EOL}"


@pytest.mark.asyncio
async def test_execute_respects_cwd_option(sandbox, tmp_path):
    result = await sandbox.execute(PRINT_CWD, cwd=str(tmp_path))
    assert result.stdout.strip().endswith(os.path.basename(str(tmp_path)))


@pytest.mark.asyncio
async def test_execute_reports_nonzero_exit_and_stderr(sandbox):
    result = await sandbox.execute(FAIL_WITH_STDERR)
    assert result.exit_code == 3
    assert result.stderr == f"oops{EOL}"


@pytest.mark.asyncio
async def test_execute_applies_env_option(sandbox):
    result = await sandbox.execute(PRINT_GREETING, env={"GREETING": "hi"})
    assert result.stdout == f"hi{EOL}"


# ---- execute_code ----


@pytest.mark.asyncio
async def test_execute_code_runs_interpreter(sandbox, tmp_path):
    result = await sandbox.execute_code("print(2 + 2)", PYTHON, cwd=str(tmp_path))
    assert result.exit_code == 0
    assert result.stdout == f"4{EOL}"


@pytest.mark.asyncio
async def test_execute_code_rejects_invalid_language(sandbox):
    with pytest.raises(ValueError, match="invalid characters"):
        await sandbox.execute_code("x", "../../bin/sh")


@pytest.mark.asyncio
async def test_execute_code_applies_env_option(sandbox):
    result = await sandbox.execute_code('import os; print(os.environ["GREETING"])', PYTHON, env={"GREETING": "hi"})
    assert result.stdout == f"hi{EOL}"


@pytest.mark.asyncio
async def test_execute_code_reports_missing_interpreter_as_127(sandbox):
    # ``sh`` says "command not found"; the direct spawn on Windows says "Language interpreter not found".
    result = await sandbox.execute_code("x", "strands-definitely-not-an-interpreter")
    assert result.exit_code == 127
    assert "not found" in result.stderr


# ---- execute on Windows (PowerShell) ----
# PowerShell semantics the model relies on: native exit codes propagate, stderr output alone is not a
# failure, a failing cmdlet is, a multi-KB command runs, and UTF-8 survives.


@pytest.mark.skipif(not WINDOWS, reason="PowerShell semantics")
@pytest.mark.asyncio
async def test_windows_propagates_native_exit_code(sandbox):
    assert (await sandbox.execute('cmd /c "exit 3"')).exit_code == 3


@pytest.mark.skipif(not WINDOWS, reason="PowerShell semantics")
@pytest.mark.asyncio
async def test_windows_stderr_from_a_successful_native_command_is_not_failure(sandbox):
    result = await sandbox.execute('cmd /c "echo warn 1>&2"')
    assert result.exit_code == 0
    assert "warn" in result.stderr


@pytest.mark.skipif(not WINDOWS, reason="PowerShell semantics")
@pytest.mark.asyncio
async def test_windows_failing_cmdlet_is_exit_1_and_execution_continues(sandbox):
    failed = await sandbox.execute("Get-Item C:\\strands-definitely-missing")
    assert failed.exit_code == 1
    assert failed.stderr != ""
    continued = await sandbox.execute("Get-Item C:\\strands-definitely-missing; Write-Output after")
    assert continued.exit_code == 0
    assert "after" in continued.stdout


@pytest.mark.skipif(not WINDOWS, reason="PowerShell semantics")
@pytest.mark.asyncio
async def test_windows_runs_an_8kb_command(sandbox):
    result = await sandbox.execute(f"Write-Output '{'x' * 8_000}'")
    assert len(result.stdout.strip()) == 8_000


@pytest.mark.skipif(not WINDOWS, reason="PowerShell semantics")
@pytest.mark.asyncio
async def test_windows_round_trips_utf8_output(sandbox):
    assert "\u20ac" in (await sandbox.execute('Write-Output "\u20ac"')).stdout


@pytest.mark.skipif(not WINDOWS, reason="PowerShell semantics")
@pytest.mark.asyncio
async def test_windows_overrides_a_host_variable_whose_name_differs_only_by_case(sandbox, monkeypatch):
    monkeypatch.setenv("Strands_Case_Probe", "host")
    result = await sandbox.execute("echo $env:STRANDS_CASE_PROBE", env={"STRANDS_CASE_PROBE": "override"})
    assert result.stdout.strip() == "override"


# ---- read/write (native fs) ----


@pytest.mark.asyncio
async def test_text_file_roundtrip_absolute_path(sandbox, tmp_path):
    file = str(tmp_path / "note.txt")
    await sandbox.write_text(file, "hello host")
    assert await sandbox.read_text(file) == "hello host"


@pytest.mark.asyncio
async def test_binary_roundtrip_preserves_all_byte_values(sandbox, tmp_path):
    file = str(tmp_path / "all-bytes.bin")
    data = bytes(range(256))
    await sandbox.write_file(file, data)
    assert await sandbox.read_file(file) == data


@pytest.mark.asyncio
async def test_write_creates_missing_parent_directories(sandbox, tmp_path):
    file = str(tmp_path / "deep" / "nested" / "file.txt")
    await sandbox.write_text(file, "deep")
    assert await sandbox.read_text(file) == "deep"


@pytest.mark.asyncio
async def test_read_nonexistent_file_raises(sandbox, tmp_path):
    with pytest.raises(FileNotFoundError):
        await sandbox.read_file(str(tmp_path / "nope.txt"))


@pytest.mark.asyncio
async def test_backslash_in_filename_is_literal(sandbox, tmp_path):
    # Contract: on POSIX, ``\`` in a path is a legal filename character, not a
    # separator. Containment logic in tools above the sandbox relies on this.
    file = str(tmp_path / "weird\\name.txt")
    await sandbox.write_text(file, "ok")
    assert await sandbox.read_text(file) == "ok"
    entries = await sandbox.list_files(str(tmp_path))
    assert any(entry.name == "weird\\name.txt" for entry in entries)


# ---- remove ----


@pytest.mark.asyncio
async def test_remove_file(sandbox, tmp_path):
    file = str(tmp_path / "delete-me.txt")
    await sandbox.write_text(file, "bye")
    await sandbox.remove_file(file)
    with pytest.raises(FileNotFoundError):
        await sandbox.read_file(file)


@pytest.mark.asyncio
async def test_remove_nonexistent_file_raises(sandbox, tmp_path):
    with pytest.raises(FileNotFoundError):
        await sandbox.remove_file(str(tmp_path / "nope.txt"))


# ---- list_files (native metadata) ----


@pytest.mark.asyncio
async def test_list_files_sorted_with_is_dir_and_size(sandbox, tmp_path):
    await sandbox.write_text(str(tmp_path / "c.txt"), "cc")
    await sandbox.write_text(str(tmp_path / "a.txt"), "a")
    await sandbox.write_text(str(tmp_path / "b.txt"), "bbb")
    (tmp_path / "sub").mkdir()

    files = await sandbox.list_files(str(tmp_path))

    # Full-shape equality on the files catches any regressed/unexpected FileInfo field.
    assert len(files) == 4
    assert files[:3] == [
        FileInfo(name="a.txt", is_dir=False, size=1),
        FileInfo(name="b.txt", is_dir=False, size=3),
        FileInfo(name="c.txt", is_dir=False, size=2),
    ]
    # Directory size is platform-dependent, so assert only name/is_dir for the dir entry.
    sub = files[3]
    assert sub.name == "sub"
    assert sub.is_dir is True


@pytest.mark.asyncio
async def test_list_nonexistent_directory_raises(sandbox, tmp_path):
    # Missing path (ENOENT) maps to SandboxPathNotFoundError, mirroring the TS oracle.
    with pytest.raises(SandboxPathNotFoundError):
        await sandbox.list_files(str(tmp_path / "no-such-dir"))


@pytest.mark.asyncio
async def test_list_files_on_a_file_path_raises(sandbox, tmp_path):
    # Mirrors the TS oracle's "path component is a file" case (ENOTDIR -> SandboxPathNotFoundError).
    file = tmp_path / "file.txt"
    await sandbox.write_text(str(file), "x")
    with pytest.raises(SandboxPathNotFoundError):
        await sandbox.list_files(str(file / "nested"))


# ---- _resolve_path (relative vs absolute) ----


@pytest.mark.asyncio
async def test_relative_path_resolves_against_cwd(sandbox, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    await sandbox.write_text("relative-probe.txt", "relative")
    assert (tmp_path / "relative-probe.txt").read_text() == "relative"


@pytest.mark.asyncio
async def test_absolute_path_written_as_is(sandbox, tmp_path):
    file = str(tmp_path / "abs.txt")
    await sandbox.write_text(file, "absolute")
    assert (tmp_path / "abs.txt").read_text() == "absolute"
