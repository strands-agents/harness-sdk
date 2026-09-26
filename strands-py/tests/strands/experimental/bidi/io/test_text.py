import unittest.mock

import pytest

from strands.experimental.bidi.io import ConsoleIO
from strands.experimental.bidi.types import BidiBargeInEvent, BidiTranscriptDeltaEvent
from strands.types.content import TextBlock


@pytest.fixture
def prompt_session():
    with unittest.mock.patch("strands.experimental.bidi.io.text.PromptSession") as mock:
        yield mock.return_value


@pytest.fixture
def text_io():
    return ConsoleIO()


@pytest.fixture
def text_input(text_io):
    return text_io.input()


@pytest.fixture
def text_output(text_io):
    return text_io.output()


@pytest.mark.asyncio
async def test_console_io_input(prompt_session, text_input):
    prompt_session.prompt_async = unittest.mock.AsyncMock(return_value="test value")

    tru_event = await text_input()
    exp_event = TextBlock("test value")
    assert tru_event == exp_event


@pytest.mark.parametrize(
    ("event", "exp_print"),
    [
        (BidiBargeInEvent(reason="user_speech"), "barge-in"),
        (BidiTranscriptDeltaEvent(delta="test text", role="user", content_id="user-transcript"), "test text"),
        (
            BidiTranscriptDeltaEvent(delta="test text", role="assistant", content_id="assistant-transcript"),
            "test text",
        ),
    ],
)
@pytest.mark.asyncio
async def test_console_io_output(event, exp_print, text_output, capsys):
    await text_output(event)

    tru_print = capsys.readouterr().out.strip()
    assert tru_print == exp_print
