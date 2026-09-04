import type { Model } from '../../models/model.js'

/**
 * Input parameters for the markdown mode web fetch tool.
 */
export interface WebFetchMarkdownInput {
  /** URL to fetch. Must be http:// or https://. */
  url: string
}

/**
 * Input parameters for the agentic mode web fetch tool.
 */
export interface WebFetchAgenticInput {
  /** URL to fetch. Must be http:// or https://. */
  url: string
  /** Question or instruction about the page content. */
  prompt: string
}

export const WEB_FETCH_DESCRIPTION_MARKDOWN =
  'Fetches an HTTP(S) URL and returns its content as clean markdown. ' +
  'HTML pages are converted to markdown with scripts, styles, and noise stripped; ' +
  'other content types are returned as-is.'

export const WEB_FETCH_DESCRIPTION_AGENTIC =
  'Fetches an HTTP(S) URL and answers a prompt about its content. ' +
  'The analyst processes the page directly so the full content never enters ' +
  "the main agent's context. " +
  'The prompt parameter is required.'

/**
 * Options for {@link makeWebFetch}.
 */
export interface MakeWebFetchOptions {
  /** Tool name shown to the model. Defaults to `'web_fetch'`. */
  name?: string
  /** Tool description shown to the model. Defaults to a mode-appropriate description. */
  description?: string
  /** Maximum response body size in bytes. Defaults to 5 MiB. */
  maxBytes?: number
  /** Maximum characters of extracted content delivered to the model. Defaults to 50,000. */
  maxContentChars?: number
  /**
   * Optional model for the analyst agent. Only used when `mode` is `'agentic'`.
   * Falls back to the host agent's model when not provided.
   */
  model?: Model
  /** Extraction mode. Defaults to `'agentic'`. */
  mode?: 'markdown' | 'agentic'
}
