import json
import shlex
import time
from typing import Any, Dict, List, Literal
from urllib.parse import urlparse

from ..config import doc_config
from . import doc_fetcher

IntegrationType = Literal[
    "model-provider",
    "tool",
    "session-manager",
    "memory-store",
    "storage",
    "integration",
    "plugin",
    "observability",
    "agent-extension",
    "intervention",
]
Language = Literal["python", "typescript"]
Maintainer = Literal["strands", "aws", "partner", "community"]
Sdk = Literal["agents", "evals"]

SUPPORTED_SCHEMA_VERSION = 1

_INSTALL_COMMANDS = {"python": "pip install", "typescript": "npm install"}

_cached: tuple[float, List[Dict[str, Any]]] | None = None


class FeedUnavailableError(Exception):
    """The integrations feed could not be fetched or is not in a supported format."""


def _fetch_feed() -> List[Dict[str, Any]]:
    url = doc_config.integrations_feed_url
    try:
        feed = json.loads(doc_fetcher.fetch_text(url))
    except (OSError, ValueError) as e:
        raise FeedUnavailableError(
            f"could not load the integrations catalog from {url} ({e}); retry later, "
            "or use search_docs to find integration guides"
        ) from e
    version = feed.get("schemaVersion") if isinstance(feed, dict) else None
    if version is not None and version != SUPPORTED_SCHEMA_VERSION:
        raise FeedUnavailableError(
            f"the integrations catalog at {url} uses schemaVersion {version!r}, "
            f"this server supports {SUPPORTED_SCHEMA_VERSION}; upgrade strands-agents-mcp-server"
        )
    if version is None or not isinstance(feed.get("integrations"), list):
        raise FeedUnavailableError(
            f"the integrations catalog at {url} is not in the expected format; retry later, "
            "or use search_docs to find integration guides"
        )
    return feed["integrations"]


def get_integrations() -> List[Dict[str, Any]]:
    """Return the catalog entries, refetching the feed once the cached copy is older than the TTL.

    A failed refetch keeps serving the cached copy for another TTL.

    Raises:
        FeedUnavailableError: If the feed cannot be loaded and no earlier copy is cached.
    """
    global _cached
    if _cached is None or time.monotonic() - _cached[0] >= doc_config.integrations_feed_ttl:
        try:
            _cached = (time.monotonic(), _fetch_feed())
        except FeedUnavailableError:
            if _cached is None:
                raise
            _cached = (time.monotonic(), _cached[1])
    return _cached[1]


def _matches(
    entry: Dict[str, Any],
    terms: List[str],
    integration_type: str | None,
    language: str | None,
    maintained_by: str | None,
    sdk: str | None,
) -> bool:
    text = f"{entry['name']} {entry['description']}".lower()
    return (
        (integration_type is None or entry["integrationType"] == integration_type)
        and (language is None or language in entry["languages"])
        and (maintained_by is None or entry["maintainedBy"] == maintained_by)
        and (sdk is None or entry["sdk"] == sdk)
        and all(term in text for term in terms)
    )


def _docs_url(entry: Dict[str, Any]) -> str | None:
    url = entry.get("docsUrl")
    # On-site pages have a markdown twin that fetch_doc reads directly.
    if url and urlparse(url).hostname == "strandsagents.com" and url.endswith("/"):
        return f"{url}index.md"
    return url


def _to_result(entry: Dict[str, Any]) -> Dict[str, Any]:
    packages = [
        {"language": language, "package": block["package"], "install": f"{command} {shlex.quote(block['package'])}"}
        for language, command in _INSTALL_COMMANDS.items()
        if (block := entry["languages"].get(language)) and block.get("package")
    ]
    return {
        "name": entry["name"],
        "description": entry["description"],
        "type": entry["integrationType"],
        "sdk": entry["sdk"],
        "maintained_by": entry["maintainedBy"],
        "languages": list(entry["languages"]),
        "packages": packages,
        "docs_url": _docs_url(entry),
        "github": entry["github"],
    }


def find(
    query: str = "",
    integration_type: str | None = None,
    language: str | None = None,
    maintained_by: str | None = None,
    sdk: str | None = None,
    limit: int = 10,
) -> Dict[str, Any]:
    """Filter catalog entries; entries whose name contains every query term rank first.

    Returns the number of matches as total and the first limit of them as results.

    Raises:
        FeedUnavailableError: If the feed cannot be loaded and no earlier copy is cached.
    """
    terms = query.lower().split()
    matches = [e for e in get_integrations() if _matches(e, terms, integration_type, language, maintained_by, sdk)]
    matches.sort(key=lambda e: not all(term in e["name"].lower() for term in terms))
    return {"total": len(matches), "results": [_to_result(e) for e in matches[:limit]]}
