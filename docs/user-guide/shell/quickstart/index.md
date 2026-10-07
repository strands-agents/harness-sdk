This guide gets you from zero to a running sandboxed command. You’ll install Strands Shell, create a shell with a single bound directory, and run a command against it. By the end you’ll have a working sandbox you can hand to an agent.

Strands Shell offers three surfaces. Pick the one that matches how you build:

-   **MCP server** works with any agent framework that speaks the Model Context Protocol. Nothing to write in your own language.
-   **Python API** embeds the shell directly in a Python program.
-   **Node.js API** embeds the shell directly in a JavaScript or TypeScript program.

## MCP server

The fastest way to give an existing agent a sandboxed shell is the built-in MCP server. It doesn’t need any code, just point your MCP client at the `strands-shell` command and the agent gets four tools (`shell`, `read_file`, `write_file`, `list_dir`).

Add this to your MCP client configuration:

```json
{
  "mcpServers": {
    "shell": {
      "command": "uvx",
      "args": ["strands-shell", "--mcp"]
    }
  }
}
```

This starts a bare in-memory sandbox without access to host files or credentials and uses the [default network policy](/docs/user-guide/shell/configuration/index.md#network-access). To grant additional access, write a [TOML config file](/docs/user-guide/shell/configuration/index.md#toml-configuration) and pass it before the `--mcp` flag:

```json
{
  "mcpServers": {
    "shell": {
      "command": "uvx",
      "args": ["strands-shell", "--config", "sandbox.toml", "--mcp"]
    }
  }
}
```

The [MCP Server](/docs/user-guide/shell/mcp-server/index.md) page documents the four tools, their parameters, and how to expose other MCP servers as Lua modules inside the shell.

## Python

Install the shell, using Python 3.10 or later:

```bash
pip install strands-shell
```

Create a shell, bind a directory into it, and run a command. Only bound directories are visible inside the sandbox, so `/my/project` on your host appears as `/workspace` and the agent can’t see anything else.

```python
import strands_shell

shell = strands_shell.Shell(
    binds=[strands_shell.Bind("/my/project", "/workspace", mode="copy")],
)

result = shell.run("grep -rn TODO /workspace")
print(result.stdout)
```

`run` returns an `Output` with three fields: `stdout`, `stderr`, and `status` (the exit code). It doesn’t raise when a command fails, so check `status` to branch on success.

```python
result = shell.run("test -f /workspace/pyproject.toml")
if result.status == 0:
    print("found pyproject.toml")
```

State carries across calls. Export a variable or change directory in one `run`, and the next `run` sees it.

```python
shell.run("cd /workspace && export PROJECT=demo")
result = shell.run("echo $PROJECT in $(pwd)")
print(result.stdout)

# Typical output:
# demo in /workspace
```

### Reading and writing files

You can touch the sandbox filesystem directly, without going through a shell command. This is the path to use when your own code needs to seed an input file or collect a result.

```python
shell.write_file("/workspace/note.txt", b"hello")
data = shell.read_file("/workspace/note.txt")
print(data.decode())

entries = shell.list_files("/workspace")
for entry in entries:
    print(entry.name)

shell.remove_file("/workspace/note.txt")
```

`read_file` and `write_file` work in bytes; `remove_file` deletes a file from the sandbox. A missing path raises `strands_shell.FileNotFoundError`, which also subclasses the built-in `FileNotFoundError`, so existing error-handling code catches it without a translation shim.

## Node.js

Install the shell using Node.js 18 or later.

```bash
npm install @strands-agents/shell
```

Create a shell with `Shell.create`, which returns a promise. Then bind a directory, then run a command.

```javascript
import { Shell } from '@strands-agents/shell'

const shell = await Shell.create({
  binds: [{ source: '/my/project', destination: '/workspace', mode: 'copy' }],
})

const result = await shell.run('grep -rn TODO /workspace')
console.log(result.stdout)
```

Every method returns a promise. `run` resolves to an `Output` with `stdout`, `stderr`, and `status`, and it resolves even when the command exits non-zero, so check `status` rather than catching an error.

```javascript
const result = await shell.run('test -f /workspace/package.json')
if (result.status === 0) {
  console.log('found package.json')
}
```

### Reading and writing files

File operations take and return `Uint8Array`. A missing path rejects with `NotFoundError`, which carries a `.code` of `'ENOENT'` and the offending `.path`.

```javascript
const enc = new TextEncoder()
const dec = new TextDecoder()

await shell.writeFile('/workspace/note.txt', enc.encode('hello'))
const data = await shell.readFile('/workspace/note.txt')
console.log(dec.decode(data))

const entries = await shell.listFiles('/workspace')
for (const entry of entries) {
  console.log(entry.name)
}

await shell.removeFile('/workspace/note.txt')
```

`removeFile` deletes a file from the sandbox and rejects with `NotFoundError` when the path is missing, the same as `readFile`.

## What you built

You created a sandbox with exactly one host directory visible to it and ran a command without exposing your home directory or credentials. Network access follows the [default policy](/docs/user-guide/shell/configuration/index.md#network-access). You add capability by adding binds, credentials, and allowed URLs.

## Next steps

-   [Configuration](/docs/user-guide/shell/configuration/index.md): the difference between `copy` and `direct` binds, credential injection, the network allowlist, and the TOML format.
-   [Commands](/docs/user-guide/shell/commands/index.md): which commands and flags are supported, and where they diverge from GNU coreutils.
-   [Security Model](/docs/user-guide/shell/security/index.md): what the sandbox guarantees, what it doesn’t, and when to add OS-level isolation.

## Related pages

- [Choosing an Agent Foundation](/docs/user-guide/migrate/choosing-an-agent-foundation/index.md) (1 shared tag)
- [Get started](/docs/user-guide/sdk/quickstart/overview/index.md) (1 shared tag)
- [Get started with Strands Box](/docs/user-guide/box/getting-started/index.md) (1 shared tag)
- [Python Quickstart](/docs/user-guide/sdk/quickstart/python/index.md) (1 shared tag)
- [Strands evaluation quickstart](/docs/user-guide/evals-sdk/quickstart/index.md) (1 shared tag)
- [TypeScript Quickstart](/docs/user-guide/sdk/quickstart/typescript/index.md) (1 shared tag)
- [Red teaming quickstart](/docs/user-guide/evals-sdk/red-teaming/quickstart/index.md) (1 shared tag)
- [Build a Voice Agent](/docs/user-guide/sdk/bidi/quickstart/index.md) (1 shared tag)
