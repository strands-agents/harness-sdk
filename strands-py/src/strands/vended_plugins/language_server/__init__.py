"""Language server context relevance for Strands Agents.

This module provides ``LspStrategy``, a ``ContextManager`` strategy that offloads old tool results about code the agent
is no longer working on, judged by a language server rather than by size or age. It adds no tools.

Example Usage:
    ```python
    from strands import Agent
    from strands.experimental.context_manager import ContextManager
    from strands.storage import LocalFileStorage
    from strands.vended_plugins.language_server import LspStrategy, StdioLspClient

    client = StdioLspClient(["pyright-langserver", "--stdio"], root="/work/repo")
    agent = Agent(
        context_manager=ContextManager(
            strategies=[LspStrategy(client, root="/work/repo"), "large_tool_offloading", "proactive_summarization"],
            stash={"storage": LocalFileStorage("./.stash")},
        ),
    )
    ```
"""

from .client import LanguageServerError, LanguageServerNotFoundError, LspClient, Position, StdioLspClient
from .code_offload import CodeSkeletonStrategy
from .enrich import CodeFetchEnricher
from .search import WorkspaceSearch, workspace_retrieval_tool
from .skeleton import SkeletonStrategy
from .strategy import LspPassReport, LspStrategy

__all__ = [
    "CodeFetchEnricher",
    "CodeSkeletonStrategy",
    "LanguageServerError",
    "LanguageServerNotFoundError",
    "LspClient",
    "LspPassReport",
    "LspStrategy",
    "Position",
    "SkeletonStrategy",
    "StdioLspClient",
    "WorkspaceSearch",
    "workspace_retrieval_tool",
]
