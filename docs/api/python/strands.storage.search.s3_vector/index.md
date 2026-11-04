Vector search for `S3Storage`, backed by Amazon S3 Vectors.

## S3VectorSearchStrategy

```python
class S3VectorSearchStrategy()
```

Defined in: [src/strands/storage/search/s3\_vector.py:20](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/search/s3_vector.py#L20)

Vector search for :class:`~strands.storage.S3Storage`, backed by Amazon S3 Vectors.

A derived index over the bucket: `S3Storage` calls :meth:`index` on every write (one embedder call plus a `PutVectors`), :meth:`remove` on every delete, and :meth:`search` on search. Only works with `S3Storage`; each storage backend pairs with its own native vector index, and only the :class:`~strands.storage.search.Embedder` is shared.

The vector bucket and index must already exist, with a dimension matching the embedder (1024 for the default, Titan Text Embeddings V2). Clients default to the storage’s session, else its region. Vectors are keyed by the full object key, so storages sharing a bucket under different prefixes can share one index. Empty and non-UTF-8 values are stored but not indexed, and clear any earlier vector for that key. Attach each instance to a single storage. Requires botocore 1.39.5 or later.

**Example**:

```python
from strands.storage import S3Storage
from strands.storage.search import S3VectorSearchStrategy

storage = S3Storage(
    "my-bucket",
    search_strategy=S3VectorSearchStrategy(vector_bucket_name="my-vectors", index_name="notes"),
)
```

#### \_\_init\_\_

```python
def __init__(*,
             vector_bucket_name: str,
             index_name: str,
             embedder: Embedder | None = None,
             max_results: int = 10,
             boto_session: Any = None,
             boto_client_config: Any = None) -> None
```

Defined in: [src/strands/storage/search/s3\_vector.py:47](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/search/s3_vector.py#L47)

Initialize the S3 Vectors search strategy.

**Arguments**:

-   `vector_bucket_name` - Name of an existing S3 Vectors bucket. Not created automatically. Do not share one index across storages on different buckets: results are filtered by prefix only.
-   `index_name` - Name of an existing vector index in that bucket. Not created automatically, and its dimension must match the embedder.
-   `embedder` - Produces the embedding vectors. Defaults to a `BedrockEmbedder` (Titan Text Embeddings V2) on the storage’s `boto_session`, or in the storage’s region when it has none, created on first use.
-   `max_results` - Maximum number of results to return. The limit applies before results are filtered to this storage’s prefix (and to a `namespace()` view’s prefix), so a search over a narrow prefix of a shared index can return fewer results.
-   `boto_session` - Pre-configured boto3 session for the S3 Vectors client. Defaults to the storage’s `boto_session`, or a session in the storage’s region when it has none.
-   `boto_client_config` - Botocore Config object for the S3 Vectors client.

#### index

```python
async def index(storage: S3Storage, key: str, data: bytes,
                **kwargs: Any) -> None
```

Defined in: [src/strands/storage/search/s3\_vector.py:82](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/search/s3_vector.py#L82)

Embed and store a vector for the given key.

Empty or non-UTF-8 values are not embedded. Any vector from a previous write to the same key is removed instead, so the index never matches content that is no longer stored.

**Arguments**:

-   `storage` - The storage the content was written to.
-   `key` - The storage key to associate the vector with.
-   `data` - The raw bytes to embed.
-   `**kwargs` - Unused; accepted for forward compatibility.

#### remove

```python
async def remove(storage: S3Storage, key: str) -> None
```

Defined in: [src/strands/storage/search/s3\_vector.py:107](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/search/s3_vector.py#L107)

Delete the vector associated with the given key. A no-op if none exists.

Called by `S3Storage` on `delete()`.

**Arguments**:

-   `storage` - The storage the content was deleted from.
-   `key` - The storage key whose vector should be removed.

#### search

```python
async def search(storage: S3Storage, query: str,
                 **kwargs: Any) -> builtins.list[StorageSearchResult]
```

Defined in: [src/strands/storage/search/s3\_vector.py:123](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/search/s3_vector.py#L123)

Query the S3 Vectors index for keys similar to the query.

**Arguments**:

-   `storage` - The storage to search over.
-   `query` - Natural-language search query.
-   `**kwargs` - Unused; accepted for forward compatibility.

**Returns**:

Matched keys under the storage’s prefix with similarity scores, ranked best-first.