export interface LegalLink {
  label: string
  href: string
  id?: string
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
