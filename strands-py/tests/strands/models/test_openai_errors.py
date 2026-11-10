import pytest

from strands.models._openai_errors import classify_openai_error


class OpenAICompatibleError(Exception):
    def __init__(self, message: str, *, code: object = None, status_code: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@pytest.mark.parametrize(
    "message",
    [
        "maximum context length",
        "context_length_exceeded",
        "too many tokens",
        "context length",
        "input is too long for requested model",
        "input length and `max_tokens` exceed context limit",
        "too many total text bytes",
        "exceed customer model maximum",
        "the engine prompt length exceeds the max_model_len",
        "prompt tokens (1200008) exceed model maximum (1050000) for openai.gpt-5.6-terra",
    ],
)
def test_classify_openai_error_context_overflow_message(message):
    assert classify_openai_error(OpenAICompatibleError(message)) == "context_overflow"


def test_classify_openai_error_message_case_insensitive():
    assert classify_openai_error(OpenAICompatibleError("MAXIMUM CONTEXT LENGTH EXCEEDED")) == "context_overflow"


def test_classify_openai_error_context_overflow_code():
    error = OpenAICompatibleError("provider failure", code="CONTEXT_LENGTH_EXCEEDED")

    assert classify_openai_error(error) == "context_overflow"


@pytest.mark.parametrize("message", ["rate_limit_exceeded", "rate limit", "too many requests"])
def test_classify_openai_error_throttling_message(message):
    assert classify_openai_error(OpenAICompatibleError(message)) == "throttling"


def test_classify_openai_error_throttling_code():
    error = OpenAICompatibleError("provider failure", code="RATE_LIMIT_EXCEEDED")

    assert classify_openai_error(error) == "throttling"


def test_classify_openai_error_http_429():
    error = OpenAICompatibleError("provider failure", status_code=429)

    assert classify_openai_error(error) == "throttling"


def test_classify_openai_error_throttling_precedes_context_overflow():
    error = OpenAICompatibleError("exceed customer model maximum", code="rate_limit_exceeded")

    assert classify_openai_error(error) == "throttling"


@pytest.mark.parametrize(
    "message",
    [
        "unrelated failure",
        "model maximum output tokens must be a positive integer",
        "requested model openai.gpt-5.6-terra is not available in this region",
    ],
)
def test_classify_openai_error_unknown(message):
    assert classify_openai_error(OpenAICompatibleError(message)) is None


def test_classify_openai_error_non_string_code():
    error = OpenAICompatibleError("unrelated failure", code=400)

    assert classify_openai_error(error) is None
