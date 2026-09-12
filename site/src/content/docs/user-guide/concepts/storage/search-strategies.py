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
