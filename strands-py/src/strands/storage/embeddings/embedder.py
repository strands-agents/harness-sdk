"""Provider-agnostic embedder interface for vector search strategies."""

from abc import ABC, abstractmethod


class Embedder(ABC):
    """Produces embedding vectors from text for vector search strategies.

    Provider-agnostic: subclass it to plug in any model, or use a vended implementation such as
    ``BedrockEmbedder``.
    """

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        """Embed one text.

        The vector length must match the dimension of the index it is stored in.

        Args:
            text: The text to embed.

        Returns:
            The embedding vector.
        """
        ...
