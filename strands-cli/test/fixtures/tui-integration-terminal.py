"""Own a POSIX PTY while the shared Node driver runs the scenarios."""

import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios


def emit(message):
    print(json.dumps(message), flush=True)


def main():
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
            "termiosRestored": initial == termios.tcgetattr(slave),
        })
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    main()
