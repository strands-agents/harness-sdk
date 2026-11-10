/**
 * Shared constants and helpers for the site-wide Python/TypeScript language
 * preference and clipboard interactions used by the landing page and header.
 */

/**
 * localStorage key for the selected language. Derived from Starlight's synced
 * tabs hash of "Python|TypeScript" (djb2 -> "jarkqt"). It is referenced from
 * both processed scripts (via import) and inline scripts (via define:vars), so
 * keep it here as the single source of truth. If Starlight changes its hash
 * format or AutoSyncTabs changes its hash function, update this one place.
 */
export const LANGUAGE_STORAGE_KEY = 'starlight-synced-tabs__jarkqt'

/**
 * Language assumed when no preference is stored yet. Label form ("TypeScript"/
 * "Python") because that is what Starlight's synced tabs write to storage.
 */
export const DEFAULT_LANGUAGE_LABEL = 'TypeScript'

/**
 * Copy text to the clipboard, resolving to whether it succeeded. Returns false
 * instead of throwing when the Clipboard API is unavailable (non-secure
 * contexts) or permission is denied, so callers can avoid showing a success
 * state for a copy that did not happen.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
