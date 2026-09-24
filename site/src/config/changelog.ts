export type Sdk = 'sdk' | 'evals'
export type Language = 'python' | 'typescript'

export const LANGUAGE_META: Record<Language, { label: string; short: string }> = {
  python: { label: 'Python', short: 'Py' },
  typescript: { label: 'TypeScript', short: 'TS' },
}

export const SDK_META: Record<Sdk, { label: string; languages: Language[] }> = {
  sdk: { label: 'SDK', languages: ['python', 'typescript'] },
  evals: { label: 'Evals', languages: ['python'] },
}

// The site-wide language preference key + default live in
// util/language-preference.ts (shared with LanguageToggle and the landing page).

/**
 * Canonical human label for a release stream, e.g. "Strands harness Python", "Evals".
 * Single source so the detail page, markdown endpoints, RSS, and llms.txt don't
 * each hand-roll it (they previously drifted between "Strands harness Python" and
 * "Strands harness (python)").
 */
export function streamLabel(sdk: Sdk, language?: Language): string {
  return [SDK_META[sdk].label, language ? LANGUAGE_META[language].label : ''].filter(Boolean).join(' ')
}

// Package-registry URL construction lives in the devtools changelog-release-pr
// action (the producer of `packageUrl` frontmatter) — not duplicated here.
