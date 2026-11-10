/**
 * Environment detection utilities for tests
 */

/**
 * Detects if the current environment is Node.js
 */
export const isNode =
  typeof process !== 'undefined' && typeof process.versions !== 'undefined' && !!process.versions.node

/**
 * Detects if the current environment is a browser
 */
export const isBrowser = typeof window !== 'undefined'
