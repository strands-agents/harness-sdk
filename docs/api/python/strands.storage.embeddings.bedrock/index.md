Amazon Bedrock embedder for vector search strategies.

## BedrockEmbedder

```python
class BedrockEmbedder(Embedder)
```

Defined in: [src/strands/storage/embeddings/bedrock.py:18](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/embeddings/bedrock.py#L18)

An :class:`Embedder` backed by Amazon Titan Text Embeddings on Amazon Bedrock.

Sends `\{"inputText": text}` via `InvokeModel` and returns the `embedding` field of the response.

**Example**:

```python
from strands.storage import S3Storage
from strands.storage.embeddings.bedrock import BedrockEmbedder
from strands.storage.search import S3VectorSearchStrategy

storage = S3Storage(
    "my-bucket",
    search_strategy=S3VectorSearchStrategy(
        vector_bucket_name="my-vectors",
        index_name="notes",
        embedder=BedrockEmbedder(model_id="amazon.titan-embed-text-v2:0", region_name="us-west-2"),
    ),
)
```

#### \_\_init\_\_

```python
def __init__(*,
             model_id: str = DEFAULT_EMBEDDER_MODEL_ID,
             region_name: str | None = None,
             boto_session: boto3.Session | None = None,
             boto_client_config: BotocoreConfig | None = None) -> None
```

Defined in: [src/strands/storage/embeddings/bedrock.py:41](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/embeddings/bedrock.py#L41)

Initialize the embedder.

**Arguments**:

-   `model_id` - Bedrock model ID or ARN of an Amazon Titan Text Embeddings model. Other model families use a different request and response shape and are not supported yet; subclass :class:`Embedder` for those.
-   `region_name` - AWS region override for the Bedrock Runtime client.
-   `boto_session` - Pre-configured boto3 session. Cannot be combined with `region_name`.
-   `boto_client_config` - Botocore Config object for the Bedrock Runtime client.

**Raises**:

-   `StorageError` - If both `region_name` and `boto_session` are provided.

#### embed

```python
async def embed(text: str) -> list[float]
```

Defined in: [src/strands/storage/embeddings/bedrock.py:75](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/embeddings/bedrock.py#L75)

Embed `text` with the configured Titan model.

**Arguments**:

-   `text` - The text to embed.

**Returns**:

The embedding vector.

**Raises**:

-   `StorageError` - If the model response has no `embedding` list.