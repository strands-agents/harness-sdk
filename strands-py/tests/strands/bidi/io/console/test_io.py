import asyncio
import io
import signal
from functools import partial
from unittest.mock import Mock

import pytest
import pytest_asyncio
from rich.color import Color
from rich.console import Console
from rich.text import Text

from strands.bidi.io import ConsoleIO, ConsoleIOConfig
from strands.bidi.types import (
    BidiConnectionStopEvent,
    BidiReasoningDeltaEvent,
    BidiReasoningStartEvent,
    BidiReasoningStopEvent,
    BidiTextBlockEvent,
    BidiTextDeltaEvent,
    BidiTextStartEvent,
    BidiTextStopEvent,
    BidiToolUseBlocksEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
)
from strands.types.content import TextBlock


@pytest.fixture
def console(terminal, monkeypatch, request):
    if hasattr(request, "param"):
        options = {"force_interactive": False, "no_color": False, **request.param}
        monkeypatch.setattr(
            "strands.bidi.io.console._display.Console",
            partial(Console, file=io.StringIO(), force_terminal=True, width=24, height=24, **options),
        )
    return ConsoleIO()


@pytest.fixture
def tool_use_event():
    return BidiToolUseBlocksEvent([{"toolUseId": name, "name": name, "input": {}} for name in ("weather", "time")])


@pytest_asyncio.fixture
async def input_stream(console):
    input_ = console.input()
    await input_.start(Mock())

    yield input_

    await input_.stop()


@pytest_asyncio.fixture
async def output_stream(console):
    output = console.output()
    await output.start(Mock())

    yield output

    await output.stop()


@pytest_asyncio.fixture
async def reader(input_stream):
    reader = asyncio.create_task(input_stream())
    await asyncio.sleep(0)

    yield reader

    reader.cancel()
    await asyncio.gather(reader, return_exceptions=True)


@pytest.mark.asyncio
async def test_input_preserves_draft_during_output(console, reader, output_stream, terminal, tool_use_event):
    async def wait_for_draft():
        while console._display.draft != "draft":
            await asyncio.sleep(0)

    terminal.send_text("draft")
    await asyncio.wait_for(wait_for_draft(), 2)

    await output_stream(BidiTextStartEvent("text"))
    await output_stream(BidiTextDeltaEvent("Answer", "text"))
    await output_stream(tool_use_event)

    assert console._display.draft == "draft"
    with console._display.console.capture() as capture:
        console._display.console.print(console._display)
    assert "Tools: [weather, time]" in capture.get()

    terminal.send_text("\x7f!\r")
    tru_input = await asyncio.wait_for(reader, 2)
    exp_input = TextBlock("draf!")
    assert tru_input == exp_input
    assert console._display.draft == ""


@pytest.mark.asyncio
async def test_input_forwards_ctrl_c(reader, terminal):
    interrupted = asyncio.Event()
    original = signal.signal(signal.SIGINT, lambda *_: interrupted.set())

    try:
        terminal.send_text("\x03")
        await asyncio.wait_for(interrupted.wait(), 2)
        assert not reader.done()

        terminal.send_text("still typing\r")
        tru_input = await asyncio.wait_for(reader, 2)
        exp_input = TextBlock("still typing")
        assert tru_input == exp_input

    finally:
        signal.signal(signal.SIGINT, original)


@pytest.mark.asyncio
async def test_input_closed_raises_eof(reader, terminal):
    terminal.close()

    with pytest.raises(EOFError):
        await asyncio.wait_for(reader, 2)


@pytest.mark.asyncio
async def test_input_stop_releases_keyboard_after_cancellation(input_stream, reader, terminal):
    reader.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reader

    await input_stream.stop()

    terminal.send_text("x")
    tru_keys = [key.data for key in terminal.read_keys()]
    exp_keys = ["x"]
    assert tru_keys == exp_keys


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_count, exp_tool_text", [(1, "Tools: [weather]"), (2, "Tools: [weather, time]")])
async def test_output_completes_interleaved_content_in_order(
    console, output_stream, capsys, tool_use_event, tool_count, exp_tool_text
):
    for event in [
        BidiTranscriptStartEvent("user", "user"),
        BidiTranscriptDeltaEvent("Question", "user", "user"),
        BidiReasoningStartEvent("reasoning"),
        BidiReasoningDeltaEvent("Thinking", "reasoning"),
        BidiToolUseBlocksEvent(tool_use_event.tool_uses[:tool_count]),
        BidiTextStartEvent("text"),
        BidiTextDeltaEvent("Answer", "text"),
        BidiTranscriptStartEvent("assistant", "speech"),
        BidiTranscriptDeltaEvent("Spoken answer", "assistant", "speech"),
        BidiReasoningStopEvent("reasoning"),
        BidiTextStopEvent("text"),
        BidiTextBlockEvent("Answer", "text"),
        BidiTranscriptStopEvent("assistant", "speech"),
    ]:
        await output_stream(event)

    assert capsys.readouterr().out == ""

    await output_stream(BidiTranscriptStopEvent("user", "user"))

    tru_lines = [line for line in capsys.readouterr().out.splitlines() if line]
    exp_lines = ["> Question", "Reasoning: Thinking", exp_tool_text, "Answer", "Spoken answer"]
    assert tru_lines == exp_lines
    assert not console._display.blocks


@pytest.mark.asyncio
async def test_stop_preserves_partial_content(console, input_stream, output_stream, capsys):
    await output_stream(BidiTextStartEvent("text"))
    await output_stream(BidiTextDeltaEvent("Partial", "text"))

    await input_stream.stop()
    await output_stream.stop()

    assert capsys.readouterr().out == "Partial\n\n"
    assert not console._display.blocks


@pytest.mark.asyncio
@pytest.mark.parametrize("complete", [True, False], ids=["completed", "shutdown"])
@pytest.mark.parametrize(
    ("console", "exp_background"),
    [
        pytest.param({"color_system": "truecolor"}, Color.parse("#f3f3f3"), id="color"),
        pytest.param({"color_system": None}, None, id="plain"),
        pytest.param({"color_system": "truecolor", "no_color": True}, None, id="no-color"),
    ],
    indirect=["console"],
)
async def test_output_preserves_user_background_padding(console, output_stream, complete, exp_background):
    await output_stream(BidiTranscriptStartEvent("user", "user"))
    await output_stream(BidiTranscriptDeltaEvent("Question", "user", "user"))
    with console._display.console.capture() as capture:
        if complete:
            await output_stream(BidiTranscriptStopEvent("user", "user"))
        else:
            await output_stream.stop()

    lines = Text.from_ansi(capture.get()).split("\n")
    tru_lines = [
        (
            line.plain,
            [line.get_style_at_offset(console._display.console, offset).bgcolor for offset in range(len(line))],
        )
        for line in lines
    ]
    if exp_background:
        width = console._display.console.width
        background = [exp_background] * width
        exp_lines = [
            (" " * width, background),
            ("> Question".ljust(width), background),
            (" " * width, background),
            ("", []),
        ]
    else:
        exp_lines = [("", []), ("> Question", [None] * 10), ("", []), ("", [])]
    assert tru_lines == exp_lines


@pytest.mark.asyncio
async def test_output_connection_stop_flushes_partial_content(console, output_stream, capsys):
    await output_stream(BidiTextStartEvent("text"))
    await output_stream(BidiTextDeltaEvent("Partial", "text"))

    await output_stream(BidiConnectionStopEvent("connection", reason="user_request"))

    assert capsys.readouterr().out.strip() == "Partial"
    assert not console._display.blocks


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", ["text", "reasoning", "transcript", "tools", None])
async def test_output_filters_content(enabled, capsys, tool_use_event):
    config = ConsoleIOConfig(
        show_text=enabled == "text",
        show_reasoning=enabled == "reasoning",
        show_transcript=enabled == "transcript",
        show_tools=enabled == "tools",
    )
    console = ConsoleIO(**config)
    output = console.output()
    await output.start(Mock())

    try:
        for event in [
            BidiReasoningStartEvent("reasoning"),
            BidiReasoningDeltaEvent("Thinking", "reasoning"),
            BidiTextStartEvent("text"),
            BidiTextDeltaEvent("Answer", "text"),
            BidiTranscriptStartEvent("assistant", "speech"),
            BidiTranscriptDeltaEvent("Spoken", "assistant", "speech"),
            tool_use_event,
            BidiReasoningStopEvent("reasoning"),
            BidiTextStopEvent("text"),
            BidiTranscriptStopEvent("assistant", "speech"),
        ]:
            await output(event)

        tru_output = capsys.readouterr().out.strip()
        exp_output = {
            "text": "Answer",
            "reasoning": "Reasoning: Thinking",
            "transcript": "Spoken",
            "tools": "Tools: [weather, time]",
            None: "",
        }[enabled]
        assert tru_output == exp_output

    finally:
        await output.stop()
