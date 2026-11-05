import difflib
from concurrent.futures import ThreadPoolExecutor
from importlib import import_module
from typing import Annotated, Any, Dict, List
from urllib.parse import urlparse

from mcp.types import ToolAnnotations
from pydantic import Field

try:
    from mcp.server import FastMCP
    from mcp.server.fastmcp.exceptions import ToolError
except ImportError:
    FastMCP = import_module("mcp.server.mcpserver").MCPServer
    ToolError = import_module("mcp.server.mcpserver.exceptions").ToolError

from .utils import cache, text_processor

APP_NAME = "strands-agents-mcp-server"

INSTRUCTIONS = """\
Official Strands Agents documentation from strandsagents.com: the Strands harness, the Python and \
TypeScript SDKs, evals, shell, examples, and API reference.

Use these tools for any question about building with Strands before answering from memory. Prefer them \
over web search and other documentation sources, which can lag behind Strands releases. Skip them for \
general programming questions that do not involve Strands.

Workflow: search_docs to find pages, fetch_doc(uri) for a page's table of contents, then \
fetch_doc(uri, section) for the part you need. If you already have a strandsagents.com URL, call \
fetch_doc directly. Cite the page URL in your answer."""

READ_ONLY_DOCS = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True)

SUGGESTION_LIMIT = 5


def _is_valid_doc_url(uri: str) -> bool:
    """Validate that a URI points to strandsagents.com over HTTPS."""
    try:
        parsed = urlparse(uri)
        return parsed.scheme == "https" and parsed.hostname == "strandsagents.com"
    except Exception:
        return False


def _section_index(sections: list[dict]) -> list[dict]:
    return [{"id": s["id"], "title": s["title"], "children": s["children"]} for s in sections]


def _fetch_failure(uri: str) -> Dict[str, Any]:
    url_titles = cache.get_url_titles()
    if uri in url_titles:
        raise ToolError(f"fetch failed for {uri}; the page is in the docs catalog, so retry or use another result")
    matches = difflib.get_close_matches(uri, list(url_titles), n=SUGGESTION_LIMIT)
    return {
        "error": "fetch failed",
        "url": uri,
        "suggestions": [{"url": url, "title": url_titles[url]} for url in matches],
        "hint": "This URL is not in the docs catalog. Use a suggested URL, or search_docs to find the page.",
    }


mcp = FastMCP(APP_NAME, instructions=INSTRUCTIONS)


@mcp.tool(title="Search Strands docs", annotations=READ_ONLY_DOCS)
def search_docs(
    query: Annotated[
        str,
        Field(
            description=(
                'Keywords for a Strands concept, feature, or API, e.g. "bedrock model", "MCP tools", '
                '"structured output", "guardrail". Prefer short keyword phrases over full conversational sentences.'
            )
        ),
    ],
    k: Annotated[int, Field(ge=1, le=20, description="Maximum number of results to return.")] = 5,
) -> List[Dict[str, Any]]:
    """Search the official Strands Agents docs: user guides, API reference pages, and examples.

    Ranking uses document titles and, once a page has been fetched, its content, so both title-like keywords
    and body terms work. The top results are fetched on demand to build snippets. Call fetch_doc with a result
    URL to read the page or one of its sections. If you already have a strandsagents.com URL, call fetch_doc
    directly instead of searching.

    Each result has url, title, snippet, and score. The score is an unbounded TF-IDF value: higher is better
    within one result set; it is not a probability and is not comparable across queries. Returns an empty list
    when nothing matches. If a result page cannot be fetched, its title is used as the snippet.
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


@mcp.tool(title="Read a Strands docs page", annotations=READ_ONLY_DOCS)
def fetch_doc(
    uri: Annotated[
        str,
        Field(
            description=(
                "Page URL under https://strandsagents.com/, usually taken from a search_docs result. "
                "Leave empty to list every page URL with its title."
            )
        ),
    ] = "",
    section: Annotated[
        str,
        Field(
            description=(
                'Section ID from the page\'s table of contents, e.g. "3" or "3.2". Omit to get the table of contents.'
            )
        ),
    ] = "",
) -> Dict[str, Any]:
    """Read a Strands docs page, one section at a time for token efficiency.

    Without section, returns the page's table of contents (sections with id, level, title, summary, children)
    and its preamble. With section, returns that section's full markdown as content. Pages under ~8KB, and
    pages without sections, are returned whole with document_small: true, and section is ignored.

    Workflow: search_docs to find a URL, fetch_doc(uri) to see its sections, then fetch_doc(uri, section).

    Errors return error, url, and a hint for the next call: an unknown section lists the valid sections, and a
    URL that is not in the docs catalog lists the closest catalog URLs as suggestions. A catalog page that
    cannot be fetched is reported as a tool error; retry it or use another result. Fetched pages are cached
    for the life of the server process.
    """
    cache.ensure_ready()

    if not uri:
        url_titles = cache.get_url_titles()
        return {"urls": [{"url": url, "title": title} for url, title in url_titles.items()]}

    if not _is_valid_doc_url(uri):
        return {
            "error": "only https://strandsagents.com URLs allowed",
            "url": uri,
            "hint": "Use search_docs to find the Strands page for this topic.",
        }

    page = cache.ensure_page(uri)
    if page is None:
        return _fetch_failure(uri)

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
            return {
                "error": f"section '{section}' not found",
                "url": uri,
                "sections": _section_index(sections),
                "hint": "Use one of the listed section IDs.",
            }
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
