"""Shell sandbox with default implementations for file and code operations.

Subclasses only need to implement :meth:`PosixShellSandbox.execute_streaming` —
all other operations are implemented by running shell commands through it. Use
this for remote environments where only shell access is available (Docker
containers, SSH connections, cloud runtimes).

Mirrors ``strands-ts/src/sandbox/posix-shell.ts``.
"""

import base64
import contextlib
import logging
import re
import shlex
import uuid
from abc import ABC
from collections.abc import AsyncGenerator
from typing import Any
from urllib.parse import urlparse

from .base import Sandbox
from .constants import ENV_KEY_PATTERN, LANGUAGE_PATTERN
from .errors import SandboxHttpError, SandboxPathNotFoundError, SandboxTimeoutError
from .types import ExecutionResult, FileInfo, HttpResult, StreamChunk

logger = logging.getLogger(__name__)

# The characters RFC 3986 allows anywhere in a URL.  Anything outside this
# set (whitespace, quotes, control characters, non-ASCII) is rejected before
# the URL reaches a shell command.  Security-critical for the curl transport.
_URL_CHARS = re.compile(r"[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+")

# Anything outside this set (or a CR/LF/NUL in a value) could inject additional headers
# or smuggle a second equest, so header names are validated against this pattern.
_HEADER_NAME = re.compile(r"[!#$%&'*+\-.^_|~0-9A-Za-z]+")

# HTTP methods accepted by request(). An explicit allowlist (matching the
# http_request tool's HttpMethod) keeps the method safe to place in the curl
# command line and rejects anything unexpected outright.
_ALLOWED_METHODS = frozenset({"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"})

# curl's "Failure writing output" exit code. When a response is capped, the body
# is piped through ``head -c``; once ``head`` has read the cap it closes the pipe
# and curl aborts with this code — the signal that the body exceeded ``max_bytes``.
_CURL_WRITE_ERROR = 23

# Tags curl's final URL on stderr for the capped path, where stdout is reserved
# for the (binary) response body. Error text never contains this literal, so the
# resolved URL can be recovered unambiguously.
_URL_MARKER = "STRANDS_URL:"
_URL_MARKER_RE = re.compile(re.escape(_URL_MARKER) + r"(\S*)")


def validate_env_keys(env: dict[str, str]) -> None:
    """Validate environment variable names against :data:`ENV_KEY_PATTERN`.

    Args:
        env: Mapping of environment variable names to values.

    Raises:
        ValueError: If any key is not a valid POSIX environment variable name.
    """
    for key in env:
        if not ENV_KEY_PATTERN.fullmatch(key):
            raise ValueError(f"Invalid environment variable name: {key}")


def build_shell_env_prefix(env: dict[str, str] | None = None) -> str:
    """Build a shell ``export KEY=VALUE && ...`` prefix, or ``""`` when empty.

    Keys are validated; values are escaped with :func:`shlex.quote`. Used by
    shell-string backends (e.g. SSH); backends that set env via native flags
    (e.g. Docker's ``-e``) call :func:`validate_env_keys` directly.

    Uses ``export`` rather than an ``env KEY=VALUE`` command wrapper so the
    variables are set in the shell itself and inherited by every stage of a
    pipeline. ``execute_code`` runs ``base64 ... | <lang>``, and an ``env``
    wrapper would only bind the left side of the pipe, never reaching the
    interpreter. The trailing ``&&`` keeps the surrounding
    ``cd ... && <prefix><command>`` chain fail-fast.

    Args:
        env: Mapping of environment variable names to values.

    Returns:
        The shell ``export ... && `` prefix, or an empty string when ``env`` is
        ``None`` or empty.

    Raises:
        ValueError: If any key is not a valid POSIX environment variable name.
    """
    if not env:
        return ""
    validate_env_keys(env)
    assignments = " ".join(f"{key}={shlex.quote(value)}" for key, value in env.items())
    return f"export {assignments} && "


def _eof_marker() -> str:
    """Generate a unique heredoc EOF marker, mirroring the TS ``STRANDS_EOF_`` token."""
    return f"STRANDS_EOF_{uuid.uuid4().hex[:16]}"


def _parse_status_and_headers(raw: str) -> tuple[int, str, dict[str, str]]:
    r"""Parse a curl ``-D`` header dump into ``(status, status_text, headers)``.

    Curl dumps headers for every hop in a redirect chain, separated by blank
    lines. Only the final response is parsed so that stale headers from
    intermediate redirects don't leak through.

    Repeated headers (e.g. ``Set-Cookie``) are preserved by joining their values
    with a newline, matching the ``http_request`` tool's handling. ``status`` is
    ``0`` and ``status_text`` is ``""`` when the dump has no parseable status line.
    """
    # Split on blank lines, take the last non-empty block.
    blocks = re.split(r"\n\s*\n", raw.replace("\r\n", "\n"))
    last_block = ""
    for block in reversed(blocks):
        if block.strip():
            last_block = block
            break

    status = 0
    status_text = ""
    headers: dict[str, str] = {}
    for line in last_block.split("\n"):
        line = line.strip()
        if not line:
            continue
        if line.upper().startswith("HTTP/"):
            # Status line, e.g. "HTTP/1.1 200 OK" or "HTTP/2 204".
            parts = line.split(None, 2)
            if len(parts) >= 2 and parts[1].isdigit():
                status = int(parts[1])
                status_text = parts[2].strip() if len(parts) == 3 else ""
            continue
        colon = line.find(":")
        if colon < 1:
            continue
        name = line[:colon].strip().lower()
        value = line[colon + 1 :].strip()
        existing = headers.get(name)
        headers[name] = value if existing is None else f"{existing}\n{value}"
    return status, status_text, headers


def _resolve_capped_outcome(rc_text: str, stderr_text: str, fallback_exit: int, max_bytes: int | None, url: str) -> str:
    """Interpret a capped request's curl exit code and tagged stderr.

    The pipeline's exit status is ``head``'s, so curl's own code is read from a file
    (``fallback_exit`` if unreadable); the resolved URL and error text share the tagged stderr.

    Returns the resolved URL on success.

    Raises:
        SandboxHttpError: When the body exceeded ``max_bytes`` (curl aborted
            writing to the closed pipe) or the transfer otherwise failed.
    """
    curl_rc = int(rc_text) if rc_text.isdigit() else fallback_exit
    if curl_rc == _CURL_WRITE_ERROR:
        raise SandboxHttpError(f"response body exceeded max_bytes ({max_bytes})")
    if curl_rc != 0:
        detail = _URL_MARKER_RE.sub("", stderr_text).strip()
        raise SandboxHttpError(detail or f"curl exited with code {curl_rc}")
    match = _URL_MARKER_RE.search(stderr_text)
    return (match.group(1) if match else "") or url


class PosixShellSandbox(Sandbox, ABC):
    """Abstract sandbox that provides shell-based defaults for file and code operations.

    Assumes a POSIX-compatible shell (sh/bash) on the target.

    Subclasses only need to implement :meth:`execute_streaming`. The remaining
    operations — ``execute_code_streaming``, ``read_file``, ``write_file``,
    ``remove_file``, and ``list_files`` — are implemented via shell commands
    piped through :meth:`execute_streaming`.

    Subclasses may override any method with a native implementation for better
    performance or to handle edge cases (e.g., binary-safe file transfer via
    Docker stdin pipes, or native API calls for cloud backends).

    Subclasses are responsible for honoring the execution options in
    :meth:`execute_streaming`, or they have no effect:

    - ``env`` — backends that build a shell-command string prepend
      :func:`build_shell_env_prefix`; backends that set env via process flags
      (e.g. Docker's ``-e``) call :func:`validate_env_keys` and pass the values
      directly. An implementation that ignores ``env`` will silently drop the
      caller's variables.
    - ``timeout`` — the base class does not enforce a timeout; a subclass that
      does not wire ``timeout`` into its process supervision will silently run
      without any time limit.
    - ``cwd`` — similarly must be applied by the subclass.
    """

    async def execute_code_streaming(
        self,
        code: str,
        language: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamChunk | ExecutionResult, None]:
        """Execute code by piping it to a language interpreter over the shell.

        The code is base64-encoded and decoded inside a quoted heredoc on the
        target, then piped to the interpreter (``base64 -d << 'EOF' | <lang>``).
        This transports arbitrary source — including shell metacharacters,
        quotes, and newlines — without injection risk. The ``language`` is
        validated against :data:`LANGUAGE_PATTERN` first.

        Args:
            code: The source code to execute.
            language: The interpreter to use (e.g., ``"python3"``, ``"node"``).
            timeout: Maximum execution time in seconds. ``None`` means no timeout.
            cwd: Working directory for execution.
            env: Environment variables to set for this execution.
            **kwargs: Additional keyword arguments for forward compatibility.

        Yields:
            :class:`StreamChunk` objects for output, then a final
            :class:`ExecutionResult`.

        Raises:
            ValueError: If ``language`` contains invalid characters.
        """
        if not LANGUAGE_PATTERN.fullmatch(language):
            raise ValueError(f"language parameter contains invalid characters: {language}")
        encoded = base64.b64encode(code.encode()).decode("ascii")
        eof = _eof_marker()
        command = f"base64 -d << '{eof}' | {language}\n{encoded}\n{eof}"
        async for chunk in self.execute_streaming(command, timeout=timeout, cwd=cwd, env=env, **kwargs):
            yield chunk

    async def read_file(self, path: str, **kwargs: Any) -> bytes:
        """Read a file as raw bytes via base64 over the shell.

        Args:
            path: Path to the file to read.
            **kwargs: Additional keyword arguments for forward compatibility.

        Returns:
            The file contents as raw bytes.

        Raises:
            FileNotFoundError: If the file does not exist or cannot be read.
            OSError: If the command succeeds but its output is not valid base64
                (e.g. a shell profile or locale warning prepended text to stdout).
        """
        result = await self.execute(f"base64 < {shlex.quote(path)}")
        if result.exit_code != 0:
            raise FileNotFoundError(result.stderr or f"Failed to read file: {path}")
        # base64 output is ASCII-safe text; strip whitespace (line wrapping) and decode.
        try:
            # binascii.Error (raised by b64decode on malformed input) subclasses ValueError.
            return base64.b64decode("".join(result.stdout.split()))
        except ValueError as e:
            raise OSError(f"Failed to decode base64 contents of file: {path}") from e

    async def write_file(self, path: str, content: bytes, **kwargs: Any) -> None:
        """Write raw bytes to a file via base64 over the shell.

        Parent directories are created via ``mkdir -p``. The base64-encoded
        content is decoded inside a quoted heredoc on the target, preserving
        arbitrary binary content.

        Args:
            path: Path to the file to write.
            content: The content to write.
            **kwargs: Additional keyword arguments for forward compatibility.

        Raises:
            OSError: If the file cannot be written.
        """
        encoded = base64.b64encode(content).decode("ascii")
        quoted = shlex.quote(path)
        eof = _eof_marker()
        cmd = f"mkdir -p \"$(dirname {quoted})\" && base64 -d << '{eof}' > {quoted}\n{encoded}\n{eof}"
        result = await self.execute(cmd)
        if result.exit_code != 0:
            raise OSError(result.stderr or f"Failed to write file: {path}")

    async def remove_file(self, path: str, **kwargs: Any) -> None:
        """Remove a file via ``rm`` over the shell.

        Args:
            path: Path to the file to remove.
            **kwargs: Additional keyword arguments for forward compatibility.

        Raises:
            FileNotFoundError: If the file does not exist.
        """
        result = await self.execute(f"rm {shlex.quote(path)}")
        if result.exit_code != 0:
            raise FileNotFoundError(result.stderr or f"Failed to remove file: {path}")

    async def list_files(self, path: str, **kwargs: Any) -> list[FileInfo]:
        """List directory contents via ``ls -1ap`` parsing.

        Args:
            path: Path to the directory to list.
            **kwargs: Additional keyword arguments for forward compatibility.

        Returns:
            A list of :class:`FileInfo` entries (``size`` is always ``None`` for
            this shell-based listing).

        Raises:
            SandboxPathNotFoundError: If the directory does not exist (or ``path``
                is not a directory).
            OSError: If the listing fails for another reason.
        """
        quoted = shlex.quote(path)
        # Exit 77 distinguishes a missing directory from ls's own failures (locale-independent).
        result = await self.execute(f"test -d {quoted} || exit 77; env QUOTING_STYLE=literal ls -1ap {quoted}")
        if result.exit_code == 77:
            raise SandboxPathNotFoundError(path)
        if result.exit_code != 0:
            raise OSError(result.stderr or f"Failed to list directory: {path}")

        entries: list[FileInfo] = []
        for raw in result.stdout.split("\n"):
            line = raw.rstrip("\r")
            if not line or line in ("./", "../"):
                continue
            is_dir = line.endswith("/")
            name = line[:-1] if is_dir else line
            if name:
                entries.append(FileInfo(name=name, is_dir=is_dir))
        return entries

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        body: bytes | str | None = None,
        timeout: float | None = None,
        max_bytes: int | None = None,
        **kwargs: Any,
    ) -> HttpResult:
        """Make an HTTP request with ``curl`` inside the sandbox.

        Works with any HTTP method. HTTP error statuses (4xx/5xx) are returned
        in :attr:`HttpResult.status` rather than raised; only transport-level
        failures (DNS, connection, timeout, size cap) raise
        :class:`SandboxHttpError`. ``max_bytes`` bounds the download: the
        transfer is stopped at the cap and a response exceeding it raises
        :class:`SandboxHttpError` rather than returning a silently truncated body
        (matching the ``web_fetch`` tool).
        """
        method = method.strip().upper()
        if method not in _ALLOWED_METHODS:
            raise SandboxHttpError(f"Unsupported HTTP method {method!r}; expected one of {sorted(_ALLOWED_METHODS)}.")
        url = url.strip()
        if not _URL_CHARS.fullmatch(url):
            raise SandboxHttpError(
                "request URLs may only contain the characters RFC 3986 allows; "
                "percent-encode spaces and non-ASCII characters (and punycode the host) and retry."
            )
        parts = urlparse(url)
        if parts.scheme not in ("http", "https"):
            raise SandboxHttpError(f"request only supports http(s) URLs, got {url!r}.")
        if not parts.hostname:
            raise SandboxHttpError(f"request URL has no host: {url!r}.")

        tag = uuid.uuid4().hex
        body_file = f"/tmp/strands-http-{tag}"
        header_file = f"/tmp/strands-http-{tag}.headers"
        data_file = f"/tmp/strands-http-{tag}.data"
        rc_file = f"/tmp/strands-http-{tag}.rc"
        err_file = f"/tmp/strands-http-{tag}.err"
        body_quoted = shlex.quote(body_file)
        header_quoted = shlex.quote(header_file)
        data_quoted = shlex.quote(data_file)
        rc_quoted = shlex.quote(rc_file)
        err_quoted = shlex.quote(err_file)

        # A HEAD response carries no body; use curl's --head so it doesn't block
        # waiting for a body the server will never send.
        is_head = method == "HEAD"

        # Write the request body to a temp file and feed it via --data-binary so
        # arbitrary bytes never touch the shell command line.
        if body is not None:
            await self.write_file(data_file, body.encode("utf-8") if isinstance(body, str) else body)

        opts = ""
        if timeout is not None:
            opts += f" --max-time {timeout}"
        if headers:
            for n, v in headers.items():
                if not _HEADER_NAME.fullmatch(n) or re.search(r"[\r\n\0]", v):
                    raise SandboxHttpError(
                        f"invalid header {n!r}: name must be an RFC 7230 token and value may not contain CR/LF/NUL"
                    )
                # `-H "name;"` sends an empty-valued header rather than omitting it.
                opts += f" -H {shlex.quote(f'{n};' if v == '' else f'{n}: {v}')}"
        if body is not None:
            opts += f" --data-binary @{data_quoted}"

        # Only force the method where curl can't infer it. ``-X POST`` with
        # ``-L`` replays a bodiless POST through 302/303 redirects (curl keeps the
        # method but drops the body); omitting ``-X`` lets curl switch to GET on
        # those redirects like browsers/httpx do. GET and a body-carrying POST are
        # curl's defaults, so they need no ``-X``.
        if is_head:
            method_opt = "--head"
        elif method == "GET" or (method == "POST" and body is not None):
            method_opt = ""
        else:
            method_opt = f"-X {method}"

        # Cap the response body (not meaningful for HEAD, which carries none).
        cap = None if is_head else max_bytes

        base_curl = (
            f"curl -sSL -g {method_opt} --proto '=http,https' --proto-redir '=http,https'{opts} -D {header_quoted}"
        )
        if cap is not None:
            # Bound the download: pipe the body through ``head -c`` so curl is stopped at the cap (head closes
            # the pipe, curl exits 23) rather than buffering the whole response; the pipeline's status is head's,
            # so curl's code goes to a file and the resolved URL is tagged onto stderr to keep stdout pure body.
            cmd = (
                f"{{ {base_curl} -o - -w '%{{stderr}}{_URL_MARKER}%{{url_effective}}'"
                f" -- {shlex.quote(url)}; echo $? > {rc_quoted}; }}"
                f" 2> {err_quoted} | head -c {cap + 1} > {body_quoted}"
            )
        else:
            out_target = "/dev/null" if is_head else body_quoted
            cmd = f"{base_curl} -o {out_target} -w '%{{url_effective}}' -- {shlex.quote(url)}"
            if not is_head:
                # curl omits the -o file for a bodyless response (e.g. 304 Not Modified);
                # pre-create it so the read-back always finds a (possibly empty) file.
                cmd = f": > {body_quoted} && {cmd}"

        # Give curl a few extra seconds beyond its own --max-time so the
        # sandbox kills it only if curl itself hangs.
        exec_timeout = (timeout + 5) if timeout is not None else None

        try:
            try:
                result = await self.execute(cmd, timeout=exec_timeout, **kwargs)
            except SandboxTimeoutError as exc:
                raise SandboxHttpError(f"request timed out after {timeout}s") from exc

            if cap is not None:
                # The pipeline's status is ``head``'s, so curl's own code is read from its file;
                # the resolved URL and any error text come from the tagged stderr.
                rc_text = (await self.read_file(rc_file)).decode("utf-8", errors="replace").strip()
                err_text = (await self.read_file(err_file)).decode("utf-8", errors="replace")
                resolved_url = _resolve_capped_outcome(rc_text, err_text, result.exit_code, cap, url)
            else:
                if result.exit_code != 0:
                    raise SandboxHttpError(result.stderr.strip() or f"curl exited with code {result.exit_code}")
                resolved_url = result.stdout.strip() or url

            raw_headers = (await self.read_file(header_file)).decode("utf-8", errors="replace")
            status, status_text, response_headers = _parse_status_and_headers(raw_headers)
            response_body = b"" if is_head else await self.read_file(body_file)
            if cap is not None and len(response_body) > cap:
                raise SandboxHttpError(f"response body exceeded max_bytes ({cap})")
        finally:
            with contextlib.suppress(Exception):
                await self.execute(
                    f"rm -f {body_quoted} {header_quoted} {data_quoted} {rc_quoted} {err_quoted}",
                    timeout=10,
                )

        return HttpResult(
            status=status,
            status_text=status_text,
            resolved_url=resolved_url,
            headers=response_headers,
            body=response_body,
        )
