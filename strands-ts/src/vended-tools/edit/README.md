# Edit Tool

Replaces an exact, unique string in a text file. `old_str` must appear in the file exactly once; the tool errors on zero or multiple occurrences and leaves the file untouched. Paths must be absolute and must not contain `..` segments.

All I/O routes through a [Sandbox](../../sandbox/base.ts): either one bound at creation (as the Docker/SSH sandboxes do in `getTools()`) or the agent's configured sandbox read from `context.agent.sandbox` at call time.

Supersedes the deprecated [`fileEditor`](../file-editor/README.md); companion `read` and `write` vended tools follow.

## ⚠️ Security Warning

**This tool writes files at arbitrary absolute paths with the full permissions of the sandbox.**

- Only use with trusted input
- For production deployments, run against a real sandbox (Docker, SSH) rather than the host filesystem

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { edit } from '@strands-agents/sdk/vended-tools/edit'

const agent = new Agent({ tools: [edit] })
await agent.invoke("In /tmp/hello.txt, replace 'world' with 'Strands'.")
```

Bound to a specific sandbox:

```typescript
import { makeEdit } from '@strands-agents/sdk/vended-tools/edit'
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'

const sandboxEdit = makeEdit(new DockerSandbox({ container: 'my-container' }), { name: 'sandbox_edit' })
```

## API

### `edit`

The default tool, produced by `makeEdit()`. Reads the sandbox from the agent's context at call time.

### `makeEdit(options?)` / `makeEdit(sandbox, options?)`

| Option        | Type     | Default                    | Description                     |
| ------------- | -------- | -------------------------- | ------------------------------- |
| `name`        | `string` | `edit`                     | Tool name.                      |
| `description` | `string` | `DEFAULT_EDIT_DESCRIPTION` | Description shown to the model. |

### Input

| Property  | Type     | Required | Description                                         |
| --------- | -------- | -------- | --------------------------------------------------- |
| `path`    | `string` | Yes      | Absolute path to the file.                          |
| `old_str` | `string` | Yes      | Exact text to find. Must be unique within the file. |
| `new_str` | `string` | Yes      | Replacement text (may be empty to delete).          |

### Output

Returns `"Edited <path>."` on success. Throws if the path is not absolute or contains `..`, if `old_str` is empty, or if `old_str` appears zero or more than one time.
