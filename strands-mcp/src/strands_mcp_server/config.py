from dataclasses import dataclass, field


@dataclass
class Config:
    """Configuration settings for the MCP server.

    Attributes:
        llm_texts_url: List of llms.txt URLs to index for documentation
        title_only_urls: Catalog pages that concatenate other catalog pages, indexed without their body
        timeout: HTTP request timeout in seconds
        user_agent: User agent string for HTTP requests
    """

    llm_texts_url: list[str] = field(
        default_factory=lambda: ["https://strandsagents.com/llms.txt"]
    )  # Curated list of llms.txt files to index at startup
    title_only_urls: frozenset[str] = frozenset({"https://strandsagents.com/changelog/index.md"})
    timeout: float = 30.0  # HTTP request timeout in seconds
    user_agent: str = "strands-mcp-docs/1.0"  # User agent for HTTP requests


# Global configuration instance
doc_config = Config()
