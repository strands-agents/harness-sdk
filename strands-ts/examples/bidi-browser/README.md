# Bidi agent in the browser

A voice agent that runs entirely in the page, no server: `BidiAgent` + `BrowserAudioIO` (microphone and
speaker, with the browser's echo cancellation) + `BrowserSandbox` (notes stored in the browser, or in a
local folder you pick). Choose Amazon Nova Sonic, OpenAI Realtime, or Gemini Live and paste credentials.

```bash
npm install
npm run dev        # open http://localhost:5173
```

Then pick a provider, fill in its credentials, click **Start talking**, and allow microphone access.

| Provider | Credentials |
|---|---|
| Nova Sonic | Region plus an AWS access key ID, secret, and (for temporary credentials) session token with `bedrock:InvokeModelWithBidirectionalStream` |
| OpenAI Realtime | An API key, or an ephemeral `ek_…` client secret from `POST /v1/realtime/client_secrets` |
| Gemini Live | A Gemini API key |

Try: "What time is it in Tokyo?", "Roll two dice", "Save a note called groceries: milk and eggs", then
"Read my groceries note", or "Use JavaScript to compute 17 factorial" (runs in a Web Worker via the sandbox).

Credentials stay in page memory and go directly to the provider. This is for local development: in
production, mint short-lived credentials on a server (Cognito for AWS, client secrets for OpenAI,
ephemeral tokens for Gemini) instead of pasting long-lived keys into a page.

Use headphones or a laptop's built-in speakers; the browser's echo cancellation keeps the agent from
hearing itself, but loud external speakers can still leak through.
