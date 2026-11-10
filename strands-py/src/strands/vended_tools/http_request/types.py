"""Shared types and constants for the http_request tool."""

from typing import Literal, TypedDict

HttpMethod = Literal["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
"""HTTP methods supported by the tool."""


class HttpRequestOutput(TypedDict):
    """Output of an HTTP request.

    Attributes:
        status: HTTP status code.
        status_text: HTTP status reason phrase.
        headers: Response headers as a plain dict (lower-cased keys).
        body: Response body as text.
    """

    status: int
    status_text: str
    headers: dict[str, str]
    body: str


DEFAULT_HTTP_REQUEST_DESCRIPTION = (
    "Makes HTTP requests to external APIs. Supports GET, POST, PUT, DELETE, PATCH, HEAD, "
    "and OPTIONS methods. Returns response with status, headers, and body."
)
"""Description for the http_request tool shown to the model."""
