# Sandboxed HTTP Request

**Status**: Proposed

**Date**: 2026-10-01

## Problem

The `Sandbox` abstraction puts a boundary around what an agent's tools can do. However, HTTP is missing; tools that want to sandbox their HTTP calls must hand-roll their own implementations with the existing execution and filesystem methods.

### Current State

`Sandbox` (`strands/sandbox/base.py`) vends `execute`, `execute_code`, `read_file`, `write_file`, `remove_file`, `list_files`, all crossing into the backend. There is no HTTP method among them.

The harness's `web_fetch` tool fetches with `curl` inside the agent's sandbox by default. This ensures the source address matches the sandbox rather than the host and prevents the tool from probing other host-local services. But with no primitive to lean on, the tool hand-rolls the whole curl-based fetch. The relevant code is shown below, rewritten for clarity:

```python
# harness-py/src/strands_harness/tools/web_fetch.py
cmd = (f"curl -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' --max-time {_TIMEOUT} "
       f"-A {shlex.quote(_USER_AGENT)} -o {out} -w '%{{content_type}}\\n%{{url_effective}}' -- {shlex.quote(url)} "
       f"&& head -c {_MAX_BYTES} {out} > {part} && mv -f {part} {out}")
result = await sandbox.execute(cmd, timeout=_TIMEOUT + 5)
content_type, resolved_url = result.stdout.splitlines()[-2:]
data = await sandbox.read_file(out)
await sandbox.execute(f"rm -f {shlex.quote(out)} ...")
```

It works, but every bit of request/response plumbing lives in the tool. It's GET-only, there's no structured status/headers, and anything with a request body or a different method (ex. `http_request` tool) would have to re-implement it.

## Goals

- One sandbox-native HTTP method that network-based tools call, so egress crosses the boundary like every other sandbox operation.
- Integrate sandboxed HTTP into `web_fetch` and `http_request` vended tools.
- Support in both the Python and TS SDKs.

## Non-Goals
- Route MCP and A2A through the sandbox. They require long-lived connections, while sandbox's current design only supports one-shot methods.

## Proposal

### Approach 1 (Recommended): Add `request` to `Sandbox`

Add one method to the `Sandbox` ABC, **not** abstract, so HTTP support is opt-in (the base raises `NotImplementedError`):

```python
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
) -> HttpResult: ...

@dataclass
class HttpResult:
    status: int           # final status code (raise if unparseable)
    status_text: str      # reason phrase; "" when omitted
    resolved_url: str     # final URL after redirects
    headers: dict[str, str]  # lowercased keys; repeated headers joined with ","
    body: bytes
```

```ts
async request(
  method: string,
  url: string,
  options?: HttpRequestOptions,
): Promise<HttpResult>

interface HttpRequestOptions {
  headers?: Record<string, string>
  body?: Uint8Array | string
  timeoutMs?: number
  maxBytes?: number
}

interface HttpResult {
  status: number
  statusText: string
  resolvedUrl: string
  headers: Record<string, string>
  body: Uint8Array
}
```

Transport failures (ex. DNS, connect, timeout, size cap) raise `SandboxHttpError`; HTTP error statuses (4xx/5xx) are returned in `status`, not raised, the shape both tools want. `PosixShellSandbox` provides a curl-based implementation on top of the shell primitives it already has, so any POSIX backend gets `request` for free. It treats the model-supplied method, URL, headers, and body as untrusted, and honors `timeout` and `max_bytes` so a response can't hang or flood the sandbox. If those parameters are not specified (None), no timeout or byte cap is applied, similar to the other sandbox methods. Tools then call `sandbox.request(...)` instead of a host client when a sandbox is present.

We implement `NotASandboxLocalEnvironment.request` with the current `httpx.client` (Python) / `fetch` (TS) implementations from the vended tools. We remove the `client` parameter from the Python `web_fetch` and `http_request` tools because the httpx client is not accessible from general sandboxes (ex. `PosixShellSandbox`). In its place, we add `max_bytes` to the `http_request` tool and `headers` to the `web_fetch` tool, to maintain compatibility with the base `request` interface. These tools always route to the agent sandbox. Therefore, `ToolContext` becomes mandatory in both tools (rather than optional like it is now), so developers cannot directly call these tools outside an agent.

**Pros:**

- Closes the containment gap at the boundary tools already respect.
- HTTP logic is consolidated into sandbox rather than scattered between sandbox and tools

**Cons:**

- Adds a `curl` dependency to the sandbox.
- Requires breaking changes to the `web_fetch` and `http_request` tools

### Approach 2: Keep host-side HTTP requests in vended tools

Same as Approach 1, but we leave `NotASandboxLocalEnvironment.request` unimplemented, falling through to the base `NotImplementedError`. The current network-based tools (http_request, web_fetch) keep their own host-side transport via `httpx.client` and `fetch`. Both tools accept a new optional parameter called `transport`. It has two options: `direct` routes to the current httpx client / fetch implementations in the host process, while `sandbox` routes to the agent's sandbox and is the default.

This approach avoids breaking changes in the vended tools. However, it scatters HTTP logic between sandbox/tools and introduces asymmetry, where the `PosixShellSandbox` implements `request` while `NotASandboxLocalEnvironment` does not. Future network-based tools will also need to implement their own host-side HTTP requests.

### Approach 3
The status quo. Each tool that needs sandboxing implements it themselves. This means that we port the curl-based sandbox logic from harness `web_fetch` to the SDK vended `web_fetch` and make no changes to the sandbox. If `http_request` or any future network-based tool needs sandboxing, we implement it directly in the tool. This requires the least changes to the sandbox module, but risks duplicating complex logic between sandbox consumers.

## Developer Experience

```python
result = await sandbox.request("GET", "https://example.com/data.json", max_bytes=1_000_000)
if result.status == 200:
    payload = result.body.decode("utf-8")

try:
    result = await sandbox.request("GET", url, timeout=10)
except SandboxHttpError:
    ...  # DNS/connect/timeout/size cap, or a rejected URL/header/method
else:
    if result.status >= 400:
        ...  # server answered, HTTP error, not transport
```

A rejected URL fails model-actionably, and a backend without support fails loudly rather than silently escaping the sandbox.

## Consequences

- **Easier:** containing network tools in a sandbox; building new ones against one typed `HttpResult`; auditing egress at a single choke point.
- **Cost:** one more optional method for sandbox authors; a `curl` dependency in POSIX backends.
- **Follow-up:** replace harness `web_fetch` with SDK's vended `web_fetch`. The only other feature missing is caching, which seems optional but can be added directly into the vended tool if needed.
