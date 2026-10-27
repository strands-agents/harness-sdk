import type { Sdk } from './changelog'

export interface LegalLink {
  label: string
  href: string
  id?: string
}

export const DEFAULT_ISSUE_REPOSITORY = 'harness-sdk'

/**
 * Repository that owns issues for each docs product. Site-wide pages fall back
 * to the monorepo through DEFAULT_ISSUE_REPOSITORY.
 */
export const PRODUCT_ISSUE_REPOSITORY: Record<string, string> = {
  Harness: 'harness-sdk',
  'Harness SDK': 'harness-sdk',
  Shell: 'shell',
  Box: 'box',
  Evals: 'evals',
}

export function issueRepositoryForProduct(productLabel: string | undefined): string {
  return (productLabel && PRODUCT_ISSUE_REPOSITORY[productLabel]) || DEFAULT_ISSUE_REPOSITORY
}

export function documentationIssueHref(repository: string, pageUrl: string): string {
  const params =
    repository === DEFAULT_ISSUE_REPOSITORY
      ? new URLSearchParams({
          template: 'documentation_improvement.yml',
          'documentation-section': pageUrl,
        })
      : new URLSearchParams({
          title: 'Documentation issue',
          body: `Page: ${pageUrl}\n\nDescribe what should be changed:\n`,
        })
  return `https://github.com/strands-agents/${repository}/issues/new?${params}`
}

export function changelogHrefForProduct(baseHref: string, sdk: Sdk | null | undefined): string {
  return sdk ? `${baseHref}?${new URLSearchParams({ sdk })}` : baseHref
}

// Shared by the homepage footer and the compact docs footer.
export const LEGAL_LINKS: LegalLink[] = [
  { label: 'Privacy', href: 'https://aws.amazon.com/privacy/' },
  { label: 'Site terms', href: 'https://aws.amazon.com/terms/' },
  { label: 'License', href: 'https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE' },
  { label: 'Cookies', href: 'https://aws.amazon.com/legal/cookies/' },
  // Shortbread's click handler (SiteScripts.astro) opens the cookie
  // customization dialog for the element with this id.
  { label: 'Preferences', href: '#', id: 'cookie-preferences' },
]
