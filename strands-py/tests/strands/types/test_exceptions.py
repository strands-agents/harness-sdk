"""Tests for exception types in the strands.types.exceptions module."""

import pytest

from strands.types.exceptions import (
    ContextWindowOverflowException,
    EventLoopException,
    MaxTokensReachedException,
    MCPClientInitializationError,
    ModelThrottledException,
    SessionException,
    StructuredOutputException,
)


class TestEventLoopException:
    """Tests for EventLoopException class."""

    def test_initialization_with_request_state(self):
        """Test EventLoopException initialization with request state."""
        original_exception = ValueError("Original error")
        request_state = {"session_id": "123", "user": "test_user"}

        exception = EventLoopException(original_exception, request_state)

        assert exception.original_exception == original_exception
        assert exception.request_state == request_state
        assert str(exception) == "Original error"

    def test_initialization_without_request_state(self):
        """Test EventLoopException initialization without request state."""
        original_exception = RuntimeError("Runtime error")

        exception = EventLoopException(original_exception)

        assert exception.original_exception == original_exception
        assert exception.request_state == {}
        assert str(exception) == "Runtime error"

    def test_initialization_with_none_request_state(self):
        """Test EventLoopException initialization with None request state."""
        original_exception = TypeError("Type error")

        exception = EventLoopException(original_exception, None)

        assert exception.original_exception == original_exception
        assert exception.request_state == {}
        assert str(exception) == "Type error"

    def test_inheritance(self):
        """Test that EventLoopException inherits from Exception."""
        original_exception = Exception("Test")
        exception = EventLoopException(original_exception)

        assert isinstance(exception, Exception)
        assert issubclass(EventLoopException, Exception)

    def test_exception_message_from_original(self):
        """Test that exception message comes from original exception."""
        original_exception = ValueError("Custom error message")
        exception = EventLoopException(original_exception)

        assert str(exception) == "Custom error message"
        assert exception.args[0] == "Custom error message"


class TestMaxTokensReachedException:
    """Tests for MaxTokensReachedException class."""

    def test_initialization_with_message(self):
        """Test MaxTokensReachedException initialization with message."""
        message = "Maximum tokens limit of 4096 reached"
        exception = MaxTokensReachedException(message)

        assert str(exception) == message
        assert exception.args[0] == message

    def test_inheritance(self):
        """Test that MaxTokensReachedException inherits from Exception."""
        exception = MaxTokensReachedException("Test message")

        assert isinstance(exception, Exception)
        assert issubclass(MaxTokensReachedException, Exception)

    def test_exception_with_detailed_message(self):
        """Test exception with detailed message about token limits."""
        message = (
            "Model reached maximum token limit of 8192 tokens. "
            "Consider reducing input size or increasing max_tokens parameter."
        )
        exception = MaxTokensReachedException(message)

        assert str(exception) == message

    def test_exception_raised_properly(self):
        """Test that exception can be raised and caught properly."""
        with pytest.raises(MaxTokensReachedException) as exc_info:
            raise MaxTokensReachedException("Token limit exceeded")

        assert str(exc_info.value) == "Token limit exceeded"


class TestContextWindowOverflowException:
    """Tests for ContextWindowOverflowException class."""

    def test_initialization(self):
        """Test ContextWindowOverflowException initialization."""
        exception = ContextWindowOverflowException()

        assert isinstance(exception, Exception)
        assert str(exception) == ""

    def test_initialization_with_message(self):
        """Test ContextWindowOverflowException with custom message."""
        exception = ContextWindowOverflowException("Context window exceeded 100k tokens")

        assert str(exception) == "Context window exceeded 100k tokens"

    def test_inheritance(self):
        """Test that ContextWindowOverflowException inherits from Exception."""
        exception = ContextWindowOverflowException()

        assert isinstance(exception, Exception)
        assert issubclass(ContextWindowOverflowException, Exception)

    def test_exception_raised_properly(self):
        """Test that exception can be raised and caught properly."""
        with pytest.raises(ContextWindowOverflowException) as exc_info:
            raise ContextWindowOverflowException("Input too large for model")

        assert str(exc_info.value) == "Input too large for model"


class TestMCPClientInitializationError:
    """Tests for MCPClientInitializationError class."""

    def test_initialization(self):
        """Test MCPClientInitializationError initialization."""
        exception = MCPClientInitializationError()

        assert isinstance(exception, Exception)
        assert str(exception) == ""

    def test_initialization_with_message(self):
        """Test MCPClientInitializationError with custom message."""
        exception = MCPClientInitializationError("Failed to connect to MCP server")

        assert str(exception) == "Failed to connect to MCP server"

    def test_inheritance(self):
        """Test that MCPClientInitializationError inherits from Exception."""
        exception = MCPClientInitializationError()

        assert isinstance(exception, Exception)
        assert issubclass(MCPClientInitializationError, Exception)

    def test_exception_with_detailed_error(self):
        """Test exception with detailed initialization error."""
        message = "MCP server initialization failed: Connection refused on port 8080"
        exception = MCPClientInitializationError(message)

        assert str(exception) == message


class TestModelThrottledException:
    """Tests for ModelThrottledException class."""

    def test_initialization_with_message(self):
        """Test ModelThrottledException initialization with message."""
        message = "Rate limit exceeded. Please retry after 60 seconds."
        exception = ModelThrottledException(message)

        assert exception.message == message
        assert str(exception) == message
        assert exception.args[0] == message

    def test_inheritance(self):
        """Test that ModelThrottledException inherits from Exception."""
        exception = ModelThrottledException("Throttled")

        assert isinstance(exception, Exception)
        assert issubclass(ModelThrottledException, Exception)

    def test_message_property(self):
        """Test that message property is accessible."""
        message = "API rate limit: 10 requests per minute"
        exception = ModelThrottledException(message)

        assert exception.message == message
        assert hasattr(exception, "message")

    def test_exception_raised_properly(self):
        """Test that exception can be raised and caught properly."""
        with pytest.raises(ModelThrottledException) as exc_info:
            raise ModelThrottledException("Service temporarily unavailable")

        assert exc_info.value.message == "Service temporarily unavailable"
        assert str(exc_info.value) == "Service temporarily unavailable"


class TestSessionException:
    """Tests for SessionException class."""

    def test_initialization(self):
        """Test SessionException initialization."""
        exception = SessionException()

        assert isinstance(exception, Exception)
        assert str(exception) == ""

    def test_initialization_with_message(self):
        """Test SessionException with custom message."""
        exception = SessionException("Session expired")

        assert str(exception) == "Session expired"

    def test_inheritance(self):
        """Test that SessionException inherits from Exception."""
        exception = SessionException()

        assert isinstance(exception, Exception)
        assert issubclass(SessionException, Exception)

    def test_exception_with_detailed_message(self):
        """Test exception with detailed session error."""
        message = "Failed to restore session: Invalid session ID or session has expired"
        exception = SessionException(message)

        assert str(exception) == message


class TestStructuredOutputException:
    """Tests for StructuredOutputException class."""

    def test_initialization_with_message(self):
        """Test StructuredOutputException initialization with message."""
        message = "Failed to validate structured output after 3 attempts"
        exception = StructuredOutputException(message)

        assert exception.message == message
        assert str(exception) == message
        assert exception.args[0] == message

    def test_inheritance(self):
        """Test that StructuredOutputException inherits from Exception."""
        exception = StructuredOutputException("Validation failed")

        assert isinstance(exception, Exception)
        assert issubclass(StructuredOutputException, Exception)

    def test_message_property(self):
        """Test that message property is accessible."""
        message = "Pydantic validation error: field 'name' is required"
        exception = StructuredOutputException(message)

        assert exception.message == message
        assert hasattr(exception, "message")

    def test_exception_with_validation_details(self):
        """Test exception with detailed validation error message."""
        message = (
            "Structured output validation failed:\n"
            "- Field 'age' must be a positive integer\n"
            "- Field 'email' must be a valid email address"
        )
        exception = StructuredOutputException(message)

        assert exception.message == message
        assert str(exception) == message

    def test_exception_raised_properly(self):
        """Test that exception can be raised and caught properly."""
        with pytest.raises(StructuredOutputException) as exc_info:
            raise StructuredOutputException("Invalid output format")

        assert exc_info.value.message == "Invalid output format"
        assert str(exc_info.value) == "Invalid output format"


class TestExceptionInheritance:
    """Tests for verifying exception inheritance hierarchy."""

    def test_all_exceptions_inherit_from_exception(self):
        """Test that all custom exceptions inherit from Exception."""
        exception_classes = [
            EventLoopException,
            MaxTokensReachedException,
            ContextWindowOverflowException,
            MCPClientInitializationError,
            ModelThrottledException,
            SessionException,
            StructuredOutputException,
        ]

        for exc_class in exception_classes:
            assert issubclass(exc_class, Exception), f"{exc_class.__name__} should inherit from Exception"

    def test_exception_instances_are_exceptions(self):
        """Test that all exception instances are instances of Exception."""
        exceptions = [
            EventLoopException(ValueError("test")),
            MaxTokensReachedException("test"),
            ContextWindowOverflowException("test"),
            MCPClientInitializationError("test"),
            ModelThrottledException("test"),
            SessionException("test"),
            StructuredOutputException("test"),
        ]

        for exception in exceptions:
            assert isinstance(exception, Exception), f"{type(exception).__name__} instance should be an Exception"

    def test_exceptions_can_be_caught_as_exception(self):
        """Test that all custom exceptions can be caught as generic Exception."""
        exceptions_to_raise = [
            (EventLoopException, ValueError("test"), None),
            (MaxTokensReachedException, "test", None),
            (ContextWindowOverflowException, "test", None),
            (MCPClientInitializationError, "test", None),
            (ModelThrottledException, "test", None),
            (SessionException, "test", None),
            (StructuredOutputException, "test", None),
        ]

        for exc_class, *args in exceptions_to_raise:
            try:
                if exc_class == EventLoopException:
                    raise exc_class(*args)
                else:
                    raise exc_class(args[0])
            except Exception as e:
                assert isinstance(e, exc_class)
                assert isinstance(e, Exception)


class TestExceptionMessages:
    """Tests for exception messages and representations."""

    def test_exception_str_representations(self):
        """Test string representations of all exceptions."""
        exceptions = [
            (EventLoopException(ValueError("event loop error")), "event loop error"),
            (MaxTokensReachedException("max tokens"), "max tokens"),
            (ContextWindowOverflowException("overflow"), "overflow"),
            (MCPClientInitializationError("init error"), "init error"),
            (ModelThrottledException("throttled"), "throttled"),
            (SessionException("session error"), "session error"),
            (StructuredOutputException("output error"), "output error"),
        ]

        for exception, expected_str in exceptions:
            assert str(exception) == expected_str

    def test_exception_repr_contains_class_name(self):
        """Test that repr contains the exception class name."""
        exceptions = [
            EventLoopException(ValueError("test")),
            MaxTokensReachedException("test"),
            ContextWindowOverflowException("test"),
            MCPClientInitializationError("test"),
            ModelThrottledException("test"),
            SessionException("test"),
            StructuredOutputException("test"),
        ]

        for exception in exceptions:
            class_name = type(exception).__name__
            assert class_name in repr(exception)

    def test_exceptions_with_custom_properties(self):
        """Test exceptions with custom properties maintain those properties."""
        # EventLoopException with properties
        event_loop_exc = EventLoopException(ValueError("test"), {"key": "value"})
        assert hasattr(event_loop_exc, "original_exception")
        assert hasattr(event_loop_exc, "request_state")
        assert event_loop_exc.original_exception.args[0] == "test"
        assert event_loop_exc.request_state == {"key": "value"}

        # ModelThrottledException with message property
        throttled_exc = ModelThrottledException("throttle message")
        assert hasattr(throttled_exc, "message")
        assert throttled_exc.message == "throttle message"

        # StructuredOutputException with message property
        structured_exc = StructuredOutputException("validation message")
        assert hasattr(structured_exc, "message")
        assert structured_exc.message == "validation message"
