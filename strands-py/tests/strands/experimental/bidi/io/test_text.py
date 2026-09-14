import unittest.mock

import pytest

from strands.experimental.bidi.io import BidiTextIO
from strands.experimental.bidi.types.events import (
    BidiInterruptionEvent,
    BidiTextInputEvent,
    BidiTranscriptStreamEvent,
)


@pytest.fixture
def prompt_session():
    with unittest.mock.patch("strands.experimental.bidi.io.text.PromptSession") as mock:
        yield mock.return_value


@pytest.fixture
def text_io():
    return BidiTextIO()


@pytest.fixture
def text_input(text_io):
    return text_io.input()


@pytest.fixture
def text_output(text_io):
    return text_io.output()


@pytest.mark.asyncio
async def test_bidi_text_io_input(prompt_session, text_input):
    prompt_session.prompt_async = unittest.mock.AsyncMock(return_value="test value")

    tru_event = await text_input()
    exp_event = BidiTextInputEvent(text="test value", role="user")
    assert tru_event == exp_event


@pytest.mark.parametrize(
    ("event", "exp_print"),
    [
        (BidiInterruptionEvent(reason="user_speech"), "interrupted"),
        (BidiTranscriptStreamEvent(delta="test text", role="user"), "test text"),
        (BidiTranscriptStreamEvent(delta="test text", role="assistant"), "test text"),
    ],
)
@pytest.mark.asyncio
async def test_bidi_text_io_output(event, exp_print, text_output, capsys):
    await text_output(event)

    tru_print = capsys.readouterr().out.strip()
    assert tru_print == exp_print
