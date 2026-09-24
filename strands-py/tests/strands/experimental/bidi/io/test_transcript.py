import re
from io import StringIO
from unittest.mock import Mock

import pytest
import pytest_asyncio
from rich.console import Console

import strands.experimental.bidi.io.transcript as transcript_module
from strands.experimental.bidi.io.transcript import _TranscriptOutputStream, _UserText
from strands.experimental.bidi.types import (
    BidiBargeInEvent,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
)

_ANSI_ESCAPE = re.compile(r"\x1b\[[?0-9;]*[ -/]*[@-~]")


@pytest.fixture
def console(monkeypatch):
    console = Console(file=StringIO(), force_terminal=False, width=80)
    monkeypatch.setattr(transcript_module, "Console", lambda: console)
    return console


@pytest_asyncio.fixture
async def output(console):
    output = _TranscriptOutputStream()
    await output.start(Mock())
    yield output
    await output.stop()


def render_live(output, console):
    with console.capture() as captured:
        console.print(output._live.renderable)
    rendered = _ANSI_ESCAPE.sub("", captured.get())
    return rendered.splitlines()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("user_events", "exp_lines"),
    [
        ([], ["First response", "Second response"]),
        (
            [
                BidiTranscriptStartEvent("user", "user-transcript"),
                BidiTranscriptDeltaEvent("Next question", "user", "user-transcript"),
                BidiTranscriptStopEvent("Next question", "user", "user-transcript"),
            ],
            ["First response", "> Next question", "Second response"],
        ),
    ],
)
async def test_call_streams_turns(output, console, user_events, exp_lines):
    assert output._live.transient

    for event in [
        BidiTranscriptStartEvent("assistant", "first"),
        BidiTranscriptDeltaEvent("First", "assistant", "first"),
        BidiTranscriptDeltaEvent(" response", "assistant", "first"),
        BidiTranscriptStopEvent("First response", "assistant", "first"),
        BidiResponseStopEvent("first", "end_turn"),
        *user_events,
        BidiTranscriptStartEvent("assistant", "second"),
        BidiTranscriptDeltaEvent("Second response", "assistant", "second"),
        BidiTranscriptStopEvent("Second response", "assistant", "second"),
        BidiResponseStopEvent("second", "end_turn"),
    ]:
        await output(event)

    rendered = _ANSI_ESCAPE.sub("", console.file.getvalue())
    tru_lines = [line for line in rendered.splitlines() if line]
    assert tru_lines == exp_lines
    assert output._live.transient


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "event",
    [
        BidiBargeInEvent("user_speech"),
        BidiResponseStartEvent("first"),
        BidiResponseStopEvent("first", "end_turn"),
        BidiResponseStopEvent("first", "barge_in"),
    ],
)
async def test_call_preserves_transcripts_across_response_events(output, console, event):
    for transcript_event in [
        BidiTranscriptStartEvent("user", "user"),
        BidiTranscriptDeltaEvent("Wait", "user", "user"),
        BidiTranscriptStartEvent("assistant", "assistant"),
        BidiTranscriptDeltaEvent("Hello", "assistant", "assistant"),
        event,
        BidiTranscriptDeltaEvent(" please", "user", "user"),
        BidiTranscriptDeltaEvent(" there", "assistant", "assistant"),
        BidiTranscriptStopEvent("Hello there", "assistant", "assistant"),
        BidiTranscriptStopEvent("Wait please", "user", "user"),
    ]:
        await output(transcript_event)

    rendered = _ANSI_ESCAPE.sub("", console.file.getvalue())
    tru_lines = [line for line in rendered.splitlines() if line]
    exp_lines = ["> Wait please", "Hello there"]
    assert tru_lines == exp_lines


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("second_role", "exp_lines"),
    [
        ("assistant", ["", "> First question", "", "", "Streamed answer", ""]),
        ("user", ["", "> First question", "", "", "> Streamed answer", ""]),
    ],
)
async def test_call_interleaves_transcripts(output, console, second_role, exp_lines):
    for event in [
        BidiTranscriptStartEvent("user", "first"),
        BidiTranscriptDeltaEvent("First", "user", "first"),
        BidiTranscriptStartEvent(second_role, "second"),
        BidiTranscriptDeltaEvent("Streamed answer", second_role, "second"),
        BidiTranscriptDeltaEvent(" question", "user", "first"),
        BidiTranscriptStopEvent("Final answer", second_role, "second"),
    ]:
        await output(event)

    tru_lines = render_live(output, console)
    assert tru_lines == exp_lines
    assert console.file.getvalue() == ""

    await output(BidiTranscriptStartEvent("user", "third"))
    await output(BidiTranscriptDeltaEvent("Next question", "user", "third"))
    await output(BidiTranscriptStopEvent("First question", "user", "first"))

    rendered = _ANSI_ESCAPE.sub("", console.file.getvalue())
    tru_lines = rendered.splitlines()
    assert tru_lines == exp_lines
    assert render_live(output, console) == ["", "> Next question", ""]

    await output(BidiTranscriptStopEvent("Next question", "user", "third"))
    assert render_live(output, console) == ["", "> Start talking ...", ""]
    assert output._transcripts == {}


@pytest.mark.asyncio
async def test_call_wraps_user_text_above_streaming_assistant(output, console):
    console.width = 16
    for event in [
        BidiTranscriptStartEvent("user", "user"),
        BidiTranscriptDeltaEvent("alpha beta", "user", "user"),
        BidiTranscriptStartEvent("assistant", "assistant"),
        BidiTranscriptDeltaEvent("Answer", "assistant", "assistant"),
    ]:
        await output(event)

    tru_lines = render_live(output, console)
    exp_lines = ["", "> alpha beta", "", "", "Answer", ""]
    assert tru_lines == exp_lines

    await output(BidiTranscriptDeltaEvent(" gamma delta", "user", "user"))
    await output(BidiTranscriptDeltaEvent(" growing", "assistant", "assistant"))

    tru_lines = render_live(output, console)
    exp_lines = ["", "> alpha beta ", "  gamma delta", "", "", "Answer growing", ""]
    assert tru_lines == exp_lines


@pytest.mark.asyncio
async def test_stop_preserves_unfinished_transcripts(output, console):
    for event in [
        BidiTranscriptStartEvent("user", "user"),
        BidiTranscriptDeltaEvent("Partial question", "user", "user"),
        BidiTranscriptStartEvent("assistant", "assistant"),
        BidiTranscriptDeltaEvent("Partial answer", "assistant", "assistant"),
    ]:
        await output(event)

    await output.stop()
    await output.stop()

    rendered = _ANSI_ESCAPE.sub("", console.file.getvalue())
    tru_lines = [line for line in rendered.splitlines() if line]
    exp_lines = ["> Partial question", "Partial answer"]
    assert tru_lines == exp_lines
    assert output._transcripts == {}


@pytest.mark.parametrize("no_color", [False, True])
@pytest.mark.parametrize(
    ("text", "exp_lines"),
    [
        ("Hello", ["", "> Hello", ""]),
        ("alpha beta gamma delta", ["", "> alpha beta ", "  gamma delta", ""]),
    ],
)
def test_user_text_render(monkeypatch, no_color, text, exp_lines):
    if no_color:
        monkeypatch.setenv("NO_COLOR", "1")
    else:
        monkeypatch.delenv("NO_COLOR", raising=False)
    console = Console(file=StringIO(), force_terminal=True, color_system="truecolor", width=16, height=24)

    console.print(_UserText(text))

    rendered = console.file.getvalue()
    tru_colors = ("38;2" in rendered, "48;2;243;243;243" in rendered)
    exp_colors = (not no_color, not no_color)
    assert tru_colors == exp_colors
    assert "\x1b[0K" in rendered
    tru_lines = _ANSI_ESCAPE.sub("", rendered).splitlines()
    assert tru_lines == exp_lines


@pytest.mark.asyncio
@pytest.mark.parametrize("started", [False, True])
async def test_stop_restores_cursor(console, monkeypatch, started):
    output = _TranscriptOutputStream()
    if started:
        await output.start(Mock())
    show_cursor = Mock()
    monkeypatch.setattr(console, "show_cursor", show_cursor)

    await output.stop()

    show_cursor.assert_called_with()
    assert output._transcripts == {}
