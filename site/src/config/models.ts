// Default model shown in the homepage code samples. Bump it here (or set
// PUBLIC_SONNET_MODEL at build time) to update every component sample at once.
// Note: code samples inside the docs (MDX and --8<-- snippet files) are literal
// text a reader copies, so they can't read this constant; bump those with a
// find/replace on the model id.
export const DEFAULT_SONNET_MODEL =
  import.meta.env.PUBLIC_SONNET_MODEL || 'global.anthropic.claude-sonnet-5'
