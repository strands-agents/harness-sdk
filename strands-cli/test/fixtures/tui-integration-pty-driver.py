#!/usr/bin/env python3

from __future__ import annotations

import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from typing import TextIO, cast

ANSI_ESCAPE = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
READY_MARKER = b"Enter to send"
SCREEN_QUIET_SECONDS = 0.075
SCREEN_RESPONSE_TIMEOUT_SECONDS = 1.0


def main() -> int:
    command = sys.argv[1:]
    scenario = os.environ.get("STRANDS_CLI_TEST_SCENARIO", "exit")
    shell_mode = {"shell-command": "command", "shell-interrupt": "interrupt"}.get(scenario)
    frog_mode = scenario == "frog"
    chat_mode = scenario == "chat"
    follow_up_mode = scenario == "follow-up"
    approval_mode = scenario == "approval"
    setup_export_mode = scenario == "setup-export"
    export_failure_mode = scenario == "export-failure"
    setup_import_mode = scenario == "lifecycle-setup-import"
    lifecycle_mode = scenario in {"lifecycle-profile", "lifecycle-project", "lifecycle-setup-import"}
    live_mode = scenario == "live-self-building"
    panels_mode = scenario == "panels"
    startup_typing = scenario == "startup-typing"
    intro = scenario in {"startup", "startup-typing"}
    resize = scenario == "resize"
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
    screen = ""
    screens: list[str] = []
    last_output_at = time.monotonic()
    screen_process = subprocess.Popen(
        [command[0], str(Path(__file__).with_name("terminal-screen.mjs")), "100", str(rows)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    screen_input = cast(TextIO, screen_process.stdin)
    screen_output = cast(TextIO, screen_process.stdout)

    def update_screen(
        data: bytes | bytearray = b"", columns: int | None = None, height: int | None = None, target: str = ""
    ):
        nonlocal screen
        request: dict[str, object] = {"data": base64.b64encode(data).decode(), "target": target}
        if columns is not None:
            request.update(columns=columns, rows=height)
        screen_input.write(json.dumps(request) + "\n")
        screen_input.flush()
        ready, _, _ = select.select([screen_output], [], [], SCREEN_RESPONSE_TIMEOUT_SECONDS)
        if not ready:
            raise RuntimeError("terminal screen parser timed out")
        response = screen_output.readline()
        if not response:
            raise RuntimeError("terminal screen parser exited")
        parsed = json.loads(response)
        screen = parsed["text"]
        return parsed.get("target")

    def pump() -> None:
        nonlocal last_output_at
        chunks = bytearray()
        while True:
            try:
                chunk = os.read(master, 65536)
            except BlockingIOError:
                break
            except OSError:
                break
            if not chunk:
                break
            transcript.extend(chunk)
            chunks.extend(chunk)
        if chunks:
            last_output_at = time.monotonic()
            update_screen(chunks)

    def wait_for(
        markers: list[bytes],
        timeout: float = 8.0,
        *,
        styled: bool = True,
        start: int = 0,
        stable: bool = False,
        absent: list[bytes] | None = None,
    ) -> None:
        absent = absent or []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            output = bytes(transcript[start:]) if styled else ANSI_ESCAPE.sub(b"", bytes(transcript[start:]))
            screen_markers = [] if styled else [marker for marker in markers if not marker.startswith(b"__")]
            uses_screen = not styled and (bool(screen_markers) or stable)
            has_fresh_screen = not uses_screen or start == 0 or len(transcript) > start
            is_stable = not stable or time.monotonic() - last_output_at >= SCREEN_QUIET_SECONDS
            if (
                has_fresh_screen
                and is_stable
                and all(
                    marker in (output if (styled or marker.startswith(b"__")) else screen.encode())
                    for marker in markers
                )
                and all(marker not in screen.encode() for marker in absent)
            ):
                screens.append(screen)
                return
            if process.poll() is not None:
                break
            select.select([master], [], [], 0.05)
        pump()
        output = bytes(transcript[start:]) if styled else ANSI_ESCAPE.sub(b"", bytes(transcript[start:]))
        missing = [
            marker.decode()
            for marker in markers
            if marker not in (output if (styled or marker.startswith(b"__")) else screen.encode())
        ]
        raise RuntimeError(
            f"missing markers {missing}; returncode={process.poll()}; "
            f"screen={screen!r}; output={transcript!r}"
        )

    def wait_for_stable_screen(
        markers: list[bytes], timeout: float = 8.0, *, start: int = 0, absent: list[bytes] | None = None
    ) -> None:
        wait_for(markers, timeout=timeout, styled=False, start=start, stable=True, absent=absent)

    def click_text(text: str) -> None:
        wait_for_stable_screen([text.encode()])
        target = update_screen(target=text)
        column, row = target["column"], target["row"]
        os.write(master, f"\x1b[<0;{column};{row}M\x1b[<3;{column};{row}m".encode())

    def wait_for_style(text: str, style) -> None:
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            pump()
            target = update_screen(target=text)
            if target and time.monotonic() - last_output_at >= SCREEN_QUIET_SECONDS and target["style"] == style:
                screens.append(screen)
                return
            select.select([master], [], [], 0.05)
        raise RuntimeError(f"focus did not move to {text!r}; screen={screen!r}")

    def wait_for_exit(timeout: float = 8.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and process.poll() is None:
            select.select([master], [], [], 0.05)
            pump()
        if process.poll() is None:
            raise RuntimeError(f"process did not exit; output={transcript!r}")
        pump()

    try:
        if setup_import_mode:
            wait_for([b"Quickstart", b"Import"], timeout=20.0, styled=False)
        else:
            ready_timeout = 90.0 if live_mode else 60.0 if lifecycle_mode else 8.0
            wait_for_stable_screen([READY_MARKER], timeout=ready_timeout, absent=["Loading…".encode()])

        def set_size(columns: int, height: int) -> None:
            update_screen(columns=columns, height=height)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", height, columns, 0, 0))
            os.kill(process.pid, signal.SIGWINCH)

        resize_screens: list[dict[str, object]] = []
        if resize:
            for columns, height in [(80, 24), (40, 16), (22, 10), (160, 50), (160, 25), (100, 30)]:
                offset = len(transcript)
                set_size(columns, height)
                wait_for_stable_screen([], timeout=2.0, start=offset)
                resize_screens.append({"columns": columns, "rows": height, "text": screen})

            burst_start = len(transcript)
            for columns, height in [(70, 25), (50, 18), (120, 40)]:
                set_size(columns, height)
            wait_for_stable_screen([], timeout=2.0, start=burst_start)
            resize_screens.append({"columns": 120, "rows": 40, "text": screen})
        export_language = os.environ.get("STRANDS_CLI_TEST_EXPORT_LANGUAGE", "typescript")

        def type_in_composer(text: bytes, timeout: float = 10.0) -> int:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                start = len(transcript)
                os.write(master, b"\x15" + text)
                attempt_deadline = min(deadline, time.monotonic() + 2.0)
                while time.monotonic() < attempt_deadline:
                    pump()
                    target = update_screen(target=text.decode())
                    if target and target["row"] >= rows - 5:
                        return start
                    select.select([master], [], [], 0.05)
            raise RuntimeError(f"composer did not accept {text!r}; screen={screen!r}; output={transcript!r}")

        def submit(prompt: bytes, markers: list[bytes], approve: bool = False) -> None:
            start = type_in_composer(prompt)
            os.write(master, b"\r")
            if approve:
                wait_for([b"Enter choose"], timeout=8.0, styled=False, start=start)
                os.write(master, b"\r")
            idle = [b"__PLATFORM_IDLE__"] if export_language == "typescript" else []
            wait_for(markers + idle, timeout=15.0, styled=False, start=start)
            wait_for_stable_screen([READY_MARKER])

        if setup_import_mode:
            click_text("Import")
            wait_for([b"Import an agent"], timeout=5.0, styled=False)
            edit_start = len(transcript)
            os.write(master, b"\r")
            wait_for([b"Enter save", "▌".encode()], timeout=5.0, styled=False, start=edit_start)
            path = os.environ["STRANDS_CLI_TEST_IMPORT_PATH"].encode()
            os.write(master, path)
            wait_for([os.path.basename(path)], timeout=2.0, styled=False, start=edit_start)
            commit_start = len(transcript)
            os.write(master, b"\r")
            wait_for([b"Click or Enter to choose"], timeout=2.0, styled=False, start=commit_start)
            launch_start = len(transcript)
            click_text("Launch")
            wait_for_stable_screen(
                [READY_MARKER, b"Ask your agent to change its instructions"],
                timeout=90.0,
                start=launch_start,
                absent=["Loading…".encode()],
            )

        if live_mode:
            generation = 1
            turns = 0

            def live_submit(prompt: str, idle_generation: int, idle_turns: int) -> None:
                start = len(transcript)
                os.write(master, prompt.encode())
                wait_for([prompt[:40].encode()], timeout=5.0, styled=False, start=start)
                os.write(master, b"\r")
                marker = f"__LIVE_IDLE_{idle_generation}_{idle_turns}__".encode()
                wait_for([marker], timeout=150.0, start=start)
                wait_for_stable_screen([READY_MARKER])

            setup_prompt = os.environ.get("STRANDS_CLI_TEST_SETUP_PROMPT")
            if setup_prompt:
                generation = 2
                turns = 1
                live_submit(setup_prompt, generation, turns)
            live_submit(os.environ["STRANDS_CLI_TEST_USE_PROMPT"], generation, turns + 1)
            os.write(master, f"/config {export_language}".encode())
            wait_for([f"/config {export_language}▌".encode()], styled=False)
            config_start = len(transcript)
            os.write(master, b"\r")
            wait_for([b"TypeScript"], styled=False, start=config_start)
            close_start = len(transcript)
            os.write(master, b"\x1b")
            wait_for_stable_screen([READY_MARKER], start=close_start)
            path = os.environ["STRANDS_CLI_TEST_EXPORT_PATH"]
            command_start = len(transcript)
            os.write(master, f'/export {export_language} "{path}"'.encode())
            wait_for([b"/export " + export_language.encode()], styled=False, start=command_start)
            export_start = len(transcript)
            os.write(master, b"\r")
            wait_for_stable_screen([b"Export complete"], timeout=30.0, start=export_start)
            close_start = len(transcript)
            os.write(master, b"\x1b")
            wait_for_stable_screen([READY_MARKER], start=close_start)
        elif lifecycle_mode:
            submit(
                b"report capabilities before export"
                if scenario == "lifecycle-profile"
                else b"report capabilities after import",
                [b"LOCAL_SKILL=true", b"REMOTE_SKILL=true"],
            )
            if scenario != "lifecycle-profile":
                submit(
                    b"invoke the MCP probe after import",
                    [b"platform-mcp-ok"],
                    approve=scenario == "lifecycle-setup-import",
                )
            path = os.environ["STRANDS_CLI_TEST_EXPORT_PATH"].encode()
            command = b'/export ' + export_language.encode() + b' "' + path + b'"'
            os.write(master, command)
            wait_for([b"/export " + export_language.encode()], timeout=2.0, styled=False)
            export_start = len(transcript)
            os.write(master, b"\r")
            wait_for_stable_screen([b"Export complete"], timeout=15.0, start=export_start)
            close_start = len(transcript)
            os.write(master, b"\x1b")
            wait_for_stable_screen([READY_MARKER], start=close_start)
        elif export_failure_mode:
            path = os.environ["STRANDS_CLI_TEST_EXPORT_PATH"].encode()
            command = b'/export typescript "' + path + b'"'
            os.write(master, command)
            wait_for([b"/export typescript"], timeout=2.0, styled=False)
            failure_start = len(transcript)
            os.write(master, b"\r")
            wait_for_stable_screen([b"file already exists"], timeout=15.0, start=failure_start)
            close_start = len(transcript)
            os.write(master, b"\x1b")
            wait_for_stable_screen([READY_MARKER], start=close_start)
        elif chat_mode:
            os.write(master, b"hello from integration")
            wait_for([b"hello from integration"], timeout=2.0, styled=False)
            os.write(master, b"\r")
            wait_for([b"Fixture reply", b"__CHAT_IDLE__"], styled=False)
        elif follow_up_mode:
            for prompt, reply in [(b"first turn", b"Fixture turn 1"), (b"second turn", b"Fixture turn 2")]:
                start = len(transcript)
                os.write(master, prompt)
                wait_for([prompt], timeout=2.0, styled=False)
                os.write(master, b"\r")
                wait_for([reply, b"__CHAT_IDLE__"], styled=False, start=start)
        elif approval_mode:
            os.write(master, b"request approval")
            wait_for([b"request approval"], timeout=2.0, styled=False)
            os.write(master, b"\r")
            wait_for([b"Allow once"], styled=False)
            os.write(master, b"\r")
            wait_for([b"Approval accepted", b"__CHAT_IDLE__"], styled=False)
        elif setup_export_mode:
            os.write(master, b"/setup")
            wait_for([b"/setup"], timeout=2.0, styled=False)
            os.write(master, b"\r")
            wait_for([b"__SETUP_REQUESTED__"], styled=False)
            path = os.environ["STRANDS_CLI_TEST_EXPORT_PATH"].encode()
            command = b"/export typescript " + path
            os.write(master, command)
            wait_for([b"/export typescript"], timeout=2.0, styled=False)
            export_start = len(transcript)
            os.write(master, b"\r")
            wait_for_stable_screen([b"Export complete"], start=export_start)
            close_start = len(transcript)
            os.write(master, b"\x1b")
            wait_for_stable_screen([READY_MARKER], start=close_start)
        elif panels_mode:
            panels = [
                (b"/help", [b"Send a message", b"Search help", "› Controls".encode()], None),
                (b"/agents", [b"Agents", b"Current", b"idle", b"1/1", b"Enter switch"], None),
                (
                    b"/mcp",
                    [
                        b"fixture-mcp",
                        b"failed",
                        b"Server is not accepting connections",
                        "→ details".encode(),
                        b"R retry",
                    ],
                    None,
                ),
                (
                    b"/model",
                    [b"Fixture Model Alpha", b"Fixture Model Beta"],
                    b"\xe2\x80\xba Fixture Model Alpha",
                ),
                (b"/effort", [b"Reasoning effort", b"Medium"], None),
                (
                    b"/tasks",
                    [
                        b"Behavior",
                        b"Wait for completion",
                        b"Search tasks",
                        b"Fixture background task",
                        b"completed",
                        b"Enter open/toggle",
                    ],
                    None,
                ),
                (b"/settings", [b"Appearance", b"Auto-Discovery"], b"\xe2\x80\xba Theme"),
                (
                    b"/permissions",
                    [b"Permissions", b"Search tools", b"Ask", b"Bypass", b"Custom", b"Custom to edit"],
                    None,
                ),
                (
                    b"/voice",
                    [
                        b"Off",
                        b"On",
                        b"Spoken replies",
                        b"Speaker",
                        b"Nova",
                        b"OpenAI",
                        b"Nova 2.5 Sonic",
                        b"tiffany",
                        b"Space mute",
                    ],
                    b"\xe2\x80\xba Provider",
                ),
                (b"/export", [b"Export Lifecycle Fixture", b"Python", b"TypeScript"], None),
                (
                    b"/sessions ",
                    [b"Directories", b"Sessions", b"Search sessions", b"# messages", b"Fixture Session"],
                    b"\xe2\x80\xba Fixture Session",
                ),
            ]
            for command, markers, tab_marker in panels:
                start = len(transcript)
                os.write(master, command)
                # The restored model footer can contain "/model"; wait for the composer cursor.
                wait_for([command + "▌".encode()], timeout=2.0, styled=False, start=start)
                os.write(master, b"\r")
                wait_for(markers, styled=False, start=start)
                if command == b"/agents":
                    for columns, height in [(40, 16), (22, 10), (100, 30)]:
                        resize_start = len(transcript)
                        set_size(columns, height)
                        footer = b"Arrows" if columns < 30 else b"Enter switch"
                        wait_for_stable_screen([b"Agents", b"1/1", footer], start=resize_start)
                    chat_start = len(transcript)
                    os.write(master, b"\r")
                    wait_for([READY_MARKER], styled=False, start=chat_start)
                    agents_start = len(transcript)
                    os.write(master, b"/agents")
                    wait_for(["/agents▌".encode()], timeout=2.0, styled=False, start=agents_start)
                    os.write(master, b"\r")
                    wait_for(markers, styled=False, start=agents_start)
                if command == b"/help":
                    tab_start = len(transcript)
                    os.write(master, b"\t")
                    wait_for(["› Send a message".encode()], styled=False, start=tab_start)
                    detail_start = len(transcript)
                    os.write(master, b"\r")
                    wait_for([b"Send your message", b"scroll"], styled=False, start=detail_start)
                    help_start = len(transcript)
                    os.write(master, b"\x1b")
                    wait_for([b"Search help", "› Send a message".encode()], styled=False, start=help_start)
                if command == b"/mcp":
                    detail_start = len(transcript)
                    os.write(master, b"\x1b[C")
                    wait_for(
                        [b"MCP: fixture-mcp", b"Problem", b"Next step", b"Check that the server is running"],
                        styled=False,
                        start=detail_start,
                    )
                    error_start = len(transcript)
                    os.write(master, b"\x1b[F")
                    wait_for(
                        [b"/tmp/fixture-mcp.json", b"Full error", b"connect ECONNREFUSED 127.0.0.1:43123"],
                        styled=False,
                        start=error_start,
                    )
                    list_start = len(transcript)
                    os.write(master, b"\x1b")
                    wait_for([b"MCP servers (1)", b"R retry"], styled=False, start=list_start)
                    retry_start = len(transcript)
                    os.write(master, b"R")
                    wait_for([b"fixture-mcp", b"connected", b"1 tools"], styled=False, start=retry_start)
                if command == b"/sessions ":
                    os.write(master, b"\x1b[B")
                    wait_for([b"1 / 2"], styled=False, start=start)
                if command == b"/export":
                    export_start = len(transcript)
                    selected_style = update_screen(target="Python")["style"]
                    os.write(master, b"\t")
                    wait_for_style("TypeScript", selected_style)
                    os.write(master, b"\r")
                    wait_for([b"Name exported folder"], styled=False, start=export_start)
                    os.write(master, b"\r")
                    wait_for([b"Save TypeScript copy"], styled=False, start=export_start)
                    name_start = len(transcript)
                    os.write(master, b"\x1b")
                    wait_for([b"Name exported folder"], styled=False, start=name_start)
                    export_start = len(transcript)
                    os.write(master, b"\x1b")
                    wait_for([b"Export Lifecycle Fixture"], styled=False, start=export_start)
                if tab_marker:
                    tab_start = len(transcript)
                    os.write(master, b"\t")
                    wait_for([tab_marker], styled=False, start=tab_start)
                close_start = len(transcript)
                os.write(master, b"\x1b")
                wait_for_stable_screen([READY_MARKER], start=close_start)
        elif frog_mode:
            os.write(master, b"/frog peek")
            wait_for([b"/frog peek"], timeout=2.0, styled=False)
            os.write(master, b"\r")
            wait_for(["▗▄▄▖".encode()], timeout=2.0)
        elif shell_mode == "command":
            command = b"!printf '__SHELL_LINE_1__\\n__SHELL_LINE_2__\\n__SHELL_LINE_3__\\n__SHELL_LINE_4__\\n'"
            os.write(master, command)
            wait_for(["!printf '__SHELL_LINE_1__".encode()], timeout=2.0, styled=False)
            os.write(master, b"\r")
            wait_for([b"__SHELL_LINE_1__", b"__SHELL_LINE_4__", b"__SHELL_IDLE__"], styled=False)
        elif shell_mode == "interrupt":
            os.write(master, b"!sleep 30")
            wait_for(["!sleep 30".encode()], timeout=2.0, styled=False)
            os.write(master, b"\r")
            wait_for([b"Shell sleep 30"], styled=False)
            os.write(master, b"\x03")
            wait_for([b"Cancelled", b"__SHELL_IDLE__"], timeout=4.0, styled=False)
        draft = b"startup draft" if startup_typing else b"junk"
        draft_start = len(transcript)
        os.write(master, draft)
        wait_for([draft], timeout=2.0, styled=False, start=draft_start)
        os.write(master, b"\x7f" * len(draft) + b"/exit")
        wait_for(["/exit▌".encode()], timeout=2.0, styled=False)
        os.write(master, b"\r")

        wait_for_exit()
        pump()
        final_terminal = termios.tcgetattr(slave)
        print(
            json.dumps(
                {
                    "returnCode": process.returncode,
                    "termiosRestored": initial_terminal == final_terminal,
                    "transcript": base64.b64encode(transcript).decode(),
                    "screens": screens,
                    "resizeScreens": resize_screens,
                    "exportSaved": os.path.isfile(os.environ["STRANDS_CLI_TEST_EXPORT_PATH"]),
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
        screen_input.close()
        screen_process.wait(timeout=5.0)
        screen_output.close()
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    raise SystemExit(main())
