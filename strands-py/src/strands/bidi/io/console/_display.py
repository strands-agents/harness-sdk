"""Render content streams and the editable keyboard draft with Rich."""

from typing import Any

from rich.console import Console, Group, RenderableType
from rich.live import Live
from rich.padding import Padding
from rich.segment import Segment, Segments
from rich.table import Table
from rich.text import Text


class DisplayBlock(Text):
    """Text with completion state for one displayed content block."""

    def __init__(self, text: str = "", *, complete: bool = False, **kwargs: Any) -> None:
        """Initialize text and rendering options with its completion state."""
        super().__init__(text, **kwargs)
        self.complete = complete


class UserBlock(DisplayBlock):
    """Text displayed in a padded gray block with a user prefix."""

    def __rich__(self) -> RenderableType:
        """Expand tabs and render the user background, prefix, and spacing."""
        # Render a plain Text copy to avoid reapplying the user layout.
        text = self.copy()
        text.expand_tabs(4)

        content = Table.grid(expand=True)
        content.add_column(width=2)
        content.add_column(ratio=1, overflow="fold")
        content.add_row(">", text)
        return Padding(Padding(content, (1, 0), style="#373737 on #f3f3f3"), (0, 0, 1, 0))


class AssistantBlock(DisplayBlock):
    """Assistant text displayed with spacing between blocks."""

    def __rich__(self) -> RenderableType:
        """Render assistant text with a trailing blank line."""
        return Padding(self.copy(), (0, 0, 1, 0))


class ReasoningBlock(DisplayBlock):
    """Reasoning displayed in gray italics with a prefix."""

    def __rich__(self) -> RenderableType:
        """Render prefixed reasoning with a single trailing blank line."""
        text = self.copy()
        text.rstrip()
        text = Text("Reasoning: ", style="#808080 italic") + text
        return Padding(text, (0, 0, 1, 0))


class ToolBlock(DisplayBlock):
    """Tool call names displayed in gray."""

    def __rich__(self) -> RenderableType:
        """Render bracketed tool names with a trailing blank line."""
        text = Text("Tools: [", style="#808080") + self.copy() + Text("]")
        return Padding(text, (0, 0, 1, 0))


class Display:
    """Show active content and a draft while preserving completed text in terminal history."""

    def __init__(self, placeholder: str) -> None:
        """Initialize the terminal display and input placeholder."""
        self.placeholder = placeholder
        self.blocks: dict[str, DisplayBlock] = {}
        self.draft = ""
        self.console = Console()
        self.live: Live
        self.started = False

    def start(self) -> None:
        """Start live rendering if the display is not already running."""
        if self.started:
            return

        self.live = Live(
            self, console=self.console, auto_refresh=False, transient=True, redirect_stdout=False, redirect_stderr=False
        )
        self.live.start(refresh=True)
        self.started = True

    def stop(self) -> None:
        """Close live rendering and print remaining blocks, including unfinished content."""
        if not self.started:
            return

        self.started = False
        self.live.stop()
        if self.blocks:
            self._print_blocks([block for block in self.blocks.values() if block])
            self.blocks.clear()
        self.console.show_cursor()

    def refresh(self) -> None:
        """Print completed blocks in order and redraw the remaining live content."""
        if not self.started:
            return

        completed = []
        while self.blocks:
            content_id = next(iter(self.blocks))
            if not self.blocks[content_id].complete:
                # Later blocks stay live until this block finishes.
                break
            block = self.blocks.pop(content_id)
            if block:
                completed.append(block)

        if completed:
            self._print_blocks(completed)
        else:
            self.live.refresh()

    def _print_blocks(self, blocks: list[DisplayBlock]) -> None:
        """Trim scrollback padding while preserving visible background colors."""
        segments = []
        color_enabled = self.console.color_system is not None and not self.console.no_color
        for line in self.console.render_lines(Group(*blocks), pad=False):
            # Background-colored spaces paint the user box, including its empty padding lines.
            if not (color_enabled and any(segment.style and segment.style.bgcolor for segment in line)):
                while line and not line[-1].control and not line[-1].text.rstrip(" "):
                    line.pop()
                if line:
                    last = line[-1]
                    line[-1] = Segment(last.text.rstrip(" "), last.style, last.control)
            segments.extend(line)
            segments.append(Segment.line())
        self.console.print(Segments(segments), end="")

    def __rich__(self) -> RenderableType:
        """Render the newest content and input block within the terminal height."""
        rendered = Group(*self.blocks.values(), self._input_block())
        # Keep the newest output visible; completed blocks retain their full text for scrollback.
        lines = self.console.render_lines(rendered, pad=False, new_lines=True)
        height = max(self.console.height - 1, 1)
        return Segments(segment for line in lines[-height:] for segment in line)

    def _input_block(self) -> UserBlock:
        """Build the keyboard draft or placeholder with its cursor."""
        if self.draft or not self.placeholder:
            block = UserBlock(self.draft)
            block.append("▏", style="reverse")
        else:
            block = UserBlock(self.placeholder, style="#a0a0a0")
            block.stylize("on #d8d8d8", 0, 1)
        return block
