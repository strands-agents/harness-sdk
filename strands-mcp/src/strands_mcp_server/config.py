import logging
import os
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

ENV_LLMS_TXT = "STRANDS_MCP_LLMS_TXT"  # comma-separated llms.txt URLs
ENV_TIMEOUT = "STRANDS_MCP_TIMEOUT"  # HTTP timeout in seconds
ENV_USER_AGENT = "STRANDS_MCP_USER_AGENT"  # User-Agent header

DEFAULT_LLMS_TXT_URLS = ["https://strandsagents.com/llms.txt"]
DEFAULT_TIMEOUT = 30.0
DEFAULT_USER_AGENT = "strands-mcp-docs/1.0"


def _env_llms_txt_urls() -> list[str]:
    """Read the llms.txt source list from the environment.

    Returns:
        URLs from ENV_LLMS_TXT split on commas, or the default list when the
        variable is unset, empty, or contains only separators.
    """
    raw = os.environ.get(ENV_LLMS_TXT, "").strip()
    if not raw:
        return list(DEFAULT_LLMS_TXT_URLS)
    urls = [url.strip() for url in raw.split(",") if url.strip()]
    if not urls:
        logger.warning("%s contained no usable URLs; using defaults", ENV_LLMS_TXT)
        return list(DEFAULT_LLMS_TXT_URLS)
    return urls


def _env_timeout() -> float:
    """Read the HTTP timeout from the environment.

    An unparseable or non-positive value falls back to the default rather than
    raising, so a typo cannot stop the server from starting.

    Returns:
        Timeout in seconds.
    """
    raw = os.environ.get(ENV_TIMEOUT, "").strip()
    if not raw:
        return DEFAULT_TIMEOUT
    try:
        timeout = float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number; using %s", ENV_TIMEOUT, raw, DEFAULT_TIMEOUT)
        return DEFAULT_TIMEOUT
    if timeout <= 0:
        logger.warning("%s=%r must be positive; using %s", ENV_TIMEOUT, raw, DEFAULT_TIMEOUT)
        return DEFAULT_TIMEOUT
    return timeout


def _env_user_agent() -> str:
    """Read the User-Agent header from the environment.

    Returns:
        ENV_USER_AGENT if set and non-empty, otherwise the default.
    """
    return os.environ.get(ENV_USER_AGENT, "").strip() or DEFAULT_USER_AGENT


@dataclass
class Config:
    """Configuration settings for the MCP server.

    Values are read from the environment when the instance is constructed, so
    the module-level ``doc_config`` reflects the environment at import time.

    Attributes:
        llm_texts_url: List of llms.txt URLs to index for documentation
        timeout: HTTP request timeout in seconds
        user_agent: User agent string for HTTP requests
    """

    llm_texts_url: list[str] = field(default_factory=_env_llms_txt_urls)
    timeout: float = field(default_factory=_env_timeout)
    user_agent: str = field(default_factory=_env_user_agent)


# Global configuration instance
doc_config = Config()
