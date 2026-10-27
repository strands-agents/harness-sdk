# File Editor Tool

A filesystem editor for viewing, creating, and editing files. All I/O routes through the agent's configured `Sandbox`, so isolation is a property of the sandbox rather than the tool.

The tool exposes six commands: `view` (file contents with line numbers, or a two-level directory listing), `create` (refuses to overwrite), `str_replace` (exact-match; ambiguous matches require `replace_all: true`), `insert` (0-indexed line insertion), `find_line` (returns every matching line, up to a cap, with optional whitespace-tolerant `fuzzy` matching), and `undo_edit` (single-step, in-memory revert of the most recent edit for a path). Paths must be absolute and free of `..` segments. Binary files and files above the size cap are rejected with a clean error.

Undo history is per calling agent — two agents sharing one editor instance never see each other's snapshots. The pre-edit snapshot is captured only after the write to disk succeeds, so a transient write failure leaves the previous undo entry retryable.

## Usage

```typescript
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { Agent, BedrockModel } from '@strands-agents/sdk'

const agent = new Agent({
  model: new BedrockModel({ region: 'us-east-1' }),
  tools: [fileEditor],
})

await agent.invoke('Create a file /tmp/notes.txt with "# My Notes"')
```

## Customization

`makeFileEditor` accepts:

- `root` (string, optional): confines every operation to an absolute directory. Applies a string-level check and, when the target exists on the local filesystem, a `realpath`-based symlink check. `root` must resolve on the local host — a container-side path in a Docker/SSH sandbox fails closed because the local process cannot canonicalize container-side symlinks. Route through the sandbox without `root` and rely on the sandbox's own path policy, or construct the editor inside the sandbox.
- `maxFileSize` (number, optional): byte cap on files that can be read or written, and on the projected byte size of any edit's output. Defaults to 1 MB.
- `maxUndoEntries` (number, optional): maximum distinct paths retained in the per-agent in-memory undo history. Defaults to 32.
- `maxUndoBytes` (number, optional): approximate byte cap on the per-agent undo history. Defaults to 32 MB.
- `name`, `description`: override the tool's registered name and description.

```typescript
import { makeFileEditor } from '@strands-agents/sdk/vended-tools/file-editor'

const editor = makeFileEditor({ root: '/workspace', maxFileSize: 5 * 1024 * 1024 })
```
