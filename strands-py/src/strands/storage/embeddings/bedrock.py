"""Amazon Bedrock embedder for vector search strategies."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import boto3
from botocore.config import Config as BotocoreConfig

from ...types.exceptions import StorageError
from .embedder import Embedder

DEFAULT_EMBEDDER_MODEL_ID = "amazon.titan-embed-text-v2:0"


class BedrockEmbedder(Embedder):
    """An :class:`Embedder` backed by Amazon Titan Text Embeddings on Amazon Bedrock.

    Sends ``{"inputText": text}`` via ``InvokeModel`` and returns the ``embedding`` field of the
    response.

    Example:
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
    """

    def __init__(
        self,
        *,
        model_id: str = DEFAULT_EMBEDDER_MODEL_ID,
        region_name: str | None = None,
        boto_session: boto3.Session | None = None,
        boto_client_config: BotocoreConfig | None = None,
    ) -> None:
        """Initialize the embedder.

        Args:
            model_id: Bedrock model ID or ARN of an Amazon Titan Text Embeddings model. Other model
                families use a different request and response shape and are not supported yet;
                subclass :class:`Embedder` for those.
            region_name: AWS region override for the Bedrock Runtime client.
            boto_session: Pre-configured boto3 session. Cannot be combined with ``region_name``.
            boto_client_config: Botocore Config object for the Bedrock Runtime client.

        Raises:
            StorageError: If both ``region_name`` and ``boto_session`` are provided.
        """
        if region_name is not None and boto_session is not None:
            raise StorageError("Cannot specify both region_name and boto_session")

        config = boto_client_config
        if config is None:
            config = BotocoreConfig(user_agent_extra="strands-agents")
        elif not getattr(config, "user_agent_extra", None):
            config = config.merge(BotocoreConfig(user_agent_extra="strands-agents"))

        session = boto_session or boto3.Session(region_name=region_name)
        self._model_id = model_id
        self._client: Any = session.client("bedrock-runtime", config=config)

    async def embed(self, text: str) -> list[float]:
        """Embed ``text`` with the configured Titan model.

        Args:
            text: The text to embed.

        Returns:
            The embedding vector.

        Raises:
            StorageError: If the model response has no ``embedding`` list.
        """
        response = await asyncio.to_thread(
            self._client.invoke_model,
            modelId=self._model_id,
            contentType="application/json",
            accept="application/json",
            body=json.dumps({"inputText": text}),
        )
        body = await asyncio.to_thread(response["body"].read)
        embedding = json.loads(body).get("embedding")
        if not isinstance(embedding, list):
            raise StorageError(f"Model '{self._model_id}' did not return a Titan-shaped {{embedding: [...]}} response")
        return embedding
