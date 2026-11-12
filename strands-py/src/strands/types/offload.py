"""Offload placeholder types, shared by message content and tool result content."""

from typing import Literal

from typing_extensions import NotRequired, TypedDict

OffloadMethod = Literal["drop", "truncate", "summarize"]
"""Offload method that replaced content with a placeholder."""


class OffloadedBlock(TypedDict):
    """Provenance of the text a context manager's strategy left in place of content it offloaded.

    The block carrying it is text to every reader of ``agent.messages`` and to every model provider — the content
    really is text — so only code that cares where the text came from reads this (``"offloaded" in block``). Text
    stored without the key, such as a session saved before placeholders carried their provenance, reads back as
    plain text.

    Attributes:
        method: Offload method that left the placeholder.
        ref: Stash reference under which the original is retrievable; absent when it was not stashed.
        tokens: Size of the content this placeholder stands for, in tokens, including any placeholder it replaced;
            absent when the token count could not measure it.
    """

    method: OffloadMethod
    ref: NotRequired[str]
    tokens: NotRequired[int]
