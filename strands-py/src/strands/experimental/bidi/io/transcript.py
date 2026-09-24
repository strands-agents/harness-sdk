"""Terminal transcript output for bidirectional streaming."""

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from rich.console import Console, ConsoleOptions, ConsoleRenderable, Group, RenderableType, RenderResult
from rich.live import Live
from rich.segment import ControlType, Segment
from rich.style import Style
from rich.text import Text

from ..types.events import (
    BidiOutputEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
    Role,
)
from ..types.io import BidiOutput

if TYPE_CHECKING:
    from ..agent.agent import BidiAgent

logger = logging.getLogger(__name__)


class _UserText(ConsoleRenderable):
    """Render a full-width user block without adding copyable trailing spaces."""

    BACKGROUND_COLOR = "#f3f3f3"
    PLACEHOLDER = "Start talking ..."
    PLACEHOLDER_COLOR = "#a0a0a0"
    TEXT_COLOR = "#373737"
    TEXT_PREFIX = "> "

    def __init__(self, text: str | None = None) -> None:
        """Initialize a user transcript block."""
        self._text = text

    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        """Render wrapped text and color each row through the terminal edge."""
        text = self.PLACEHOLDER if self._text is None else self._text
        color = self.PLACEHOLDER_COLOR if self._text is None else self.TEXT_COLOR
        style = Style(color=color, bgcolor=self.BACKGROUND_COLOR)
        erase_to_end = Segment(
            "\x1b[0K",
            style,
            ((ControlType.ERASE_IN_LINE, 0),),
        )

        yield erase_to_end
        yield Segment.line()

        lines = Text(text, style=style).wrap(
            console,
            max(options.max_width - len(self.TEXT_PREFIX), 1),
            overflow="fold",
        )
        for index, line in enumerate(lines or [Text("", style=style)]):
            prefix = self.TEXT_PREFIX if index == 0 else " " * len(self.TEXT_PREFIX)
            row = Text(f"{prefix}{line.plain}", style=style, end="")
            yield row
            yield erase_to_end
            yield Segment.line()

        yield erase_to_end
        yield Segment.line()


@dataclass
class _Transcript:
    """Text and completion state for one transcript."""

    role: Role
    text: str = ""
    complete: bool = False

    def __rich__(self) -> RenderableType:
        """Render the transcript using its speaker's style."""
        text = " ".join(self.text.split())
        if self.role == "user":
            return _UserText(text)
        return Text(f"\n{text}\n")


class _BidiTranscriptOutput(BidiOutput):
    """Render transcript events to a terminal stream."""

    def __init__(self) -> None:
        """Initialize transcript output."""
        self._console = Console()
        self._live: Live
        self._transcripts: dict[str, _Transcript] = {}

    async def start(self, _agent: "BidiAgent") -> None:
        """Start transcript output."""
        self._live = Live(
            self,
            console=self._console,
            auto_refresh=False,
            transient=True,
            redirect_stdout=False,
            redirect_stderr=False,
        )
        self._live.start(refresh=True)

    async def stop(self) -> None:
        """Print remaining transcripts and restore the terminal cursor."""
        try:
            remaining = list(self._transcripts.values())
            self._transcripts.clear()
            if hasattr(self, "_live"):
                self._live.stop()
            if remaining:
                self._console.print(Group(*remaining))
        finally:
            self._console.show_cursor()

    async def __call__(self, event: BidiOutputEvent) -> None:
        """Update the transcript identified by its start, delta, or stop event."""
        if isinstance(event, BidiTranscriptStartEvent):
            self._transcripts[event.content_id] = _Transcript(event.role)
        elif isinstance(event, BidiTranscriptDeltaEvent):
            self._transcripts[event.content_id].text += event.delta
        elif isinstance(event, BidiTranscriptStopEvent):
            self._transcripts[event.content_id].complete = True
        else:
            return

        logger.debug("content_id=<%s>, event_type=<%s> | transcript received", event.content_id, event["type"])
        self._refresh()

    def _refresh(self) -> None:
        """Print completed entries in order and redraw the remaining transcripts."""
        completed = []
        while self._transcripts:
            content_id = next(iter(self._transcripts))
            if not self._transcripts[content_id].complete:
                break
            # Later entries stay live until every preceding transcript has finished.
            completed.append(self._transcripts.pop(content_id))

        if completed:
            self._console.print(Group(*completed))
        else:
            self._live.refresh()

    def __rich__(self) -> RenderableType:
        """Group the live transcripts, or prompt for speech when none remain."""
        if self._transcripts:
            return Group(*self._transcripts.values())
        return _UserText()
