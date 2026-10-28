import type { SourceLink } from '../content.config'

/**
 * Maps a source file extension to its SDK language. The language a `sourceLink`
 * points at is normally derivable from the path itself (a `.py` file is Python,
 * a `.ts` file is TypeScript), so we infer it rather than making every doc page
 * repeat it. A page can still set `language` explicitly to override this — see
 * `resolveLanguage`.
 *
 * Keyed by lowercase canonical language code. `LANGUAGE_LABELS` maps the same
 * codes to their display form.
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  py: 'python',
  ts: 'typescript',
  tsx: 'typescript',
}

/** Display labels for known SDK language codes. */
const LANGUAGE_LABELS: Record<string, string> = {
  python: 'Python',
  typescript: 'TypeScript',
}

/** Lowercase file extension of a path, or '' if it has none. */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * Resolve the language code for a source link: the explicit `language` if set,
 * otherwise inferred from the file extension.
 *
 * Throws if neither is available — a path with an unmapped extension and no
 * explicit `language` is an authoring error, surfaced at build time rather than
 * silently rendering an unlabeled link.
 */
export function resolveLanguage(link: SourceLink): string {
  if (link.language) return link.language
  const inferred = EXTENSION_TO_LANGUAGE[extensionOf(link.path)]
  if (inferred) return inferred
  throw new Error(
    `sourceLink "${link.path}" has an unrecognized file extension; ` +
      `add it to EXTENSION_TO_LANGUAGE or set "language" explicitly on the link.`
  )
}

/** Human-readable label for a language code (capitalized fallback if unknown). */
export function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language.toLowerCase()] ?? language.charAt(0).toUpperCase() + language.slice(1)
}

/** Full GitHub blob URL for a source link. */
export function sourceLinkUrl(link: SourceLink): string {
  return `https://github.com/strands-agents/${link.repo}/blob/main/${link.path}`
}
