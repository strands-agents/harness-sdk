"""Offload placeholder types, shared by message content and tool result content."""

from typing import Literal

from typing_extensions import NotRequired, TypedDict

OffloadMethod = Literal["drop", "truncate", "summarize"]
"""Offload method that replaced content with a placeholder."""


class OffloadedBlock(TypedDict):
    """Provenance of the text a strategy left in place of content it offloaded, under a block's ``offloaded`` key.

    The block reads as plain text everywhere else, so text stored without the key reads back as plain text.

    Attributes:
        method: Offload method that left the placeholder.
        ref: Stash reference the original is retrievable under; absent when it was not stashed.
        tokens: Size of the content it stands for, including any placeholder it replaced; absent when the token
            count could not measure it.
    """

    method: OffloadMethod
    ref: NotRequired[str]
    tokens: NotRequired[int]
