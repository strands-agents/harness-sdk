# File Editor Tool

> **Deprecated.** `fileEditor` is deprecated in favor of the focused [`edit`](../edit/README.md) vended tool and will be removed in a future release. Docker and SSH sandboxes still vend it as `sandbox_file_editor` for continuity.

A filesystem editor tool for viewing, creating, and editing files programmatically. Provides string replacement, line insertion, and directory viewing with security validation.

## ⚠️ Security Warning

**This tool reads and writes files at arbitrary absolute paths without sandboxing or workspace restrictions.**

- Only use with trusted input
- File operations execute with the full permissions of the Node.js process
- For production deployments, consider running in a sandboxed environment (containers, VMs, etc.)
- Never expose this tool to untrusted users or untrusted prompt input without additional security measures

## Features

- **View files** with line numbers and optional line range support
- **Create files** with initial content
- **String-based find and replace** with uniqueness validation
- **Line-based text insertion** at any position
- **Directory viewing** up to 2 levels deep (configurable)
- **Configurable file size limits** (default 1MB)

## Installation

```typescript
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { Agent, BedrockModel } from '@strands-agents/sdk'

const agent = new Agent({
  model: new BedrockModel({ region: 'us-east-1' }),
  tools: [fileEditor],
})

await agent.invoke('Create a file /tmp/notes.txt with "# My Notes"')
```

## Commands

### `view`

View file contents with line numbers or list directory contents (up to 2 levels deep).

**Parameters:**

- `path` (string, required): Absolute path to file or directory
- `view_range` (optional): `[start_line, end_line]` (1-indexed, end can be -1 for EOF)

### `create`

Create a new file with content. Creates parent directories if needed.

**Parameters:**

- `path` (string, required): Absolute path for new file
- `file_text` (string, required): Initial content

### `str_replace`

Replace an exact string match in a file. The string must appear exactly once.

**Parameters:**

- `path` (string, required): Absolute path to file
- `old_str` (string, required): Exact string to find
- `new_str` (string, optional): Replacement string

### `insert`

Insert text at a specific line number (0-indexed).

**Parameters:**

- `path` (string, required): Absolute path to file
- `insert_line` (number, required): Line number for insertion (0 = beginning)
- `new_str` (string, required): Text to insert

## Example Usage

```typescript
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { Agent, BedrockModel } from '@strands-agents/sdk'

const agent = new Agent({
  model: new BedrockModel({ region: 'us-east-1' }),
  tools: [fileEditor],
})

// Agent can use natural language
await agent.invoke('Create /tmp/config.json with {"debug": false}')
await agent.invoke('Replace "debug": false with "debug": true in /tmp/config.json')
await agent.invoke('View lines 1-20 of /tmp/config.json')
```

## Security

- Requires absolute paths (must start with `/`)
- Blocks directory traversal attempts (`..`)
- File size limits (default 1MB)
- Clear error messages

## Limitations

- Node.js only (uses filesystem APIs)
- Text files only (UTF-8 encoded)
- Exact string matching (no regex)
- History is session-scoped
