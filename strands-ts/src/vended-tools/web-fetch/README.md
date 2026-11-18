# Web Fetch Tool

Fetches an HTTP(S) URL and returns its relevant content. Distinct from the http-request tool, which returns raw response bodies for API calls.

## ⚠️ Security Warning

**This tool makes outbound HTTP requests to URLs chosen by the model.**

- Only use with trusted input
- Requests execute with the network access of the host process. With `sandbox: true` they run through the agent's sandbox instead and are confined only as far as that sandbox is
- For production deployments, consider running in a sandboxed environment (containers, VMs, etc.)
- Never expose this tool to untrusted users or untrusted prompt input without additional security measures

## Install

HTML conversion requires the optional `turndown` peer dependency, which is loaded on the first HTML conversion:

```bash
npm install turndown
```

## Usage

Default instance (agentic mode):

```typescript
import { Agent } from '@strands-agents/sdk'
import { webFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

const agent = new Agent({ tools: [webFetch] })
await agent.invoke('Summarize https://example.com/blog/post')
```

Markdown mode:

```typescript
import { Agent } from '@strands-agents/sdk'
import { makeWebFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

const webFetch = makeWebFetch({ mode: 'markdown' })
const agent = new Agent({ tools: [webFetch] })
```

Custom analyst model and tighter limits:

```typescript
import { Agent } from '@strands-agents/sdk'
import { makeWebFetch } from '@strands-agents/sdk/vended-tools/web-fetch'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'

const webFetch = makeWebFetch({
  mode: 'agentic',
  maxBytes: 1 * 1024 * 1024,
  maxContentChars: 25_000,
  model: new BedrockModel({ modelId: 'us.amazon.nova-micro-v1:0' }),
})
const agent = new Agent({ tools: [webFetch] })
```

Sending the request through the agent's sandbox:

```typescript
import { Agent } from '@strands-agents/sdk'
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'
import { makeWebFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

const agent = new Agent({
  sandbox: new DockerSandbox({ container: 'my-container-id' }),
  tools: [makeWebFetch({ sandbox: true })],
})
```

## API

### `webFetch`

The default tool, produced by `makeWebFetch()` with `mode: 'agentic'` and default limits.

### `makeWebFetch(options?)`

| Option            | Type                      | Default       | Description                                                                                  |
| ----------------- | ------------------------- | ------------- | -------------------------------------------------------------------------------------------- |
| `mode`            | `'markdown' \| 'agentic'` | `'agentic'`   | Extraction mode (see below).                                                                 |
| `name`            | `string`                  | `'web_fetch'` | Tool name shown to the model.                                                                |
| `description`     | `string`                  | (built-in)    | Tool description shown to the model. Defaults to a mode-appropriate description.             |
| `maxBytes`        | `number`                  | `5242880`     | Maximum response body size in bytes (5 MiB).                                                 |
| `maxContentChars` | `number`                  | `50000`       | Maximum characters of extracted content delivered to the model.                              |
| `model`           | `Model`                   |               | Analyst model for agentic mode. Falls back to the host agent's `auxModel` when not provided. |
| `sandbox`         | `boolean`                 | `false`       | Run the request through the agent's sandbox (see below).                                     |

Throws if `maxBytes` is not a positive integer, `maxContentChars` is not a positive number, or `sandbox` is not a boolean.

### Where the request runs

By default the request is sent with global `fetch` from the agent process and does not go through the agent's sandbox.

With `sandbox: true` the request runs as `curl` through the host agent's sandbox, so it is confined only as far as that sandbox is. With no sandbox configured, the agent's default local environment runs `curl` on the host. The sandbox must provide `curl`, `head`, and `base64` when its shell is POSIX, or `curl.exe` when it is PowerShell.

Both follow redirects, reject bodies over `maxBytes`, and stop the request 30 seconds after it starts.

### Modes

**`markdown`** — Fetches the URL and returns the page content as clean markdown directly in the agent's context. HTML is converted with scripts, styles, and noise stripped; other content types are returned as-is.

**`agentic`** — Fetches the URL and routes the content through a dedicated analyst agent that answers the `prompt` about the page. Only the analyst's answer is returned, keeping the page out of the main agent's context window.

In agentic mode an empty `prompt` skips the analyst and returns the converted page content to the main agent.

### Input — markdown mode

| Property | Type     | Required | Description                                    |
| -------- | -------- | -------- | ---------------------------------------------- |
| `url`    | `string` | Yes      | URL to fetch. Must be `http://` or `https://`. |

### Input — agentic mode

| Property | Type     | Required | Description                                     |
| -------- | -------- | -------- | ----------------------------------------------- |
| `url`    | `string` | Yes      | URL to fetch. Must be `http://` or `https://`.  |
| `prompt` | `string` | No       | Question or instruction about the page content. |

### Output

Both modes return a string. Markdown mode returns the extracted page content; agentic mode returns the analyst's answer, or the extracted page content when `prompt` is empty.

## What it does not do

This is a one-shot GET: no caching, cookies, or auth handling. JavaScript is not executed, so dynamic pages that build their content from client-side scripts will return only the initial HTML shell; use a headless browser tool if you need the rendered page. There is no robots.txt handling here. That policy belongs at a higher level, in agent hooks or the caller's own gating.
