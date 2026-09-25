import { compare, valid } from 'semver'

import { readCliVersion } from './package-version.js'
import { captureNpm } from './npm.js'

export const CLI_PACKAGE = '@strands-agents/cli'

export interface UpdateCheckOptions {
  currentVersion?: string
  resolveLatest?: () => Promise<string>
}

/** Resolves the latest published CLI version when it is newer than this one, or undefined when unknown. */
export async function availableCliUpdate(options: UpdateCheckOptions = {}): Promise<string | undefined> {
  const currentVersion = options.currentVersion ?? readCliVersion()
  if (currentVersion.includes('development')) {
    return undefined
  }
  try {
    const latestVersion = await (options.resolveLatest ?? resolveLatestCliVersion)()
    return compareVersions(latestVersion, currentVersion) === 1 ? latestVersion : undefined
  } catch {
    // Setup stays usable offline; the notice only appears when npm resolves the configured registry.
    return undefined
  }
}

export async function resolveLatestCliVersion(): Promise<string> {
  return publishedVersion(await captureNpm(['view', `${CLI_PACKAGE}@latest`, 'version', '--json'], { timeout: 3_000 }))
}

export function publishedVersion(output: string): string {
  const parsed = JSON.parse(output) as unknown
  if (typeof parsed !== 'string' || !parsed.trim()) {
    throw new Error('npm returned an invalid package version')
  }
  return parsed.trim()
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1
}

/** Orders two versions by semver precedence, or undefined when either is not a valid version. */
export function compareVersions(candidate: string, current: string): -1 | 0 | 1 | undefined {
  return valid(candidate) && valid(current) ? compare(candidate, current) : undefined
}
