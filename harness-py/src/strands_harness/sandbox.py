"""Sandbox helpers shared by the harness tools and plugins. Internal: nothing here is public API.

``_shell_of`` tells which shell dialect a sandbox runs commands in. The Sandbox contract names none, so it
asks: PowerShell prints its edition (``Desktop`` or ``Core``), ``sh`` expands the unset variable to an
empty line. Probed once per sandbox.
"""

from __future__ import annotations

import weakref
from typing import Literal

from strands.sandbox import Sandbox

_SandboxShell = Literal["sh", "powershell"]

_SHELL_PROBE = 'echo "${PSEdition}"'
_shells: weakref.WeakKeyDictionary[Sandbox, _SandboxShell] = weakref.WeakKeyDictionary()


async def _shell_of(sandbox: Sandbox) -> _SandboxShell:
    """Return ``"powershell"`` or ``"sh"`` for ``sandbox``, probing it the first time."""
    if sandbox not in _shells:
        result = await sandbox.execute(_SHELL_PROBE, timeout=30)
        # A failed probe is inconclusive: answer ``sh`` for this call but probe again next time.
        if result.exit_code != 0:
            return "sh"
        _shells[sandbox] = "powershell" if result.stdout.strip() in ("Desktop", "Core") else "sh"
    return _shells[sandbox]
