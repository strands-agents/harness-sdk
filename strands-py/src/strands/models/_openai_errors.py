"""Shared error classification for OpenAI model providers."""

import re
from typing import Literal

OpenAIErrorKind = Literal["context_overflow", "throttling"]

# Union of overflow phrases observed across OpenAI-compatible providers. Keep these lowercased so
# classification only normalizes each provider message once.
_CONTEXT_WINDOW_OVERFLOW_PATTERNS = (
    "maximum context length",
    "context_length_exceeded",
    "too many tokens",
    "context length",
    "input is too long for requested model",
    "input length and `max_tokens` exceed context limit",
    "too many total text bytes",
    "exceeds the max_model_len",
)
# Providers phrase the token-budget overflow around "model maximum" differently: OpenAI says
# "exceed customer model maximum", Bedrock Mantle drops the qualifier ("exceed model maximum").
_CONTEXT_WINDOW_OVERFLOW_REGEX = re.compile(r"exceed(?:s|ed)?(?: customer)? model maximum")
_RATE_LIMIT_PATTERNS = ("rate_limit_exceeded", "rate limit", "too many requests")


def classify_openai_error(error: BaseException) -> OpenAIErrorKind | None:
    """Classify an error from an OpenAI or OpenAI-compatible provider."""
    message = str(error).lower()
    raw_code = getattr(error, "code", None)
    code = raw_code.lower() if isinstance(raw_code, str) else ""

    if (
        getattr(error, "status_code", None) == 429
        or code == "rate_limit_exceeded"
        or any(pattern in message for pattern in _RATE_LIMIT_PATTERNS)
    ):
        return "throttling"

    if (
        code == "context_length_exceeded"
        or any(pattern in message for pattern in _CONTEXT_WINDOW_OVERFLOW_PATTERNS)
        or _CONTEXT_WINDOW_OVERFLOW_REGEX.search(message)
    ):
        return "context_overflow"

    return None
