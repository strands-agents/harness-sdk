"""Terminal transcript output for bidirectional streaming."""

import logging
from typing import TYPE_CHECKING

from rich.console import Console, ConsoleOptions, ConsoleRenderable, RenderableType, RenderResult
from rich.live import Live
from rich.segment import ControlType, Segment
from rich.style import Style
from rich.text import Text

from ..types.events import (
    BidiInterruptionEvent,
    BidiOutputEvent,
    BidiResponseCompleteEvent,
    BidiTranscriptStreamEvent,
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


class _BidiTranscriptOutput(BidiOutput):
    """Render transcript events to a terminal stream."""

    def __init__(self) -> None:
        """Initialize transcript output."""
        self._console = Console()
        self._live: Live
        self._role: Role | None = None
        self._transcript: str | None = None

    async def start(self, _agent: "BidiAgent") -> None:
        """Start transcript output."""
        self._start_transcript("user")

    async def stop(self) -> None:
        """Finish pending transcript output and restore the terminal cursor."""
        try:
            self._stop_transcript()
        finally:
            self._console.show_cursor()

    async def __call__(self, event: BidiOutputEvent) -> None:
        """Render transcript lifecycle events."""
        if isinstance(event, BidiTranscriptStreamEvent):
            logger.debug("role=<%s> | transcript streamed", event.role)

            if self._role != event.role or self._transcript is None:
                self._restart_transcript(event.role, delta=event.delta)
            else:
                self._update_transcript(event.delta)

        elif isinstance(event, BidiInterruptionEvent):
            logger.debug("reason=<%s> | transcript interrupted", event.reason)

            if self._role != "user" or self._transcript is None:
                self._restart_transcript("user", delta="")

        elif isinstance(event, BidiResponseCompleteEvent):
            logger.debug("response_id=<%s>, role=<%s> | transcript complete", event.response_id, self._role)

            if event.stop_reason == "interrupted":
                if self._role != "user" or self._transcript is None:
                    self._restart_transcript("user", delta="")
            else:
                self._restart_transcript("user")

    def _start_transcript(
        self,
        role: Role,
        *,
        delta: str | None = None,
    ) -> None:
        """Start a mutable transcript."""
        self._role = role
        self._transcript = delta

        self._live = Live(
            self._build_renderable(),
            console=self._console,
            auto_refresh=False,
            transient=delta is None,
            redirect_stdout=False,
            redirect_stderr=False,
        )
        self._live.start(refresh=True)

    def _restart_transcript(
        self,
        role: Role,
        *,
        delta: str | None = None,
    ) -> None:
        """Stop the active transcript and start a new one."""
        self._stop_transcript()
        self._start_transcript(role, delta=delta)

    def _update_transcript(self, delta: str) -> None:
        """Update the active transcript."""
        self._transcript = f"{self._transcript or ''}{delta}"
        self._live.update(self._build_renderable(), refresh=True)

    def _stop_transcript(self) -> None:
        """Stop the active transcript."""
        if self._role is not None:
            self._live.stop()

        self._role = None
        self._transcript = None

    def _build_renderable(self) -> RenderableType:
        """Build the current Rich transcript block."""
        transcript = " ".join(self._transcript.split()) if self._transcript is not None else None
        match self._role:
            case "assistant":
                return Text(f"\n{transcript}\n")
            case "user":
                return _UserText(transcript)
            case None:
                raise RuntimeError("cannot render an inactive transcript")
