"""Shared types and constants for the web fetch tool."""

WEB_FETCH_DESCRIPTION_MARKDOWN = (
    "Fetches an HTTP(S) URL and returns its content as clean markdown. "
    "HTML pages are converted to markdown with scripts, styles, and noise stripped; "
    "other content types are returned as-is."
)
"""Description for the markdown web fetch tool."""

WEB_FETCH_DESCRIPTION_AGENTIC = (
    "Fetches an HTTP(S) URL and answers a prompt about its content. "
    "The analyst processes the page directly so the full content never enters "
    "the main agent's context. "
    "Leave the prompt empty to get the page content itself instead of an answer."
)
"""Description for the agentic web fetch tool."""
