"""Exception-related type definitions for the SDK."""

from typing import Any


class EventLoopException(Exception):
    """Exception raised by the event loop."""

    def __init__(self, original_exception: Exception, request_state: Any = None) -> None:
        """Initialize exception.

        Args:
            original_exception: The original exception that was raised.
            request_state: The state of the request at the time of the exception.
        """
        self.original_exception = original_exception
        self.request_state = request_state if request_state is not None else {}
        super().__init__(str(original_exception))


class MaxTokensReachedException(Exception):
    """Exception raised when the model reaches its maximum token generation limit.

    This exception is raised when the model stops generating tokens because it has reached the maximum number of
    tokens allowed for output generation. The partial message is automatically added to agent.messages and you can
    continue the conversation by calling the agent again.

    This can occur when the model's max_tokens parameter is set too low for the complexity of the response, or when
    the model naturally reaches its configured output limit during generation.
    """

    def __init__(self, message: str):
        """Initialize the exception with an error message.

        Args:
            message: The error message describing the token limit issue
        """
        super().__init__(message)


class ContextWindowOverflowException(Exception):
    """Exception raised when the context window is exceeded.

    This exception is raised when the input to a model exceeds the maximum context window size that the model can
    handle. This typically occurs when the combined length of the conversation history, system prompt, and current
    message is too large for the model to process.
    """

    pass


class MCPClientInitializationError(Exception):
    """Raised when the MCP server fails to initialize properly."""

    pass


class ModelThrottledException(Exception):
    """Exception raised when the model is throttled.

    This exception is raised when the model is throttled by the service. This typically occurs when the service is
    throttling the requests from the client.
    """

    def __init__(self, message: str) -> None:
        """Initialize exception.

        Args:
            message: The message from the service that describes the throttling.
        """
        self.message = message
        super().__init__(message)

    pass


class SessionException(Exception):
    """Exception raised when session operations fail."""

    pass


class SnapshotException(Exception):
    """Exception raised when snapshot operations fail (e.g., unsupported schema version)."""

    pass


class ProviderTokenCountError(Exception):
    """Thrown when a model provider's native token counting API fails.

    This error is used as internal control flow within provider ``count_tokens()`` overrides.
    When caught, the provider falls back to the base class heuristic estimation.
    """

    pass


class ToolProviderException(Exception):
    """Exception raised when a tool provider fails to load or cleanup tools."""

    pass


class StructuredOutputException(Exception):
    """Exception raised when structured output validation fails after maximum retry attempts."""

    def __init__(self, message: str):
        """Initialize the exception with details about the failure.

        Args:
            message: The error message describing the structured output failure
        """
        self.message = message
        super().__init__(message)


class ConcurrencyException(Exception):
    """Exception raised when concurrent invocations are attempted on an agent instance.

    Agent instances maintain internal state that cannot be safely accessed concurrently.
    This exception is raised when an invocation is attempted while another invocation
    is already in progress on the same agent instance.
    """

    pass


class IdempotencyAbortedError(Exception):
    """Exception raised to duplicate invocations when the primary invocation was aborted.

    When a caller provides an idempotency_token and another invocation with the same token
    is already in-flight, the duplicate waits for the primary to complete. If the primary
    is aborted before producing a result (e.g. it lost a lock race or was cancelled),
    this exception is raised to all waiting duplicates.
    """


class CheckpointException(Exception):
    """Exception raised when checkpoint operations fail (e.g., incompatible schema version)."""

    pass


class StorageError(Exception):
    """Raised when a storage operation fails.

    Wraps backend-specific errors (filesystem, S3, network) with a uniform type
    that consumers can catch without knowing which backend is in use.
    """

    pass


class AggregateMemoryError(Exception):
    """Raised when one or more memory store operations fail.

    Attributes:
        errors: The underlying exceptions that caused this aggregate failure.
    """

    def __init__(self, message: str, errors: list[BaseException]) -> None:
        """Initialize the aggregate error.

        Args:
            message: A human-readable description of the aggregate failure,
                typically naming the stores that failed.
            errors: The underlying exceptions that caused this failure.
        """
        super().__init__(message)
        self.errors = errors
