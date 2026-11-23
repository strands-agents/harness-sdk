A box runs the agent’s Python scripts in [Monty](https://github.com/pydantic/monty), an interpreter for a subset of Python. Policy decides each file operation a script makes, and the egress gateway decides each request a script sends with `fetch()`.

Audience: an operator with a working box from [getting started](/docs/user-guide/box/core/quickstart/index.md) whose agent runs Python. For how Box runs a script and why a script cannot act on its own, read [how Box runs Python scripts](https://github.com/strands-agents/box/blob/7c4ea75ff509e54298e8a077f6c8e0dae1e8e216/docs/design/monty.md).

## Example

The workspace is `~/src/project`, and it holds `notes.txt` and an empty `out` directory. The agent runs:

```sh
python3 -c "from pathlib import Path
text = Path('notes.txt').read_text()
Path('out/notes.txt').write_text(text.upper())
print('wrote', len(text))"
```

To let the agent run `python3`, and let the script read the project and write in `out`, permit all three in `policy.dw`:

```text
@id("python")
permit (principal, action == Box::Action::"shell:exec", resource)
when { ["python", "python3"].contains(context.input.program) };

@id("project_read")
permit (principal, action == Box::Action::"fs:read", resource)
when {
  context.input.path == "~/src/project" ||
  context.input.path like "~/src/project/*"
};

@id("out_write")
permit (principal, action == Box::Action::"fs:write", resource)
when {
  context.input.path like "~/src/project/out/*" &&
  context.input.operation == Box::FsWriteOperation::"write_content"
};
```

The script writes `~/src/project/out/notes.txt` and exits `0`. Example output:

```text
wrote 18
```

## Python support

A script imports `asyncio`, `base64`, `binascii`, `collections`, `copy`, `dataclasses`, `datetime`, `functools`, `itertools`, `json`, `math`, `os`, `pathlib`, `random`, `re`, `sys`, `time`, `typing`, and `unicodedata`. Any other module, including `subprocess`, `socket`, `urllib`, and every package from PyPI, raises `ModuleNotFoundError`.

A name that Monty does not define, such as `input()`, `memoryview()`, or `__import__()`, raises `NameError`. Each script runs in a new interpreter, so a variable that one script sets is undefined in the next. An uncaught exception prints `<exception type>: <message>` on stderr.

## Running a script

The `python3` and `python` aliases send their name and arguments, unchanged, to Strands Shell. So `python3 report.py` run by the harness and `zsh -c 'python3 report.py'` take one route:

-   **Forms:** `-c SOURCE`, one `SCRIPT` file, `--version` or `-V`, and `--help` or `-h`. The broker puts each argument in single quotes, and each `'` in it takes four bytes, so the whole command must fit the Shell’s [input limit](/docs/user-guide/box/reference/shell/index.md#configuration), 256 KiB by default. A longer `-c SOURCE` exits `1` with `strands-shell: input too large`; put it in a script file.
-   **Working directory:** the directory the alias was run from. A directory other than the workspace takes an `fs:read` decision with operation `change_dir`, as `cd` does.
-   **Script file:** read by Strands Shell from that directory, under an `fs:read` decision. The agent’s own filesystem lists don’t decide it.
-   **Policy decisions:** `shell:exec` for the command, `fs:read` for a script file, and the script’s file operations.

In Strands Shell, `python` and `python3` always run Monty, whatever the operator’s `PATH` holds, and `python3 --version` prints `Monty (Strands-Box Python subset)`. Strands Shell refuses these forms with exit status `2`:

-   `python` alone, or `python` that reads its source from stdin, such as a pipe or a heredoc.
-   `python -`.
-   Any argument after the `-c` source or the script file.

## File operations

Each file operation is one decision, on `context.input.path` and `context.input.operation`. A relative path is rooted at the workspace, even when the script file was found in another directory, and a path under the operator’s home starts with `~/`.

| Python | Action | `operation` |
| --- | --- | --- |
| `Path.read_text()`, `Path.read_bytes()`, `open(path)`, `open(path, "rb")` | `fs:read` | `read_content` |
| `Path.write_text()`, `Path.write_bytes()`, and `open()` in a mode that writes or appends | `fs:write` | `write_content` |
| `os.stat()`, `Path.exists()`, `Path.is_file()`, `Path.is_dir()`, `Path.is_symlink()` | `fs:read` | `read_metadata` |
| `os.listdir()`, `Path.iterdir()` | `fs:read` | `enumerate` |
| `Path.mkdir()` | `fs:write` | `create_dir` |
| `Path.unlink()`, `Path.rmdir()` | `fs:delete` | `remove_file`, `remove_dir` |
| `Path.rename(destination)` | `fs:read` on the source, `fs:move` on each path, and `fs:delete` on a destination that exists | `read_content`, `rename`, and `remove_file` or `remove_dir` |

Each read or write on a handle from `open()` is decided again. `os.stat()` returns the real size and file type, with `st_uid` and `st_gid` set to `0` and `st_nlink` set to `1`.

These raise an error whatever the policy says:

| Python | Raises | Use instead |
| --- | --- | --- |
| `Path.resolve()`, `Path.absolute()` | `RuntimeError: Path.resolve: not supported by this box's Python (Monty)` | The path as written |
| `os.getenv()`, `os.environ` | `RuntimeError: 'os.getenv' is not supported in this environment` | A value in the script’s source |
| `Path.mkdir(parents=True)` | `PermissionError` | One `mkdir()` for each level |
| A path outside the operator’s home and the workspace | `PermissionError: <path>: outside this box's home and every declared bind` | A path under the operator’s home or the workspace |
| A path that is a symbolic link, or has one in it | `PermissionError: <path>: resolves to a different path, so it is not the identity policy judged` | The path of the file the link points to |
| The box directory, or the `box.toml` and `policy.dw` this run loaded | `PermissionError: <path>: resolves into trusted Box state, which no policy may open`, or `resolves to an authority source that this run loaded` | A path outside the box directory |
| A write, deletion, or rename that reaches a configured tool command or its ancestor | `PermissionError` containing `is a configured tool command or its ancestor, which this run does not allow to change` | A path outside the command and its enclosing directories |
| A directory mutation that reaches a hard-link alias for a configured command | `PermissionError` containing `contains a hard link to a configured tool command, so this mutation is not allowed` | A directory without the command’s hard-link names |
| A directory mutation whose hard-link scan cannot finish | `PermissionError` containing `cannot finish checking for configured tool command hard links`, followed by the scan failure | [Correct the reported cause or narrow the directory](/docs/user-guide/box/reference/configuration/index.md#configured-command-integrity) |
| A write, deletion, or rename that changes an installed Box program or an enclosing path | `PermissionError` containing `cannot change a trusted Box executable or its path` | [Update the installation between runs](/docs/user-guide/box/reference/configuration/index.md#installation-integrity) |

A rename can also fail if another operation creates its destination while Box checks policy. Box raises `PermissionError: <destination>: filesystem identity changed during effect admission` and leaves both files in place. Retry the rename to let policy check deletion of the existing destination.

For a destination that does not exist, Box requires an atomic rename that cannot replace an existing name. If the operating system or filesystem rejects that operation, the rename raises `OSError` and changes neither path. Box does not retry with a replacing rename. An overwrite that policy explicitly permits still uses the existing rename operation.

## Time and randomness

Each call in this table takes no policy decision.

| Python | Returns |
| --- | --- |
| `datetime.datetime.now()` | The current time in UTC, with no time zone |
| `datetime.datetime.now(tz)` | The current time in `tz` |
| `datetime.date.today()` | The current date in UTC |
| `time.time()` | Seconds since the Unix epoch |
| `time.monotonic()` | A clock that only moves forward |
| `os.urandom(n)` | `n` random bytes, up to 1 MiB |
| `time.sleep(seconds)`, `asyncio.sleep(seconds)` | After the wait. Two concurrent sleeps take the sum of their waits. |

## `fetch()`

`fetch()` sends one HTTP request through the box’s egress gateway, and returns the response. It is a built-in name, and needs no import.

```python
fetch(url, method="GET", headers=None, body=None)
```

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `url` | `str` | required | An `http` or `https` URL. |
| `method` | `str` | `"GET"` | The HTTP method. |
| `headers` | `dict` of `str` to `str` | `None` | The request headers. |
| `body` | `str` or `bytes` | `None` | The request body. |

Each argument is positional or a keyword. The return value is a `dict`:

| Key | Type | Value |
| --- | --- | --- |
| `status` | `int` | The HTTP status. |
| `headers` | `dict` | The response headers, by lowercase name. A repeated header is one value, joined with `,` , and `set-cookie` values are joined with a newline. |
| `body` | `str` | The response body. |

```python
r = fetch("https://api.github.com/zen", headers={"User-Agent": "notes-script"})
print(r["status"], r["body"])
```

Example output:

```text
200 Mind your words, they are important.
```

| Error | Cause |
| --- | --- |
| `TypeError` | No `url`, an argument of the wrong type, an unknown keyword, more than four positional arguments, or one argument given twice. Nothing is sent. |
| `OSError: access denied: <host>` | The URL’s scheme is not `http` or `https`, or its host is `localhost`, a literal loopback, private, link-local, `0.0.0.0/8`, or one of two cloud metadata addresses outside `169.254.0.0/16`, or an IPv4-mapped, IPv4-compatible, IPv4-translated, 6to4, Teredo, or `64:ff9b::/96` NAT64 address that carries one of these, or any `64:ff9b:1::/48` address. A NAT64 address under a network’s own prefix is not covered. Nothing is sent. |
| `OSError` | The response body is larger than 1 MiB. |
| Status `403`, with header `x-strands-box-egress: refused` | The gateway refused the request, and the body says why. The script receives it as a response, and must check `status`. A `403` without the header comes from the server. |
| Status `502`, with header `x-strands-box-egress: failed` | The gateway didn’t refuse the request but couldn’t complete it, and the body says why. The script receives it as a response, and must check `status`. A `502` without the header comes from the server, or answers a plain `http://` request the gateway couldn’t resolve or connect to. |

## Limits and exit statuses

| Limit | When a script passes it |
| --- | --- |
| 10,000 calls that Box answers, such as file operations and `fetch()` | `RuntimeError`, which the script cannot catch |
| 180 seconds of sleep in total | `TimeoutError`, at once, from the sleep that would pass it |
| 128 MiB in one allocation | `MemoryError`, which the script cannot catch |
| 1 MiB from one `os.urandom()` | `ValueError` |
| 1 MiB in one `fetch()` response body | `OSError` |

| Exit status | Meaning |
| --- | --- |
| `0` | The script completed. |
| `1` | The script raised an exception it did not catch, including a policy refusal and a limit. |
| `2` | A form the command refuses. |
| `125` | Box did not run the script to its end: Box failed, or the call ran longer than [`limits.shell.timeout`](/docs/user-guide/box/reference/shell/index.md#limitsshelltimeout). Box checks that limit only when Monty hands control back, so a script that never pauses, such as `while True: pass`, runs until Monty’s own 120-second limit stops it, however short `limits.shell.timeout` is. |
| `125` | The alias couldn’t tell which directory it was run from, or that directory’s name isn’t valid UTF-8. Nothing ran. |
| `126` | Policy refused `shell:exec` for the command, or Box refused the directory the alias was run from. |

## Policy

Monty raises only `fs:read`, `fs:write`, `fs:delete`, and `fs:move`. A file operation that no `permit` matches is refused. Put a path condition on each `fs:*` permit, as in the [Example](#example): an `fs:read` permit with no path condition reads every file under the operator’s home through Monty. A `forbid` refuses a path whatever another rule permits:

```text
@id("no_keys")
forbid (principal, action in [Box::Action::"fs:read", Box::Action::"fs:write"], resource)
when { context.input.path like "~/.ssh/*" || context.input.path like "~/.aws/*" };
```

To run `python` and `python3`, through the aliases or in Strands Shell, permit `shell:exec` for them:

```text
@id("python_in_shell")
permit (principal, action == Box::Action::"shell:exec", resource)
when { ["python", "python3"].contains(context.input.program) };
```

The egress gateway decides each `fetch()` with `net:connect` and `http:request`, as for the agent’s own requests. To permit a host, write the rules in [the `[egress.<name>]` table](/docs/user-guide/box/guides/network-and-credentials/index.md#example).

| Action | Field | Value |
| --- | --- | --- |
| `fs:read`, `fs:write`, `fs:delete`, `fs:move` | `context.input.path` | The path. See [File operations](#file-operations). |
|  | `context.input.operation` | `Box::FsReadOperation`, `Box::FsWriteOperation`, `Box::FsDeleteOperation`, or `Box::FsMoveOperation`, with a value from the [File operations](#file-operations) table |
| `shell:exec` | `context.input.program` | `python` or `python3`, as typed |
| `net:connect` | `context.input.host`, `context.input.port` | The `fetch()` URL’s host and port |
| `http:request` | `context.input.host`, `context.input.method`, `context.input.path` | The `fetch()` URL’s host, the method, and the URL path |

## Troubleshooting

| The script sees | Cause | Fix |
| --- | --- | --- |
| `PermissionError: policy denied this operation on '<path>' [default-deny]` | No `permit` matches the operation. | Add a `permit` for the action on that path, with `~/` for a path under the operator’s home. |
| `PermissionError: policy denied this operation on '<path>' [policy: <id>]` | The rule with that `@id` refused the operation. | Change the rule, or the path. |
| `fetch()` returns status `403` with header `x-strands-box-egress: refused` | The gateway refused the request. The body says why. | Permit `net:connect` and `http:request` for the host. |
| `strands-shell: effect denied: policy denied this operation on 'python'`, exit status `126` | No `shell:exec` permit names the command. | Permit `shell:exec` for `python` and `python3`. |
| `strands-box: cannot start in <directory>: ...`, exit status `126` | Policy refused `fs:read` with operation `change_dir` on the directory the alias was run from, or the directory is outside the operator’s home, the agent’s home, and the workspace, such as `/tmp`. | Permit `fs:read` on that directory, or run the script from the workspace. |
| `strands-box-sock-alias: read the working directory: ...; set PWD to it`, exit status `125` | The alias could not read which directory it was run from. | Set `PWD` to that directory before running `python3`. |
| `python3: -m is not supported by Monty, Box's built-in Python subset. ...`, or `ModuleNotFoundError` for a package | The script needs real Python, such as `-m pytest` or a package from a venv. | Have the operator set [`monty = false`](/docs/user-guide/box/reference/configuration/index.md#monty), declare a `[tool]` whose command file is named `python3`, grant it `read` on the venv and Python’s install, and permit `shell:spawn` on its file. The `monty` section has a working setup. |

The decision log records each decision with the rule’s `@id` ([getting started](/docs/user-guide/box/core/quickstart/index.md#step-7-read-the-decision-log)).

## See also

-   [How Box runs Python scripts](https://github.com/strands-agents/box/blob/7c4ea75ff509e54298e8a077f6c8e0dae1e8e216/docs/design/monty.md): the routes, the steps for each file operation, and the residual risk.
-   [The `[egress.<name>]` table](/docs/user-guide/box/guides/network-and-credentials/index.md): the rules for a host, and a credential that the gateway adds to a request.