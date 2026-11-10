"""Search strategies documentation code examples."""


# --8<-- [start:keyword_search]
from strands.storage import LocalFileStorage
from strands.storage.search import KeywordSearchStrategy

strategy = KeywordSearchStrategy()
storage = LocalFileStorage("./my-data/")
results = await strategy.search(
    storage, "dark mode toggle"
)
# --8<-- [end:keyword_search]


# --8<-- [start:bm25_search]
from strands.storage import LocalFileStorage
from strands.storage.search import Bm25SearchStrategy

strategy = Bm25SearchStrategy()
storage = LocalFileStorage(
    "./memory/", search_strategy=strategy
)

await storage.write(
    "auth.md",
    b"OAuth2 authentication flow",
)
results = await storage.search("authentication")

await strategy.close()
# --8<-- [end:bm25_search]


# --8<-- [start:storage_with_strategy]
from strands.storage import LocalFileStorage
from strands.storage.search import Bm25SearchStrategy

storage = LocalFileStorage(
    "./memory/",
    search_strategy=Bm25SearchStrategy(),
)
# --8<-- [end:storage_with_strategy]


# --8<-- [start:custom_strategy]
from typing import Any

from strands.storage import InMemoryStorage, Storage
from strands.storage.search import StorageSearchResult


class PhraseSearchStrategy:
    """Rank entries by how often the exact query phrase appears."""

    async def index(
        self, storage: Storage, key: str, data: bytes, **kwargs: Any
    ) -> None:
        pass  # Searches on the fly, so there is nothing to index.

    async def search(
        self, storage: Storage, query: str, **kwargs: Any
    ) -> list[StorageSearchResult]:
        phrase = query.strip().lower()
        if not phrase:
            return []
        results = []
        for key in await storage.list(""):
            data = await storage.read(key)
            if data is None:
                continue
            text = data.decode("utf-8", errors="replace")
            count = text.lower().count(phrase)
            if count:
                results.append(
                    StorageSearchResult(key=key, score=count, data=data)
                )
        results.sort(key=lambda result: result.score, reverse=True)
        return results


storage = InMemoryStorage(search_strategy=PhraseSearchStrategy())
# --8<-- [end:custom_strategy]
