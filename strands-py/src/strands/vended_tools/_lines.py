r"""Line counting shared across sandbox-routed file tools.

``cat -n`` and ``wc -l`` count a trailing newline as the end of the last line, not
as the start of an extra one: ``"a\nb\n"`` is two lines, not three. Splitting on
``"\n"`` alone yields a phantom empty final element, which made the read tool
show a line that does not exist and tell the model there was more to read.
"""

from __future__ import annotations


def split_lines(content: str) -> list[str]:
    r"""Split text into lines the way ``cat -n`` counts them.

    A trailing newline terminates the last line rather than starting a new one, so
    ``"a\nb\n"`` is two lines. Text that does not end with a newline keeps its
    final partial line. Empty text has no lines at all.

    Args:
        content: The text to split.

    Returns:
        The lines of ``content``, without a trailing empty element.
    """
    if not content:
        return []

    lines = content.split("\n")
    if lines[-1] == "":
        lines.pop()

    return lines
