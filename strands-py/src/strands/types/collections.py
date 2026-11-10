"""Generic collection types for the Strands SDK."""

from typing import Generic, TypeVar

T = TypeVar("T")


class PaginatedList(list, Generic[T]):
    """A generic list-like object that includes a pagination token.

    This maintains backwards compatibility by inheriting from list,
    so existing code that expects List[T] will continue to work.
    """

    def __init__(self, data: list[T], token: str | None = None):
        """Initialize a PaginatedList with data and an optional pagination token.

        Args:
            data: The list of items to store.
            token: Optional pagination token for retrieving additional items.
        """
        super().__init__(data)
        self.pagination_token = token
