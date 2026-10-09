"""A sandbox that knows where it runs can say so via a duck-typed ``environment`` attribute
(``platform``/``cwd``/``shell``), as the CLI's workspace sandbox does. Consumers prefer it over probing
with shell commands, which have no meaning on a host without a POSIX shell."""

from __future__ import annotations

import re
from typing import Any

_POWERSHELL = re.compile(r"^(powershell|pwsh)", re.IGNORECASE)


def described_environment(sandbox: Any) -> dict[str, str | None]:
    """Return ``platform``/``cwd``/``shell`` from ``sandbox.environment``; missing or malformed values are ``None``.

    ``platform`` is human-readable as ``uname -s`` prints it (``Linux``, ``Darwin``, ``Windows``); ``cwd`` is
    absolute in the sandbox's own path syntax; ``shell`` is what ``execute()`` runs commands in: ``sh``, or
    ``PowerShell``/``pwsh`` (matched case-insensitively).
    """
    described = getattr(sandbox, "environment", None)

    def pick(key: str) -> str | None:
        value = described.get(key) if isinstance(described, dict) else getattr(described, key, None)
        return value if isinstance(value, str) and value else None

    return {"platform": pick("platform"), "cwd": pick("cwd"), "shell": pick("shell")}


def is_powershell(shell: str | None) -> bool:
    return shell is not None and _POWERSHELL.match(shell) is not None
