"""Check native input-mode restoration around the shared terminal scenarios."""

import base64
import json
import os
import select
import signal
import struct
import subprocess
import sys
from pathlib import Path


def emit(message):
    print(json.dumps(message), flush=True)


def main():
    import fcntl
    import pty
    import termios

    master, slave = pty.openpty()
    child = None
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", int(sys.argv[1]), 100, 0, 0))
        initial = termios.tcgetattr(slave)
        child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.set_blocking(master, False)
        pending = b""

        def pump():
            while True:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    return
                if not data:
                    return
                emit({"type": "data", "data": base64.b64encode(data).decode()})

        while child.poll() is None:
            ready, _, _ = select.select([master, sys.stdin], [], [], 0.05)
            if master in ready:
                pump()
            if sys.stdin in ready:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    return
                pending += data
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    message = json.loads(line)
                    if message["type"] == "write":
                        os.write(master, message["data"].encode())
                    elif message["type"] == "resize":
                        size = struct.pack("HHHH", message["rows"], message["columns"], 0, 0)
                        fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
                        os.kill(child.pid, signal.SIGWINCH)
        pump()
        emit({
            "type": "exit",
            "exitCode": child.returncode,
            "inputModeRestored": initial == termios.tcgetattr(slave),
        })
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        os.close(master)
        os.close(slave)


def main_windows():
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel32.GetStdHandle.restype = wintypes.HANDLE
    kernel32.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    handle = kernel32.GetStdHandle(-10)
    mode = wintypes.DWORD()
    if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
        raise ctypes.WinError(ctypes.get_last_error())
    # Node restores this native baseline after JS cleanup; keep shell mouse reporting off.
    initial = mode.value & ~0x0010  # ENABLE_MOUSE_INPUT
    if not kernel32.SetConsoleMode(handle, initial):
        raise ctypes.WinError(ctypes.get_last_error())
    child = subprocess.run(sys.argv[2:])
    if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
        raise ctypes.WinError(ctypes.get_last_error())
    return {
        "exitCode": child.returncode,
        "inputModeRestored": initial == mode.value,
    }


if __name__ == "__main__":
    if os.name == "nt":
        try:
            result = main_windows()
        except Exception as error:
            result = {"error": str(error)}
        report = Path(sys.argv[1])
        temporary = Path(f"{report}.tmp")
        temporary.write_text(json.dumps(result))
        temporary.replace(report)
        sys.exit(result.get("exitCode", 1))
    else:
        main()
