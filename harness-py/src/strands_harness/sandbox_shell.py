"""Which shell dialect a sandbox runs commands in.

The Sandbox contract names none, so the only check that holds for every sandbox is to ask: PowerShell
prints its edition (``Desktop`` or ``Core``), ``sh`` expands the unset variable to an empty line. Probed
once per sandbox.
"""

from __future__ import annotations

import weakref
from typing import Literal

from strands.sandbox import Sandbox

SandboxShell = Literal["sh", "powershell"]

SHELL_PROBE = 'echo "${PSEdition}"'
_shells: weakref.WeakKeyDictionary[Sandbox, SandboxShell] = weakref.WeakKeyDictionary()


async def shell_of(sandbox: Sandbox) -> SandboxShell:
    """Return ``"powershell"`` or ``"sh"`` for ``sandbox``, probing it the first time."""
    if sandbox not in _shells:
        result = await sandbox.execute(SHELL_PROBE, timeout=10)
        # A failed probe is inconclusive: answer ``sh`` for this call but probe again next time.
        if result.exit_code != 0:
            return "sh"
        _shells[sandbox] = "powershell" if result.stdout.strip() in ("Desktop", "Core") else "sh"
    return _shells[sandbox]
