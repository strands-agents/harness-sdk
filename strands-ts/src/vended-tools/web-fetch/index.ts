/**
 * Web fetch tool: fetch a URL and return clean markdown suitable for a model to read.
 *
 * Distinct from the http-request tool (raw API calls). See {@link webFetch}.
 */

export { webFetch, makeWebFetch } from './web-fetch.js'
export type { MakeWebFetchOptions } from './types.js'
export type { WebFetchMarkdownInput, WebFetchAgenticInput } from './types.js'
