# Web Fetch Tool

Fetches an HTTP(S) URL and returns its relevant content. Distinct from the http-request tool, which returns raw response bodies for API calls.

## ⚠️ Security Warning

**This tool makes outbound HTTP requests to URLs chosen by the model.**

- Only use with trusted input
- Requests execute with the network access of the host process
- For production deployments, consider running in a sandboxed environment (containers, VMs, etc.)
- Never expose this tool to untrusted users or untrusted prompt input without additional security measures

## Install

HTML conversion requires the optional `turndown` peer dependency:

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

## API

### `webFetch`

The default tool, produced by `makeWebFetch()` with `mode: 'agentic'` and default limits.

### `makeWebFetch(options?)`

| Option            | Type                      | Default       | Description                                                                             |
| ----------------- | ------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `mode`            | `'markdown' \| 'agentic'` | `'agentic'`   | Extraction mode (see below).                                                            |
| `name`            | `string`                  | `'web_fetch'` | Tool name shown to the model.                                                           |
| `description`     | `string`                  | (built-in)    | Tool description shown to the model. Defaults to a mode-appropriate description.        |
| `maxBytes`        | `number`                  | `5242880`     | Maximum response body size in bytes (5 MiB).                                            |
| `maxContentChars` | `number`                  | `50000`       | Maximum characters of extracted content delivered to the model.                         |
| `model`           | `Model`                   |               | Analyst model for agentic mode. Falls back to the host agent's model when not provided. |

Throws if `maxBytes` or `maxContentChars` is not a positive number.

### Modes

**`markdown`** — Fetches the URL and returns the page content as clean markdown directly in the agent's context. HTML is converted with scripts, styles, and noise stripped; other content types are returned as-is.

**`agentic`** — Fetches the URL and routes the content through a dedicated analyst agent that answers the `prompt` about the page. The full page content never enters the main agent's context window — only the analyst's answer is returned.

### Input — markdown mode

| Property | Type     | Required | Description                                    |
| -------- | -------- | -------- | ---------------------------------------------- |
| `url`    | `string` | Yes      | URL to fetch. Must be `http://` or `https://`. |

### Input — agentic mode

| Property | Type     | Required | Description                                     |
| -------- | -------- | -------- | ----------------------------------------------- |
| `url`    | `string` | Yes      | URL to fetch. Must be `http://` or `https://`.  |
| `prompt` | `string` | Yes      | Question or instruction about the page content. |

### Output

Both modes return a string. Markdown mode returns the extracted page content; agentic mode returns the analyst's answer.

## What it does not do

This is a one-shot GET: no caching, cookies, or auth handling. JavaScript is not executed, so dynamic pages that build their content from client-side scripts will return only the initial HTML shell; use a headless browser tool if you need the rendered page. There is no robots.txt handling here. That policy belongs at a higher level, in agent hooks or the caller's own gating.
