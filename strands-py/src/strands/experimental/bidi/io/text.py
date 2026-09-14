"""Handle text input and output to and from bidi agent."""

import logging
from typing import Any

from prompt_toolkit import PromptSession

from ..types.events import (
    BidiConnectionCloseEvent,
    BidiInterruptionEvent,
    BidiOutputEvent,
    BidiTextInputEvent,
    BidiTranscriptStreamEvent,
)
from ..types.io import BidiInput, BidiOutput

logger = logging.getLogger(__name__)


class _BidiTextInput(BidiInput):
    """Handle text input from user."""

    def __init__(self, config: dict[str, Any]) -> None:
        """Extract configs and setup prompt session."""
        prompt = config.get("input_prompt", "")
        self._session: PromptSession = PromptSession(prompt)

    async def __call__(self) -> BidiTextInputEvent:
        """Read user input from stdin."""
        text = await self._session.prompt_async()
        return BidiTextInputEvent(text.strip(), role="user")


class _BidiTextOutput(BidiOutput):
    """Handle text output from bidi agent."""

    async def __call__(self, event: BidiOutputEvent) -> None:
        """Print text events to stdout."""
        if isinstance(event, BidiInterruptionEvent):
            logger.debug("reason=<%s> | text output interrupted", event["reason"])
            print("interrupted")

        elif isinstance(event, BidiConnectionCloseEvent):
            if event.reason == "user_request":
                print("user requested connection close using the stop tool.")
                logger.debug("connection_id=<%s> | user requested connection close", event.connection_id)
        elif isinstance(event, BidiTranscriptStreamEvent):
            logger.debug(
                "role=<%s>, text_length=<%d> | text transcript received",
                event.role,
                len(event.delta),
            )
            print(event.delta)


class BidiTextIO:
    """Handle text input and output to and from bidi agent.

    Accepts input from stdin and outputs to stdout.
    """

    def __init__(self, **config: Any) -> None:
        """Initialize I/O.

        Args:
            **config: Optional I/O configurations.

                - input_prompt (str): Input prompt to display on screen (default: blank)
        """
        self._config = config

    def input(self) -> _BidiTextInput:
        """Return text processing BidiInput."""
        return _BidiTextInput(self._config)

    def output(self) -> _BidiTextOutput:
        """Return text processing BidiOutput."""
        return _BidiTextOutput()
