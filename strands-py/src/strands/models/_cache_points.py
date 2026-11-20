"""Cache point placement rules shared by the providers that place their own cache points.

Each provider decides when to cache and translates the points to its wire format; the rules for where a point may
go, how many a request carries and which TTL it gets live here so they stay the same across providers.
"""

from collections.abc import Callable, Mapping, Sequence
from typing import Any, TypeVar

from ..types.content import CachePoint, ContentBlock, Message, Messages, SystemContentBlock
from ._model_proxy import _latest_user_index

# Anthropic, Bedrock (Converse) and Vertex AI reject a request with more cache points than this.
MAX_CACHE_POINTS = 4

_BlockT = TypeVar("_BlockT", ContentBlock, SystemContentBlock)


def section_ttl(section: bool | str | None, ttl: str | None) -> str | None:
    """The TTL for a cache section: its own TTL string, else the config-wide ``ttl``."""
    return section if isinstance(section, str) else ttl


def cache_point(ttl: str | None) -> CachePoint:
    """A default cache point, carrying ``ttl`` when one is given."""
    return CachePoint(type="default", ttl=ttl) if ttl else CachePoint(type="default")


def with_point_ttls(blocks: list[_BlockT] | None, ttl: str | None) -> list[_BlockT] | None:
    """The blocks with each cache point that carries no TTL given ``ttl``; a TTL the caller wrote is kept.

    Filling in one TTL keeps every point on one lifetime, since the providers reject a longer TTL after a shorter one.
    """
    if not ttl or blocks is None or not any(_lacks_ttl(block) for block in blocks):
        return blocks
    return [_with_ttl(block, ttl) if _lacks_ttl(block) else block for block in blocks]


def step_back_over_documents(content: Sequence[Mapping[str, Any]], index: int) -> int:
    """Step a cache point index back over the adjacent run of non-PDF documents directly ahead of it.

    Claude on Bedrock only rejects a cache point *directly* preceded by a non-PDF document; moving further would
    evict durable content - usually the document itself, the expensive part - from the cached prefix for no reason.
    """
    while index > 0 and "document" in content[index - 1] and content[index - 1]["document"].get("format", "") != "pdf":
        index -= 1
    return index


def system_with_cache_point(
    system_prompt: str | None, system_prompt_content: list[SystemContentBlock] | None, point: CachePoint
) -> list[SystemContentBlock] | None:
    """The system prompt content ending in ``point``, unless it is empty or already has a cache point."""
    content = system_prompt_content if system_prompt_content is not None else []
    if system_prompt_content is None and system_prompt:
        content = [SystemContentBlock(text=system_prompt)]
    if not content or any("cachePoint" in block for block in content):
        return system_prompt_content
    return [*content, SystemContentBlock(cachePoint=point)]


def messages_with_cache_point(
    messages: Messages,
    dynamic_trailing_blocks: int,
    point: CachePoint,
    boundary_rule: Callable[[list[ContentBlock], int], int] | None = None,
) -> Messages:
    """The messages with ``point`` in the latest user message ahead of its rebuilt trailing blocks.

    ``boundary_rule`` moves the point earlier where the backend rejects it. The latest user message is unchanged
    when it already has a cache point or the point would come first, and the input is never changed.
    """
    latest_user = _latest_user_index(messages)
    if latest_user == -1:
        return messages
    content = messages[latest_user]["content"]
    boundary = len(content) - dynamic_trailing_blocks
    if boundary_rule is not None:
        boundary = boundary_rule(content, boundary)
    if boundary <= 0 or any("cachePoint" in block for block in content):
        return messages
    marked: Message = {
        **messages[latest_user],
        "content": [*content[:boundary], ContentBlock(cachePoint=point), *content[boundary:]],
    }
    return [*messages[:latest_user], marked, *messages[latest_user + 1 :]]


def _lacks_ttl(block: Mapping[str, Any]) -> bool:
    return "cachePoint" in block and not block["cachePoint"].get("ttl")


def _with_ttl(block: _BlockT, ttl: str) -> _BlockT:
    return {**block, "cachePoint": {**block["cachePoint"], "ttl": ttl}}
