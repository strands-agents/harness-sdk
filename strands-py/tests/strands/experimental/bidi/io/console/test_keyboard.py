import asyncio
from unittest.mock import MagicMock, Mock

import pytest
import pytest_asyncio

from strands.experimental.bidi.io.console._keyboard import Keyboard, KeyboardInput


@pytest_asyncio.fixture
async def keyboard(terminal):
    keyboard = Keyboard()
    keyboard.start()
    yield keyboard
    keyboard.stop()


@pytest.mark.asyncio
async def test_read_updates_draft(keyboard, terminal):
    terminal.send_text("draft界é")
    tru_input = await asyncio.wait_for(keyboard.read(), 2)
    exp_input = KeyboardInput("draft界é")
    assert tru_input == exp_input

    terminal.send_text("\x7f!")
    tru_input = await asyncio.wait_for(keyboard.read(), 2)
    exp_input = KeyboardInput("draft界!")
    assert tru_input == exp_input


@pytest.mark.asyncio
async def test_read_preserves_keys_after_submission(keyboard, terminal):
    terminal.send_text("first\r   \rsecond\r")
    tru_inputs = [await asyncio.wait_for(keyboard.read(), 2) for _ in range(3)]
    exp_inputs = [
        KeyboardInput("first", submitted=True),
        KeyboardInput("second", submitted=True),
        KeyboardInput(""),
    ]
    assert tru_inputs == exp_inputs


@pytest.mark.asyncio
async def test_start_restores_terminal_if_attach_fails(terminal, monkeypatch):
    raw_mode = MagicMock()
    monkeypatch.setattr(terminal, "raw_mode", lambda: raw_mode)
    monkeypatch.setattr(terminal, "attach", Mock(side_effect=EOFError))
    keyboard = Keyboard()
    with pytest.raises(EOFError):
        keyboard.start()
    raw_mode.__exit__.assert_called_once()
    keyboard.stop()
