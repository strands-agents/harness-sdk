Provider-agnostic embedder interface for vector search strategies.

## Embedder

```python
class Embedder(ABC)
```

Defined in: [src/strands/storage/embeddings/embedder.py:6](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/embeddings/embedder.py#L6)

Produces embedding vectors from text for vector search strategies.

Provider-agnostic: subclass it to plug in any model, or use a vended implementation such as `BedrockEmbedder`.

#### embed

```python
@abstractmethod
async def embed(text: str) -> list[float]
```

Defined in: [src/strands/storage/embeddings/embedder.py:14](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/storage/embeddings/embedder.py#L14)

Embed one text.

The vector length must match the dimension of the index it is stored in.

**Arguments**:

-   `text` - The text to embed.

**Returns**:

The embedding vector.