import functools
import json
import logging
import os
from collections.abc import Callable, Sequence

import boto3
import pytest
from tenacity import RetryCallState, RetryError, Retrying, stop_after_attempt, wait_exponential

logger = logging.getLogger(__name__)


@pytest.fixture
def quiet_strands_logging():
    """Suppress strands DEBUG/INFO logging for tests that produce very long output."""
    strands_logger = logging.getLogger("strands")
    original_level = strands_logger.level
    strands_logger.setLevel(logging.WARNING)
    yield
    strands_logger.setLevel(original_level)


# Type alias for retry conditions
RetryCondition = type[BaseException] | Callable[[BaseException], bool] | str


def _should_retry_exception(exc: BaseException, conditions: Sequence[RetryCondition]) -> bool:
    """Check if exception matches any of the given retry conditions.

    Args:
        exc: The exception to check
        conditions: Sequence of conditions, each can be:
            - Exception type: retry if isinstance(exc, condition)
            - Callable: retry if condition(exc) returns True
            - str: retry if string is in str(exc)
    """
    for condition in conditions:
        if isinstance(condition, type) and issubclass(condition, BaseException):
            if isinstance(exc, condition):
                return True
        elif callable(condition):
            if condition(exc):
                return True
        elif isinstance(condition, str):
            if condition in str(exc):
                return True
    return False


_RETRY_ON_ANY: Sequence[RetryCondition] = (lambda _: True,)


def retry_on_flaky(
    reason: str,
    *,
    max_attempts: int = 3,
    wait_multiplier: float = 1,
    wait_max: float = 10,
    retry_on: Sequence[RetryCondition] = _RETRY_ON_ANY,
) -> Callable:
    """Decorator to retry flaky integration tests that fail due to external factors.

    WHEN TO USE:
        - External service instability (API rate limits, transient network errors)
        - Non-deterministic LLM responses that occasionally fail assertions
        - Resource contention in shared test environments
        - Known intermittent issues with third-party dependencies

    WHEN NOT TO USE:
        - Actual bugs in the code under test (fix the bug instead)
        - Deterministic failures (these indicate real problems)
        - Unit tests (flakiness in unit tests usually indicates a design issue)
        - To mask consistently failing tests (investigate root cause first)

    Prefer using specific retry_on conditions over retrying on any exception
    to avoid masking real bugs.

    Args:
        reason: Required explanation of why this test is flaky and needs retries.
            This should describe the source of non-determinism (e.g., "LLM responses
            may vary" or "External API has intermittent rate limits").
        max_attempts: Maximum number of retry attempts (default: 3)
        wait_multiplier: Multiplier for exponential backoff in seconds (default: 1)
        wait_max: Maximum wait time between retries in seconds (default: 10)
        retry_on: Conditions for when to retry. Defaults to retrying on any exception.
            Each condition can be:
            - Exception type: e.g., ValueError, TimeoutError
            - Callable: e.g., lambda e: "timeout" in str(e).lower()
            - str: substring to match in exception message

    Usage:
        # Retry on any failure
        @retry_on_flaky("LLM responses are non-deterministic")
        def test_something():
            ...

        # Retry only on specific exception types
        @retry_on_flaky("Network calls may fail transiently", retry_on=[TimeoutError, ConnectionError])
        def test_network_call():
            ...

        # Retry on string patterns in exception message
        @retry_on_flaky("Service has intermittent availability", retry_on=["Service unavailable", "Status 503"])
        def test_service_call():
            ...
    """

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            def should_retry(retry_state: RetryCallState) -> bool:
                if retry_state.outcome is None or not retry_state.outcome.failed:
                    return False
                exc = retry_state.outcome.exception()
                if exc is None:
                    return False
                return _should_retry_exception(exc, retry_on)

            try:
                for attempt in Retrying(
                    stop=stop_after_attempt(max_attempts),
                    wait=wait_exponential(multiplier=wait_multiplier, max=wait_max),
                    retry=should_retry,
                    reraise=True,
                ):
                    with attempt:
                        return func(*args, **kwargs)
            except RetryError:
                raise

        return wrapper

    return decorator


def pytest_sessionstart(session):
    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
    os.environ.setdefault("AWS_REGION", "us-east-1")
    _load_api_keys_from_secrets_manager()


## Data


@pytest.fixture
def yellow_img(pytestconfig):
    path = pytestconfig.rootdir / "tests_integ/resources/yellow.png"
    with open(path, "rb") as fp:
        return fp.read()


@pytest.fixture
def letter_pdf(pytestconfig):
    path = pytestconfig.rootdir / "tests_integ/resources/letter.pdf"
    with open(path, "rb") as fp:
        return fp.read()


@pytest.fixture
def blue_video(pytestconfig):
    path = pytestconfig.rootdir / "tests_integ/resources/blue.mp4"
    with open(path, "rb") as fp:
        return fp.read()


@pytest.fixture
def pineapple_audio(pytestconfig):
    path = pytestconfig.rootdir / "tests_integ/resources/pineapple.mp3"
    with open(path, "rb") as fp:
        return fp.read()


## Async


@pytest.fixture(scope="session")
def agenerator():
    async def agenerator(items):
        for item in items:
            yield item

    return agenerator


@pytest.fixture(scope="session")
def alist():
    async def alist(items):
        return [item async for item in items]

    return alist


## Models


def _load_api_keys_from_secrets_manager():
    """Load API keys as environment variables from AWS Secrets Manager."""
    session = boto3.session.Session()
    client = session.client(service_name="secretsmanager")
    if "STRANDS_TEST_API_KEYS_SECRET_NAME" in os.environ:
        try:
            secret_name = os.getenv("STRANDS_TEST_API_KEYS_SECRET_NAME")
            response = client.get_secret_value(SecretId=secret_name)

            if "SecretString" in response:
                secret = json.loads(response["SecretString"])
                for key, value in secret.items():
                    os.environ[f"{key.upper()}_API_KEY"] = str(value)

        except Exception as e:
            logger.warning("Error retrieving secret", e)

    """
    Validate that required environment variables are set when running in GitHub Actions.
    This prevents tests from being unintentionally skipped due to missing credentials.
    """
    if os.environ.get("GITHUB_ACTIONS") != "true":
        logger.warning("Tests running outside GitHub Actions, skipping required provider validation")
        return

    required_providers = {
        "ANTHROPIC_API_KEY",
        "GOOGLE_API_KEY",
        # "MISTRAL_API_KEY", # will add back once we get a card on file for this.
        "OPENAI_API_KEY",
        "WRITER_API_KEY",
    }
    for provider in required_providers:
        if provider not in os.environ or not os.environ[provider]:
            raise ValueError(f"Missing required environment variables for {provider}")
