from dataclasses import dataclass, field


@dataclass
class Config:
    """Configuration settings for the MCP server.

    Attributes:
        llm_texts_url: List of llms.txt URLs to index for documentation
        integrations_feed_url: URL of the integrations catalog JSON feed
        integrations_feed_ttl: Seconds to reuse a fetched integrations feed before refetching
        timeout: HTTP request timeout in seconds
        user_agent: User agent string for HTTP requests
    """

    llm_texts_url: list[str] = field(
        default_factory=lambda: ["https://strandsagents.com/llms.txt"]
    )  # Curated list of llms.txt files to index at startup
    integrations_feed_url: str = "https://strandsagents.com/integrations.json"
    integrations_feed_ttl: float = 600.0
    timeout: float = 30.0  # HTTP request timeout in seconds
    user_agent: str = "strands-mcp-docs/1.0"  # User agent for HTTP requests


# Global configuration instance
doc_config = Config()
