from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from typing import Any, Dict, List
from urllib.parse import urlparse

try:
    from mcp.server import FastMCP
except ImportError:
    FastMCP = import_module("mcp.server.mcpserver").MCPServer

from .utils import cache, text_processor

APP_NAME = "strands-agents-mcp-server"


def _is_valid_doc_url(uri: str) -> bool:
    """Validate that a URI points to strandsagents.com over HTTPS."""
    try:
        parsed = urlparse(uri)
        return parsed.scheme == "https" and parsed.hostname == "strandsagents.com"
    except Exception:
        return False


mcp = FastMCP(APP_NAME)


@mcp.tool()
def search_docs(query: str, k: int = 5) -> List[Dict[str, Any]]:
    """Search the curated documentation catalog.

    The catalog contains Strands Agents user guides, API reference pages, and
    examples. Ranking starts from document titles and also considers page
    content once a page has been fetched (hydrated), so both title-like keywords
    ("bedrock model", "MCP tools") and body terms ("guardrail", "temperature")
    work. The top results are fetched on demand to hydrate the index and provide
    content snippets.

    Call fetch_doc with a result URL to read the page or one of its sections.

    Args:
        query: Search query string (e.g., "bedrock model", "tell me about a2a", "how to use MCP tools")
        k: Maximum number of results to return (default: 5)

    Returns:
        List of dictionaries containing:
        - url: Document URL
        - title: Display title
        - score: Unbounded weighted TF-IDF score. Higher is better within this
          result set; do not interpret it as a probability or compare it across
          different queries.
        - snippet: Contextual content preview

        Returns an empty list when no document matches. If a result page
        cannot be fetched, its title is used as the snippet.

    """
    cache.ensure_ready()
    index = cache.get_index()
    results = index.search(query, k=k) if index else []
    url_cache = cache.get_url_cache()

    top = results[: min(len(results), cache.SNIPPET_HYDRATE_MAX)]
    urls_to_hydrate = list(
        dict.fromkeys(doc.uri for _, doc in top if (page := url_cache.get(doc.uri)) is None or not page.content)
    )
    if urls_to_hydrate:
        with ThreadPoolExecutor(max_workers=len(urls_to_hydrate)) as executor:
            list(executor.map(cache.ensure_page, urls_to_hydrate))

    # Build response with real content snippets when available
    return_docs: List[Dict[str, Any]] = []
    for score, doc in results:
        page = url_cache.get(doc.uri)
        snippet = text_processor.make_snippet(page, doc.display_title)
        return_docs.append(
            {
                "url": doc.uri,
                "title": doc.display_title,
                "score": round(score, 3),
                "snippet": snippet,
            }
        )
    return return_docs


@mcp.tool()
def fetch_doc(uri: str = "", section: str = "") -> Dict[str, Any]:
    """Read documentation pages with smart sectioning for token efficiency.

    Two modes of operation:

    1. **TOC mode** (omit section): Returns a table of contents with section IDs,
       titles, summaries, and the document's preamble so you can decide which part
       to read.
    2. **Section mode** (provide section): Returns the full markdown content of
       one section, identified by the ID from the TOC (e.g., "3" or "3.2").

    For small documents (under ~8KB), the full content is returned directly
    regardless of mode, since sectioning would add overhead without benefit.

    Recommended workflow:
    1. search_docs("your query") - find relevant URLs
    2. fetch_doc(uri="...") - see structure, preamble, and section summaries
    3. fetch_doc(uri="...", section="3") - read the section you need

    Args:
        uri: Document URL (must be under https://strandsagents.com/).
            If empty, returns a catalog of all available document URLs with titles.
        section: Section ID from the TOC (e.g., "3" or "3.2").
            Omit to get the table of contents.

    Returns:
        When section is omitted (TOC mode):
        - url, title: Document metadata
        - preamble: Introductory text between page title and first section
        - sections: List of sections with id, level, title, summary, children

        When section is provided:
        - url, title: Document metadata
        - section_id: Requested section ID
        - section_title: Section heading text
        - content: Full markdown content of the section

        For small documents (under ~8KB):
        - url, title: Document metadata
        - document_small: true
        - content: Full document content (returned automatically)

        On error:
        - error: Error description
        - url: Requested URL

        Errors are returned for unsupported URLs and failed page fetches. For
        sectioned documents, unknown section IDs also return an error; `section`
        is ignored when the full document is returned automatically.

    """
    cache.ensure_ready()

    if not uri:
        url_titles = cache.get_url_titles()
        return {"urls": [{"url": url, "title": title} for url, title in url_titles.items()]}

    if not _is_valid_doc_url(uri):
        return {"error": "only https://strandsagents.com URLs allowed", "url": uri}

    page = cache.ensure_page(uri)
    if page is None:
        return {"error": "fetch failed", "url": uri}

    # Small doc: return full content directly
    if len(page.content.encode("utf-8")) <= text_processor.SMALL_DOC_THRESHOLD:
        return {
            "url": uri,
            "title": page.title,
            "document_small": True,
            "reason": "size",
            "content": page.content,
        }

    sections = text_processor.parse_sections(page.content)

    # No parseable sections: treat as small doc regardless of size
    if not sections:
        return {
            "url": uri,
            "title": page.title,
            "document_small": True,
            "reason": "no_sections",
            "content": page.content,
        }

    # Section mode: extract specific section
    if section:
        result = text_processor.extract_section(page.content, section, sections)
        if result is None:
            return {"error": f"section '{section}' not found", "url": uri}
        return {
            "url": uri,
            "title": page.title,
            "section_id": result["section_id"],
            "section_title": result["section_title"],
            "content": result["content"],
        }

    # TOC mode: return section tree with preamble (strip internal fields)
    clean_sections = [{k: v for k, v in s.items() if not k.startswith("_")} for s in sections]
    return {
        "url": uri,
        "title": page.title,
        "preamble": text_processor.extract_preamble(page.content),
        "sections": clean_sections,
    }


def main() -> None:
    """Main entry point for the MCP server.

    Initializes the document cache and starts the FastMCP server.
    The cache is loaded with document titles only for fast startup,
    with full content fetched on-demand.
    """
    cache.ensure_ready()
    mcp.run()
