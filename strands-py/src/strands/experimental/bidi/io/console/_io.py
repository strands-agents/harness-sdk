"""Console configuration and bidirectional input/output streams."""

import uuid
from typing import TYPE_CHECKING

from typing_extensions import Unpack

from .....types.content import TextBlock
from ...types.events import (
    BidiConnectionRestartEvent,
    BidiConnectionStopEvent,
    BidiOutputEvent,
    BidiReasoningDeltaEvent,
    BidiReasoningStartEvent,
    BidiReasoningStopEvent,
    BidiTextDeltaEvent,
    BidiTextStartEvent,
    BidiTextStopEvent,
    BidiToolUseBlocksEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
)
from ...types.io import InputStream, OutputStream
from ..configs import ConsoleIOConfig
from ._display import AssistantBlock, Display, ReasoningBlock, ToolBlock, UserBlock
from ._keyboard import Keyboard

if TYPE_CHECKING:
    from ...agent.agent import BidiAgent


class ConsoleIO:
    """Type messages while displaying text, reasoning, speech transcripts, and tool calls.

    Input and output share a terminal display, so streamed content preserves the
    unfinished input line. Enter sends a message.
    """

    def __init__(self, **config: Unpack[ConsoleIOConfig]) -> None:
        """Initialize the console.

        Args:
            **config: Optional configuration:

                - placeholder (str): Hint displayed when the input block is empty (default: "").
                - show_text (bool): Display agent text responses (default: True).
                - show_reasoning (bool): Display agent reasoning (default: True).
                - show_transcript (bool): Display user and agent speech transcripts (default: True).
                - show_tools (bool): Display tool call names (default: True).
        """
        self._config: ConsoleIOConfig = {
            "placeholder": "",
            "show_text": True,
            "show_reasoning": True,
            "show_transcript": True,
            "show_tools": True,
            **config,
        }
        self._display = Display(self._config["placeholder"])
        self._keyboard = Keyboard()

    def input(self) -> "_ConsoleInputStream":
        """Return the keyboard input stream."""
        return _ConsoleInputStream(self._display, self._keyboard)

    def output(self) -> "_ConsoleOutputStream":
        """Return the text, reasoning, transcript, and tool call output stream."""
        return _ConsoleOutputStream(self._config, self._display)


class _ConsoleInputStream(InputStream):
    """Read submitted messages while keeping the keyboard draft visible."""

    def __init__(self, display: Display, keyboard: Keyboard) -> None:
        """Share the console's display and keyboard reader."""
        self._display = display
        self._keyboard = keyboard

    async def start(self, agent: "BidiAgent") -> None:
        """Enable terminal input and start the shared display."""
        self._keyboard.start()
        self._display.start()

    async def stop(self) -> None:
        """Restore terminal input settings and flush the display."""
        self._keyboard.stop()
        self._display.stop()

    async def __call__(self) -> TextBlock:
        """Refresh the draft until Enter submits a nonempty message.

        Raises:
            EOFError: If terminal input closes before another message is submitted.
        """
        while True:
            keyboard_input = await self._keyboard.read()
            if keyboard_input.submitted:
                self._display.draft = ""
                self._display.blocks[str(uuid.uuid4())] = UserBlock(keyboard_input.text, complete=True)
                self._display.refresh()
                return TextBlock(keyboard_input.text)

            self._display.draft = keyboard_input.text
            self._display.refresh()


class _ConsoleOutputStream(OutputStream):
    """Display enabled text, reasoning, transcript, and tool call output."""

    def __init__(self, config: ConsoleIOConfig, display: Display) -> None:
        """Share the configured content filters and terminal display."""
        self._config = config
        self._display = display

    async def start(self, agent: "BidiAgent") -> None:
        """Start the shared display."""
        self._display.start()

    async def stop(self) -> None:
        """Flush remaining content and close the shared display."""
        self._display.stop()

    async def __call__(self, event: BidiOutputEvent) -> None:
        """Apply a content stream event and refresh the display."""
        if isinstance(event, BidiTextStartEvent) and self._config["show_text"]:
            self._display.blocks[event.content_id] = AssistantBlock()
        elif isinstance(event, BidiReasoningStartEvent) and self._config["show_reasoning"]:
            self._display.blocks[event.content_id] = ReasoningBlock()
        elif isinstance(event, BidiTranscriptStartEvent) and self._config["show_transcript"]:
            self._display.blocks[event.content_id] = UserBlock() if event.role == "user" else AssistantBlock()
        elif isinstance(event, BidiToolUseBlocksEvent) and self._config["show_tools"]:
            if not event.tool_uses:
                return
            names = ", ".join(tool_use["name"] for tool_use in event.tool_uses)
            self._display.blocks[event.tool_uses[0]["toolUseId"]] = ToolBlock(names, complete=True)
        elif isinstance(event, (BidiTextDeltaEvent, BidiReasoningDeltaEvent, BidiTranscriptDeltaEvent)):
            block = self._display.blocks.get(event.content_id)
            if block is None:
                return
            block.append(event.delta)
        elif isinstance(event, (BidiTextStopEvent, BidiReasoningStopEvent, BidiTranscriptStopEvent)):
            block = self._display.blocks.get(event.content_id)
            if block is None:
                return
            block.complete = True
        elif isinstance(event, (BidiConnectionRestartEvent, BidiConnectionStopEvent)):
            for block in self._display.blocks.values():
                block.complete = True
        else:
            return

        self._display.refresh()
