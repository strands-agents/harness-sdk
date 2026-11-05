"""Shared plumbing for the Bedrock APIs that are called through third-party SDK clients: auth, transport, options."""

import asyncio
import functools
import importlib
import os
import re
from collections.abc import AsyncGenerator, Generator, Mapping
from types import ModuleType
from typing import Any

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


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


def _http_package(client_class: type) -> ModuleType:
    """The package an SDK's HTTP client class is built on: ``httpx``, or ``httpx2`` in newer SDK releases."""
    for base in client_class.__mro__:
        package = base.__module__.partition(".")[0]
        if base.__name__ == "AsyncClient" and package in ("httpx", "httpx2"):
            return importlib.import_module(package)
    raise TypeError(f"client_class=<{client_class}> | not an httpx or httpx2 AsyncClient")


@functools.cache
def _auth_class(http: ModuleType) -> type:
    """An ``Auth`` subclass for ``http``; each package only accepts its own ``Auth`` type."""

    class BedrockAuth(http.Auth):  # type: ignore[name-defined]
        """Signs each request with SigV4 using the session's current credentials, or sends a Bedrock API key."""

        requires_request_body = True

        def __init__(
            self,
            *,
            session: boto3.Session,
            region: str,
            service: str,
            error_type: type[Exception],
            api_key: str | None,
        ) -> None:
            self._session = session
            self._region = region
            self._service = service
            self._error_type = error_type
            self._api_key = api_key

        def _sign(self, request: Any) -> None:
            credentials = self._session.get_credentials()
            if credentials is None:
                raise self._error_type("Could not resolve AWS credentials for Amazon Bedrock from the boto3 session.")

            headers = {key: value for key, value in request.headers.items() if key.lower() != "connection"}
            signed = AWSRequest(method=request.method, url=str(request.url), headers=headers, data=request.content)
            SigV4Auth(credentials.get_frozen_credentials(), self._service, self._region).add_auth(signed)
            request.headers.update(dict(signed.headers))

        def auth_flow(self, request: Any) -> Generator[Any, Any, None]:
            if self._api_key:
                request.headers["Authorization"] = f"Bearer {self._api_key}"
            else:
                self._sign(request)
            yield request

        async def async_auth_flow(self, request: Any) -> AsyncGenerator[Any, Any]:
            if self._api_key:
                request.headers["Authorization"] = f"Bearer {self._api_key}"
            else:
                # Resolving or refreshing credentials can block on network calls (IMDS, STS).
                await asyncio.to_thread(self._sign, request)
            yield request

    return BedrockAuth


@functools.cache
def _per_loop_transport_class(http: ModuleType) -> type:
    """A transport for ``http`` that keeps one connection pool per event loop."""

    class BedrockPerLoopTransport(http.AsyncBaseTransport):  # type: ignore[name-defined]
        """Keeps a connection pool per event loop; a pooled connection can't be reused from another loop.

        Synchronous ``Agent`` calls each run in a new event loop, so one long-lived client would otherwise send each
        later call on a dead connection first and retry it. Each pool is an ``AsyncClient``, so proxy environment
        variables still apply.
        """

        def __init__(self, limits: Any) -> None:
            self._limits = limits
            self._clients: dict[asyncio.AbstractEventLoop, Any] = {}

        async def handle_async_request(self, request: Any) -> Any:
            loop = asyncio.get_running_loop()
            client = self._clients.get(loop)
            if client is None:
                # A finished loop's pool can't be used or closed from this loop; dropping it lets its sockets be freed.
                self._clients = {other: pool for other, pool in self._clients.items() if not other.is_closed()}
                client = self._clients[loop] = http.AsyncClient(limits=self._limits)
            return await client.send(request, stream=True)

        async def aclose(self) -> None:
            client = self._clients.pop(asyncio.get_running_loop(), None)
            self._clients.clear()
            if client is not None:
                await client.aclose()

    return BedrockPerLoopTransport


def bedrock_http_client(
    client_class: type,
    *,
    endpoint: str,
    region: str,
    session: boto3.Session,
    api_key: str | None,
    error_type: type[Exception],
    per_loop_limits: Any = None,
) -> Any:
    """Build an SDK's default async HTTP client that authenticates to Bedrock.

    Args:
        client_class: The SDK's ``DefaultAsyncHttpxClient``; its package (httpx or httpx2) decides the auth type.
        endpoint: ``"bedrock-runtime"`` or ``"bedrock-mantle"``, which sign as different SigV4 services.
        region: AWS region to sign for.
        session: Session whose current credentials sign each request.
        api_key: Bedrock API key to send instead of signing, if any.
        error_type: Raised when the session has no credentials. Pass the SDK's base error, which the SDK raises as is
            instead of retrying it and reporting a connection error.
        per_loop_limits: Connection limits for a pool per event loop, for a client that outlives one loop.
    """
    http = _http_package(client_class)
    auth = _auth_class(http)(
        session=session,
        region=region,
        service="bedrock-mantle" if endpoint == "bedrock-mantle" else "bedrock",
        error_type=error_type,
        api_key=api_key,
    )
    if per_loop_limits is None:
        return client_class(auth=auth)
    return client_class(auth=auth, transport=_per_loop_transport_class(http)(per_loop_limits))


def bedrock_api_key(api_key: str | None) -> str | None:
    """The API key to send: the given one, else ``AWS_BEARER_TOKEN_BEDROCK``, which ``BedrockModel`` also honors."""
    return api_key or os.environ.get("AWS_BEARER_TOKEN_BEDROCK") or None


def check_bedrock_options(
    owner: str, model_id: object, model_config: Mapping[str, Any], parent_options: set[str]
) -> None:
    """Reject options the nested Bedrock classes set themselves or can't serve.

    Raises:
        ValueError: If ``model_config`` holds a parent-provider option, or the model is an imported model.
    """
    if passed := parent_options & set(model_config):
        raise ValueError(
            f"options=<{sorted(passed)}> | not supported by {owner}, use client_args or the Bedrock options"
        )
    if ":imported-model/" in str(model_id or ""):
        raise ValueError(
            f"model_id=<{model_id}> | imported models are served only through InvokeModel, which {owner} doesn't use"
        )
