"""The deprecated ``bash`` tool: the pre-rename shape of :mod:`.shell`.

``shell`` superseded ``bash`` because the tool routes commands through the
sandbox, which runs ``sh`` or the remote login shell rather than bash
specifically. The old tool keeps working under its old name until v2.0.0:
``strands.vended_tools.bash`` resolves to the instance defined here (emitting a
``DeprecationWarning`` on access), and :func:`make_bash` builds instances that
default to the pre-rename tool name.

This module is named ``_bash`` rather than ``bash`` because importing a public
``bash`` submodule would bind it onto the package, silently shadowing the
``__getattr__`` that emits the warning and handing callers a module where they
expect a tool.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from typing_extensions import deprecated

from .shell import make_shell

if TYPE_CHECKING:
    from ..tools.decorator import DecoratedFunctionTool

_RENAME_RATIONALE = (
    "The tool routes commands through the sandbox, which runs sh or the remote login shell "
    "rather than bash specifically."
)


# The message is a string literal rather than an f-string over _RENAME_RATIONALE
# because PEP 702 checkers only honor @deprecated when the argument is a literal.
@deprecated(
    "make_bash is deprecated and will be removed in v2.0.0. Use make_shell instead. "
    "The tool routes commands through the sandbox, which runs sh or the remote login shell "
    "rather than bash specifically."
)
def make_bash(*, name: str = "bash", **kwargs: Any) -> DecoratedFunctionTool:
    """Deprecated alias for :func:`~strands.vended_tools.shell.make_shell` keeping the pre-rename default name."""
    return make_shell(name=name, **kwargs)


bash = make_shell(name="bash")
"""Deprecated pre-rename tool, kept so callers matching on the tool name ``"bash"``
keep working until removal in v2.0.0. Reach it through ``strands.vended_tools.bash``,
which emits the ``DeprecationWarning``; it is deliberately absent from ``__all__``
and the docs."""
