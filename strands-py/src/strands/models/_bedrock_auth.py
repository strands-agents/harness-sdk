"""Authentication for the Bedrock APIs that are called through third-party SDK clients."""

import asyncio
import re
from collections.abc import AsyncGenerator, Generator

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from typing_extensions import override


def require_sdk_version(name: str, version: str, minimum: tuple[int, int, int], feature: str, extra: str) -> None:
    """Raise ImportError if an installed SDK is older than ``feature`` supports.

    Older releases report an authentication failure raised while signing as a connection error and retry it.
    """
    match = re.match(r"(\d+)\.(\d+)\.(\d+)", version)
    if match is None or tuple(map(int, match.groups())) < minimum:
        required = ".".join(map(str, minimum))
        raise ImportError(
            f"{name}=<{version}> | {feature} requires {name}>={required}, "
            f"install it with: pip install -U 'strands-agents[{extra}]'"
        )


class BedrockSigV4Auth(httpx.Auth):
    """Signs each request with the session's current credentials, so refreshable credentials keep working."""

    requires_request_body = True

    def __init__(self, session: boto3.Session, region: str, error_type: type[Exception]) -> None:
        """Sign for ``region`` with ``session``'s credentials.

        ``error_type`` is raised when the session has no credentials. Pass the calling SDK's base error, which the SDK
        raises as is instead of retrying it and reporting a connection error.
        """
        self._session = session
        self._region = region
        self._error_type = error_type

    def _sign(self, request: httpx.Request) -> None:
        credentials = self._session.get_credentials()
        if credentials is None:
            raise self._error_type("Could not resolve AWS credentials for Amazon Bedrock from the boto3 session.")

        headers = {key: value for key, value in request.headers.items() if key.lower() != "connection"}
        signed = AWSRequest(method=request.method, url=str(request.url), headers=headers, data=request.content)
        SigV4Auth(credentials.get_frozen_credentials(), "bedrock", self._region).add_auth(signed)
        request.headers.update(dict(signed.headers))

    @override
    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        self._sign(request)
        yield request

    @override
    async def async_auth_flow(self, request: httpx.Request) -> AsyncGenerator[httpx.Request, httpx.Response]:
        # Resolving or refreshing credentials can block on network calls (IMDS, STS).
        await asyncio.to_thread(self._sign, request)
        yield request


class BedrockApiKeyAuth(httpx.Auth):
    """Sends an Amazon Bedrock API key as a bearer token."""

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    @override
    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        request.headers["Authorization"] = f"Bearer {self._api_key}"
        yield request
