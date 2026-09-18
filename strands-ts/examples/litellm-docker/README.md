# LiteLLM Docker smoke test

This script starts the official LiteLLM proxy image, routes it to a local
OpenAI-compatible streaming fixture, and consumes the response through the
TypeScript `LiteLLMModel`.

Run it from the repository root after building the SDK:

```bash
npm run build -w strands-ts
node --experimental-strip-types strands-ts/examples/litellm-docker/index.ts
```

The fixture keeps the check deterministic and does not require a paid provider
API key. It verifies the Docker gateway, proxy authentication, OpenAI-compatible
routing, SSE streaming, and the SDK's streamed text mapping.

The script uses Docker host networking so the container can reach the local
fixture; this is intended for Linux development environments.
