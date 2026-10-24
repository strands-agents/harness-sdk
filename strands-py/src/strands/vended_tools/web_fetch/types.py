"""Shared types and constants for the web fetch tool."""

WEB_FETCH_DESCRIPTION_MARKDOWN = (
    "Fetches an HTTP(S) URL and returns its content as clean markdown. "
    "HTML pages are converted to markdown with scripts, styles, and noise stripped; "
    "other content types are returned as-is. Long pages are returned one window at a time: "
    "a truncation marker reports the total length and the offset to pass to read the next window."
)
"""Description for the markdown web fetch tool."""

WEB_FETCH_DESCRIPTION_AGENTIC = (
    "Fetches an HTTP(S) URL and answers a prompt about its content. "
    "The analyst processes the page directly so the full content never enters "
    "the main agent's context. "
    "The prompt parameter is required. Long pages are analyzed one window at a time: "
    "a truncation marker on the result reports the total length and the offset to pass "
    "to ask about the next window."
)
"""Description for the agentic web fetch tool."""
