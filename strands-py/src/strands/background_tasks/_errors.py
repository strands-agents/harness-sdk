"""Internal background task exceptions."""


class BackgroundTaskNotFoundError(LookupError):
    """Raised when a background task ID is not found."""

    def __init__(self, task_id: str) -> None:
        """Initialize the error.

        Args:
            task_id: Task ID that could not be found.
        """
        super().__init__(f"Background task '{task_id}' was not found")


class BackgroundTaskTimeoutError(TimeoutError):
    """Raised when waiting for background tasks times out."""

    def __init__(self, timeout: float) -> None:
        """Initialize the error.

        Args:
            timeout: Wait timeout in seconds.
        """
        super().__init__(f"Timed out waiting for background tasks after {timeout}s")
