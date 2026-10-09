// The TypeScript SDK's OpenAI, Anthropic, and Google model constructors require an API key at
// construction time (read from these env vars), so resolving those providers needs a key even
// before any request. Provide dummy keys so model-resolution tests can construct them.
process.env.OPENAI_API_KEY ??= 'test-key'
process.env.ANTHROPIC_API_KEY ??= 'test-key'
process.env.GOOGLE_API_KEY ??= 'test-key'
process.env.GEMINI_API_KEY ??= 'test-key'

// The 'bedrock-mantle' provider resolves its AWS region at construction time (unlike BedrockModel,
// which defers to request time), so it needs a region present even before any request.
process.env.AWS_REGION ??= 'us-east-1'

// Telemetry keys off this standard OTEL selector; scrub it so agent-construction tests never stand
// up a real exporter because of the host/CI environment.
delete process.env.OTEL_TRACES_EXPORTER
