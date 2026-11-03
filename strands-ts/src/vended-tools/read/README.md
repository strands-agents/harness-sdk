# Read Tool

A sandbox-routed tool that reads a file. Text files return `cat -n` style numbered lines so the model can cite `path:line`, with `offset`/`limit` paging for large files. Images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return as media content blocks the model can view directly.

The tool reads through a [Sandbox](../../sandbox/base.ts), so behaviour is identical on the host and in Docker/SSH containers. Paths must be absolute and must not contain `..` segments.

Supersedes the [`fileEditor`](../file-editor/README.md) `view` command. Pairs with the companion `edit` and `write` vended tools.

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { read } from '@strands-agents/sdk/vended-tools/read'

const agent = new Agent({ tools: [read] })
await agent.invoke('Read /etc/hosts and summarize what it maps.')
```

With a sandbox bound at creation time:

```typescript
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'
import { makeRead } from '@strands-agents/sdk/vended-tools/read'

const sandbox = new DockerSandbox({ container: 'my-container' })
const readTool = makeRead(sandbox)
```

Without a bound sandbox, the tool reads `context.agent.sandbox` at call time. The built-in sandboxes do not vend `read` automatically; register it yourself.

For a model that rejects image and document blocks:

```typescript
const textOnlyRead = makeRead({ media: false })
```

## API

### `read`

The default tool, produced by `makeRead()`.

### `makeRead(options?)` / `makeRead(sandbox, options?)`

| Option          | Type      | Default                                       | Description                                                                                                     |
| --------------- | --------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `media`         | `boolean` | `true`                                        | Return images and documents as media blocks. When `false`, those files return a short text placeholder instead. |
| `name`          | `string`  | `'read'`                                      | Tool name.                                                                                                      |
| `description`   | `string`  | `DEFAULT_READ_DESCRIPTION` (+ media sentence) | Description shown to the model. The default mentions media only when `media` is on.                             |
| `maxBytes`      | `number`  | `1048576` (1MB)                               | Maximum size of the returned text window. Raise it to read large single-line files (minified JSON, etc.).       |
| `maxMediaBytes` | `number`  | `10485760` (10MB)                             | Maximum size of an image or document read.                                                                      |

### Input

```typescript
{
  path: string // Absolute path to the file
  offset?: number // 1-indexed line to start from. Defaults to the first line. Text files only
  limit?: number // Maximum number of lines to return. Defaults to 2000. Text files only
}
```

### Return Value

- **Text files**: numbered lines, `     1\tfirst line` style (`cat -n`). When the window does not cover the whole file, a trailing `[Showing lines A-B of N. Use offset/limit to read more.]` line is appended. An `offset` past the end returns `[File has N lines; offset X is past the end.]`.
- **Images** (`media: true`): an `ImageBlock`. The format comes from the file's magic bytes, not its extension.
- **Documents** (`media: true`): a `DocumentBlock` whose `name` is the filename sanitized to Bedrock's allowed characters.
- **Images and documents** (`media: false`): `[Image file: <path> (<format>, <N> bytes). ...]` / `[Document file: ...]` placeholders.

Which path a file takes is chosen by extension. Text-representable formats (csv, html, txt, md, json, ...) stay on the numbered-lines path.

### Error Handling

The tool throws when:

- `path` is not absolute (POSIX `/`, a Windows drive letter, or a UNC share) or contains a `..` segment.
- `offset` or `limit` is not a positive integer.
- A file with an image extension does not start with a png/jpeg/gif/webp signature, or a file with a document extension does not match its format's magic bytes (`%PDF-`, OLE2, ZIP). This guard runs even when `media` is `false`, so a mislabeled file never reaches history as a success media block.
- The requested text window exceeds `maxBytes`, or an image/document exceeds `maxMediaBytes` (with `media: true`; with `media: false` the placeholder is returned instead).
- A text file is not valid UTF-8. A leading byte-order mark is kept as `\uFEFF` in line 1 rather than stripped.

## Security

This tool reads files at arbitrary absolute paths with the full permissions of the process. Only use with trusted input and consider running in a sandboxed environment for production.
