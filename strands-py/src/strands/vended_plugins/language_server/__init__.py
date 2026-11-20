"""Language server clients for Strands Agents.

This module provides ``LspClient``, the language server queries a context strategy makes, and ``StdioLspClient``,
which runs any stdio language server and implements them.

Example Usage:
    ```python
    from strands.vended_plugins.language_server import StdioLspClient

    with StdioLspClient(["pyright-langserver", "--stdio"], root="/work/repo") as client:
        symbols = await client.document_symbols("file:///work/repo/app.py")
    ```
"""

from .client import LanguageServerError, LanguageServerNotFoundError, LspClient, Position, StdioLspClient

__all__ = [
    "LanguageServerError",
    "LanguageServerNotFoundError",
    "LspClient",
    "Position",
    "StdioLspClient",
]
