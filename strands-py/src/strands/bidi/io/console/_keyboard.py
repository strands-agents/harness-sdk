"""Read keyboard input as draft text and submitted messages."""

import asyncio
import signal
from collections.abc import Iterator
from contextlib import ExitStack
from dataclasses import dataclass

from prompt_toolkit.application import get_app_session
from prompt_toolkit.key_binding import KeyPress
from prompt_toolkit.keys import Keys


@dataclass
class KeyboardInput:
    """The current keyboard draft or a message submitted by pressing Enter."""

    text: str
    submitted: bool = False


class Keyboard:
    """Manage terminal input and retain unfinished drafts and key batches."""

    def __init__(self) -> None:
        """Initialize keyboard state."""
        self._input = get_app_session().input
        self._text = ""
        self._keys: Iterator[KeyPress] | None = None
        self._ready = asyncio.Event()
        self._stack = ExitStack()

    def start(self) -> None:
        """Enable keyboard input."""
        self._ready.set()

        with ExitStack() as stack:
            stack.enter_context(self._input.raw_mode())
            stack.enter_context(self._input.attach(self._ready.set))
            self._stack = stack.pop_all()

    def stop(self) -> None:
        """Restore terminal settings and detach input notifications."""
        self._stack.close()

    async def read(self) -> KeyboardInput:
        """Read draft text or a message submitted with Enter.

        Raises:
            EOFError: If the input source has closed and its key batch is exhausted.
        """
        if self._keys is None:
            if self._input.closed:
                raise EOFError
            await self._ready.wait()
            self._ready.clear()
            self._keys = iter(self._input.read_keys())

        for key in self._keys:
            if key.key in (Keys.ControlM, Keys.ControlJ):
                message = self._text.strip()
                self._text = ""
                if message:
                    return KeyboardInput(message, submitted=True)
            elif key.key == Keys.ControlC:
                signal.raise_signal(signal.SIGINT)
            elif key.key == Keys.Backspace:
                self._text = self._text[:-1]
            elif not isinstance(key.key, Keys):
                self._text += key.data

        self._keys = None
        return KeyboardInput(self._text)
