"""Search strategies documentation code examples."""

from strands.storage import LocalFileStorage


# --8<-- [start:keyword_search]
from strands.storage.search import KeywordSearchStrategy

strategy = KeywordSearchStrategy()
storage = LocalFileStorage("./my-data/")
results = await strategy.search(
    storage, "dark mode toggle"
)
# --8<-- [end:keyword_search]


# --8<-- [start:bm25_search]
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
from strands.storage.search import Bm25SearchStrategy

storage = LocalFileStorage(
    "./memory/",
    search_strategy=Bm25SearchStrategy(),
)
# --8<-- [end:storage_with_strategy]
