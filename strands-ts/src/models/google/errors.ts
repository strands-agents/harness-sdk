/**
 * Error handling utilities for the Google model provider.
 *
 * @internal This module is not part of the public API.
 */

import { ApiError } from '@google/genai'
import { logger } from '../../logging/logger.js'

/**
 * Recognized error types from Google GenAI API responses.
 *
 * This union type will expand as more error types are supported
 * (e.g., 'throttling', 'invalidRequest').
 */
export type GoogleErrorType = 'contextOverflow' | 'throttling'

/**
 * Configuration for handling a specific error status.
 * If messagePatterns is provided, the error message must match one of the patterns.
 * If messagePatterns is not provided, the status alone triggers the error type.
 */
export interface ErrorStatusConfig {
  type: GoogleErrorType
  messagePatterns?: Set<string>
}

/**
 * Mapping of Google GenAI API error statuses to error handling configuration.
 * Maps status codes to either direct error types or message-pattern-based detection.
 */
export const ERROR_STATUS_MAP: Record<string, ErrorStatusConfig> = {
  INVALID_ARGUMENT: {
    type: 'contextOverflow',
    messagePatterns: new Set(['exceeds the maximum number of tokens']),
  },
  RESOURCE_EXHAUSTED: {
    type: 'throttling',
  },
  UNAVAILABLE: {
    type: 'throttling',
  },
}

/**
 * Classifies a Google GenAI API error based on HTTP code, status, and message patterns.
 * Returns the error type if recognized, undefined otherwise.
 *
 * @param error - The error to classify
 * @returns The error type if recognized, undefined otherwise
 *
 * @internal
 */
export function classifyGoogleError(error: Error): GoogleErrorType | undefined {
  // A non-JSON 429 body carries the reason phrase as its status, so classify on the HTTP code
  if (error instanceof ApiError && error.status === 429) {
    return 'throttling'
  }

  if (!error.message) {
    return undefined
  }

  let status: string
  let message: string

  try {
    const parsed = JSON.parse(error.message)
    status = parsed?.error?.status || ''
    message = parsed?.error?.message || ''
  } catch {
    logger.debug(`error_message=<${error.message}> | google genai api returned non-json error`)
    return undefined
  }

  const config = ERROR_STATUS_MAP[status.toUpperCase()]
  if (!config) {
    return undefined
  }

  // If no message patterns required, status alone determines the error type
  if (!config.messagePatterns) {
    return config.type
  }

  // Check if message matches any of the patterns
  const lowerMessage = message.toLowerCase()
  for (const pattern of config.messagePatterns) {
    if (lowerMessage.includes(pattern)) {
      return config.type
    }
  }

  return undefined
}
