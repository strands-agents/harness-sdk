import re
from io import StringIO
from unittest.mock import Mock

import pytest
import pytest_asyncio
from rich.console import Console

import strands.experimental.bidi.io.transcript as transcript_module
from strands.experimental.bidi.io.transcript import _BidiTranscriptOutput, _UserText
from strands.experimental.bidi.types.events import (
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTranscriptStreamEvent,
)

_ANSI_ESCAPE = re.compile(r"\x1b\[[?0-9;]*[ -/]*[@-~]")


@pytest.fixture
def console(monkeypatch):
    console = Console(file=StringIO(), force_terminal=False, width=80)
    monkeypatch.setattr(transcript_module, "Console", lambda: console)
    return console


@pytest_asyncio.fixture
async def output(console):
    output = _BidiTranscriptOutput()
    await output.start(Mock())
    yield output
    await output.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("user_events", "exp_lines"),
    [
        ([], ["First response", "Second response"]),
        (
            [BidiTranscriptStreamEvent("Next question", "user")],
            ["First response", "> Next question", "Second response"],
        ),
    ],
)
async def test_call_streams_turns(output, console, user_events, exp_lines):
    assert output._live.transient

    for event in [
        BidiTranscriptStreamEvent("First", "assistant"),
        BidiTranscriptStreamEvent(" response", "assistant"),
        BidiResponseCompleteEvent("first", "complete"),
        *user_events,
        BidiTranscriptStreamEvent("Second response", "assistant"),
        BidiResponseCompleteEvent("second", "complete"),
    ]:
        await output(event)

    rendered = _ANSI_ESCAPE.sub("", console.file.getvalue())
    tru_lines = [line for line in rendered.splitlines() if line]
    assert tru_lines == exp_lines
    assert output._live.transient


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "event",
    [BidiInterruptionEvent("user_speech"), BidiResponseCompleteEvent("first", "interrupted")],
)
@pytest.mark.parametrize(
    ("initial", "exp_transcript"),
    [
        (None, ""),
        (BidiTranscriptStreamEvent("Hello", "assistant"), ""),
        (BidiTranscriptStreamEvent("Wait", "user"), "Wait"),
    ],
)
async def test_call_interrupts_response(output, event, initial, exp_transcript):
    if initial is not None:
        await output(initial)
    await output(event)

    tru_state = (output._role, output._transcript, output._live.transient)
    exp_state = ("user", exp_transcript, False)
    assert tru_state == exp_state

    user_live = output._live
    await output(event)
    await output(BidiTranscriptStreamEvent(" please", "user"))

    assert output._live is user_live
    assert output._transcript == f"{exp_transcript} please"


@pytest.mark.asyncio
async def test_call_ignores_response_start(output):
    await output(BidiTranscriptStreamEvent("Wait", "user"))
    user_live = output._live

    await output(BidiResponseStartEvent("first"))
    await output(BidiTranscriptStreamEvent(" please", "user"))

    assert output._live is user_live
    assert output._transcript == "Wait please"


@pytest.mark.parametrize("no_color", [False, True])
@pytest.mark.parametrize(
    ("text", "exp_lines"),
    [
        ("Hello", ["", "> Hello"]),
        ("alpha beta gamma delta", ["", "> alpha beta ", "  gamma delta"]),
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
    output = _BidiTranscriptOutput()
    if started:
        await output.start(Mock())
    show_cursor = Mock()
    monkeypatch.setattr(console, "show_cursor", show_cursor)

    await output.stop()

    show_cursor.assert_called_with()
    assert output._role is None
