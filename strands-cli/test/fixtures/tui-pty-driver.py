#!/usr/bin/env python3

import base64
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

ANSI_ESCAPE = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
CHAT_READY = b"\x1b[?1002l\x1b[?1003h"


def main() -> int:
    command = sys.argv[1:]
    ready_marker = b"Enter to send"
    shell_mode = os.environ.get("STRANDS_CLI_TEST_SHELL_MODE")
    frog_mode = os.environ.get("STRANDS_CLI_TEST_FROG_MODE") == "true"
    startup_typing = os.environ.get("STRANDS_CLI_TEST_STARTUP_TYPING") == "true"
    intro = os.environ.get("STRANDS_CLI_TEST_INTRO") == "true"
    resize = os.environ.get("STRANDS_CLI_TEST_RESIZE") == "true"
    master, slave = pty.openpty()
    rows = 40 if startup_typing else 20 if intro else 30
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, 100, 0, 0))
    initial_terminal = termios.tcgetattr(slave)
    process = subprocess.Popen(
        command,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env={**os.environ, "CI": "false", "TERM": "xterm-256color"},
        start_new_session=True,
    )
    os.set_blocking(master, False)
    transcript = bytearray()

    def pump() -> None:
        while True:
            try:
                chunk = os.read(master, 65536)
            except BlockingIOError:
                return
            except OSError:
                return
            if not chunk:
                return
            transcript.extend(chunk)

    def wait_for(markers: list[bytes], timeout: float = 8.0, *, styled: bool = True, start: int = 0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            output = bytes(transcript[start:]) if styled else ANSI_ESCAPE.sub(b"", bytes(transcript[start:]))
            if all(marker in output for marker in markers):
                return
            if process.poll() is not None:
                break
            select.select([master], [], [], 0.05)
        pump()
        output = bytes(transcript[start:]) if styled else ANSI_ESCAPE.sub(b"", bytes(transcript[start:]))
        missing = [marker.decode() for marker in markers if marker not in output]
        raise RuntimeError(f"missing markers {missing}; returncode={process.poll()}; output={transcript!r}")

    def wait_for_raw_mode(timeout: float = 8.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            if not termios.tcgetattr(slave)[3] & termios.ICANON:
                return
            if process.poll() is not None:
                break
            time.sleep(0.05)
        raise RuntimeError(f"terminal did not enter raw mode; returncode={process.poll()}; output={transcript!r}")

    def wait_for_exit(timeout: float = 8.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and process.poll() is None:
            select.select([master], [], [], 0.05)
            pump()
        if process.poll() is None:
            raise RuntimeError(f"process did not exit; output={transcript!r}")
        pump()

    try:
        wait_for([ready_marker, CHAT_READY])
        wait_for_raw_mode()
        def set_size(columns: int, height: int) -> None:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", height, columns, 0, 0))
            os.kill(process.pid, signal.SIGWINCH)

        def settle(timeout: float = 0.15) -> None:
            deadline = time.monotonic() + timeout
            last = len(transcript)
            while time.monotonic() < deadline:
                pump()
                if len(transcript) != last:
                    last = len(transcript)
                    deadline = time.monotonic() + timeout
                else:
                    select.select([master], [], [], 0.05)

        resize_output = b""
        burst_output = b""
        noop_output = b""
        if resize:
            start = len(transcript)
            for columns, height in [(80, 24), (40, 16), (22, 10), (160, 50), (160, 25), (100, 30)]:
                offset = len(transcript)
                set_size(columns, height)
                wait_for([b"\x1b[1;1H"], timeout=2.0, start=offset)
            resize_output = bytes(transcript[start:])

            burst_start = len(transcript)
            for columns, height in [(70, 25), (50, 18), (120, 40)]:
                set_size(columns, height)
            wait_for([b"\x1b[1;1H"], timeout=2.0, start=burst_start)
            settle()
            burst_output = bytes(transcript[burst_start:])

            noop_start = len(transcript)
            set_size(120, 40)
            settle(0.2)
            noop_output = bytes(transcript[noop_start:])
        if frog_mode:
            os.write(master, b"/frog peek")
            wait_for([b"/frog peek"], timeout=2.0, styled=False)
            os.write(master, b"\r")
            wait_for(["▗▄▄▖".encode()], timeout=2.0, styled=False)
        elif shell_mode == "command":
            command = b"!printf '__SHELL_LINE_1__\\n__SHELL_LINE_2__\\n__SHELL_LINE_3__\\n__SHELL_LINE_4__\\n'"
            os.write(master, command)
            wait_for(["◆ shell !printf".encode()], timeout=2.0, styled=False)
            time.sleep(0.2)
            os.write(master, b"\r")
            wait_for([b"__SHELL_LINE_1__", b"__SHELL_LINE_4__", b"__SHELL_IDLE__"], styled=False)
        elif shell_mode == "interrupt":
            os.write(master, b"!sleep 30")
            wait_for(["◆ shell !sleep".encode()], timeout=2.0, styled=False)
            time.sleep(0.2)
            os.write(master, b"\r")
            wait_for([b"shell sleep 30"], styled=False)
            time.sleep(0.2)
            os.write(master, b"\x03")
            wait_for([b"Cancelled", b"__SHELL_IDLE__"], timeout=4.0, styled=False)
        draft = b"startup draft" if startup_typing else b"junk"
        os.write(master, draft)
        wait_for([draft], timeout=2.0, styled=False)
        for keypress in [b"\x7f"] * len(draft) + [b"/exit"]:
            os.write(master, keypress)
            time.sleep(0.05)
        wait_for([b"/exit"], timeout=2.0, styled=False)
        time.sleep(0.2)
        os.write(master, b"\r")

        wait_for_exit()
        time.sleep(0.05)
        pump()
        final_terminal = termios.tcgetattr(slave)
        print(
            json.dumps(
                {
                    "returnCode": process.returncode,
                    "termiosRestored": initial_terminal == final_terminal,
                    "transcript": base64.b64encode(transcript).decode(),
                    "resizeTranscript": base64.b64encode(resize_output).decode(),
                    "resizeBurstTranscript": base64.b64encode(burst_output).decode(),
                    "resizeNoopTranscript": base64.b64encode(noop_output).decode(),
                }
            )
        )
        return 0
    except Exception as error:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        print(str(error), file=sys.stderr)
        return 1
    finally:
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    raise SystemExit(main())
