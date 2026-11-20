"""Shared types and constants for the web fetch tool."""

WEB_FETCH_DESCRIPTION_MARKDOWN = (
    "Fetches an HTTP(S) URL and returns its content as clean markdown. "
    "HTML pages are converted to markdown with scripts, styles, and noise stripped; "
    "other content types are returned as-is."
)
"""Description for the markdown web fetch tool."""

WEB_FETCH_DESCRIPTION_AGENTIC = (
    "Fetches an HTTP(S) URL. With a prompt, an analyst reads the page and returns only its answer, "
    "keeping the page out of your context. Without one, returns the page as markdown."
)
"""Description for the agentic web fetch tool."""
