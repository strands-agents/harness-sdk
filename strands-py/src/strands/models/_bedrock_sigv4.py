"""SigV4 request signing for the Bedrock APIs that are called through third-party SDK clients."""

import asyncio
from collections.abc import AsyncGenerator, Generator

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from typing_extensions import override


class BedrockSigV4Auth(httpx.Auth):
    """Signs each request with the session's current credentials, so refreshable credentials keep working."""

    requires_request_body = True

    def __init__(self, session: boto3.Session, region: str) -> None:
        self._session = session
        self._region = region

    def _sign(self, request: httpx.Request) -> None:
        credentials = self._session.get_credentials()
        if credentials is None:
            raise RuntimeError("Could not resolve AWS credentials for Amazon Bedrock from the boto3 session.")

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
