Fetches an HTTP(S) URL and returns its content. Two modes are available, configured at construction time via `make_web_fetch` / `makeWebFetch`:

-   **`agentic`** (default): HTML is converted to markdown and passed to an analyst agent that answers a `prompt`, so the full page never enters the main agent’s context. Use when targeted answers are needed about potentially large pages.
-   **`markdown`**: HTML is converted to clean markdown with scripts, styles, and noise stripped. Use when the agent needs full pages for reasoning.

The `max_bytes` / `maxBytes` parameter caps the HTTP response size (default 5 MiB); `max_content_chars` / `maxContentChars` caps the extracted content delivered to the model or analyst (default 50,000 characters). For `mode='agentic'` / `mode: 'agentic'`, the factory also accepts a `model` for the analyst; `agent.aux_model``agent.auxModel` is used when none is supplied.

The Python tool delegates all networking to an `httpx.AsyncClient`. Use the `make_web_fetch` factory to supply a pre-configured client with custom timeouts, redirects, proxies, or caching.

*Supported in: Node.js (TypeScript); Python (all platforms).*

Install required

(( tab "Python" ))
`web_fetch` requires the optional `web-fetch` extra:

```bash
pip install 'strands-agents[web-fetch]'
```
(( /tab "Python" ))

(( tab "TypeScript" ))
HTML conversion requires the optional `turndown` peer dependency:

```bash
npm install turndown
```
(( /tab "TypeScript" ))

Security posture

Web fetch accepts only `http://` and `https://` URLs and caps response bodies at 5 MiB by default. Egress control belongs at the layer that encapsulates the agent (a sandbox, microVM, or network policy) where it can be enforced consistently across all tools, including `shell`.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { webFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

const agent = new Agent({ tools: [webFetch] })
await agent.invoke('Summarize https://example.com/blog/post')
```

Reading the full page as markdown:

```typescript
import { Agent } from '@strands-agents/sdk'
import { makeWebFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

const webFetch = makeWebFetch({ mode: 'markdown' })
const agent = new Agent({ tools: [webFetch] })
await agent.invoke('Read https://example.com/docs and explain the architecture')
```

Tighter response cap with a dedicated analyst model:

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
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import web_fetch

agent = Agent(tools=[web_fetch])
agent("What is the pricing for the enterprise plan at https://example.com/pricing")
```

Reading the full page as markdown:

```python
from strands import Agent
from strands.vended_tools import make_web_fetch

web_fetch = make_web_fetch(mode="markdown")
agent = Agent(tools=[web_fetch])
agent("Read https://example.com/docs and then explain the architecture")
```

Tighter response cap with a dedicated analyst model and custom transport:

```python
import httpx
from strands import Agent
from strands.models import BedrockModel
from strands.vended_tools import make_web_fetch

web_fetch = make_web_fetch(
    mode="agentic",
    client=httpx.AsyncClient(timeout=10.0),
    max_bytes=1 * 1024 * 1024,
    max_content_chars=25_000,
    model=BedrockModel(model_id="us.amazon.nova-micro-v1:0"),
)
agent = Agent(tools=[web_fetch])
```
(( /tab "Python" ))

📖 [Full API Reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/web-fetch/README.md)

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)
- [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/web-fetch/web-fetch.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/web-fetch/web-fetch.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/web_fetch/web_fetch.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/web_fetch/web_fetch.py)
