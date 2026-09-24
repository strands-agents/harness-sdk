import { AWS_ICON } from './icons'

// Canonical registry of catalog integration types: filter value, display
// labels, and a 24x24 single-path glyph (fill=currentColor) rendered in cards
// and facet chips. The zod enum in src/content.config.ts lists the same
// values — keep the two in sync.

export const CATALOG_TYPES = [
  {
    value: 'model-provider',
    label: 'Model Provider',
    labelPlural: 'Model Providers',
    // chat bubble with sparkle
    icon: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 11.5L10.5 10 7 8.5 10.5 7 12 3.5 13.5 7 17 8.5 13.5 10 12 13.5z',
  },
  {
    value: 'tool',
    label: 'Tool',
    labelPlural: 'Tools',
    // wrench
    icon: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z',
  },
  {
    value: 'session-manager',
    label: 'Session Manager',
    labelPlural: 'Session Managers',
    // clock with refresh arrows
    icon: 'M13 3a9 9 0 0 0-9 9H1l3.9 3.9L9 12H6a7 7 0 1 1 7 7 6.9 6.9 0 0 1-4.9-2L6.7 18.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8z',
  },
  {
    value: 'memory-store',
    label: 'Memory Store',
    labelPlural: 'Memory Stores',
    // database
    icon: 'M12 2C7.6 2 4 3.6 4 5.5v13C4 20.4 7.6 22 12 22s8-1.6 8-3.5v-13C20 3.6 16.4 2 12 2zm0 2c3.9 0 6 1.2 6 1.5S15.9 7 12 7 6 5.8 6 5.5 8.1 4 12 4zm6 14.5c0 .3-2.1 1.5-6 1.5s-6-1.2-6-1.5V16c1.5.9 3.7 1.4 6 1.4s4.5-.5 6-1.4v2.5zm0-5c0 .3-2.1 1.5-6 1.5s-6-1.2-6-1.5V11c1.5.9 3.7 1.4 6 1.4s4.5-.5 6-1.4v2.5zm0-5C18 8.8 15.9 10 12 10S6 8.8 6 8.5V7.6C7.5 8.5 9.7 9 12 9s4.5-.5 6-1.4v.9z',
  },
  {
    value: 'storage',
    label: 'Storage',
    labelPlural: 'Storage',
    // hard drive: rounded enclosure with indicator dot and activity bar
    icon: 'M20 4H4C2.9 4 2 4.9 2 6v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zm-2-3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM6 13h8v2H6v-2z',
  },
  {
    value: 'integration',
    label: 'Integration',
    labelPlural: 'Integrations',
    // puzzle piece
    icon: 'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-2 .9-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20c0 1.1.9 2 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z',
  },
  {
    value: 'plugin',
    label: 'Plugin',
    labelPlural: 'Plugins',
    // plug
    icon: 'M16 7V3h-2v4h-4V3H8v4H6v6a5 5 0 0 0 4 4.9V21h4v-3.1A5 5 0 0 0 18 13V7h-2z',
  },
  {
    value: 'agent-extension',
    label: 'Agent Extension',
    labelPlural: 'Agent Extensions',
    // layered squares
    icon: 'M11 1 2 6l9 5 9-5-9-5zM2 12l9 5 9-5M2 18l9 5 9-5',
  },
  {
    value: 'intervention',
    label: 'Intervention',
    labelPlural: 'Interventions',
    // plain shield — the shield-check variant is reserved for the Verified badge
    icon: 'M12 1 3 5v6c0 5.6 3.8 10.7 9 12 5.2-1.3 9-6.4 9-12V5l-9-4z',
  },
] as const

export const TYPE_LABELS: Record<string, string> = Object.fromEntries(CATALOG_TYPES.map((t) => [t.value, t.label]))
export const TYPE_ICONS: Record<string, string> = Object.fromEntries(CATALOG_TYPES.map((t) => [t.value, t.icon]))

// Maintainer tiers, highest commitment first: who stands behind an
// integration and what support users can infer. `label` names the facet chip;
// `flag` names the card badge (an SDK entry's badge reads "Built-in", not the
// team name). Values match the zod enum in src/content.config.ts — keep the
// two in sync.
export const MAINTAINED_BY_TIERS = [
  { value: 'strands', label: 'Strands', flag: 'Built-in', title: 'Built into the Strands Harness SDK' },
  { value: 'aws', label: 'AWS', flag: 'AWS', title: 'Maintained by AWS' },
  { value: 'partner', label: 'Partner', flag: 'Partner', title: 'Maintained by the partner behind the integration' },
  { value: 'community', label: 'Community', flag: 'Community', title: 'Maintained by a community developer' },
] as const

export const MAINTAINED_BY_FLAGS: Record<string, string> = Object.fromEntries(
  MAINTAINED_BY_TIERS.map((t) => [t.value, t.flag])
)
export const MAINTAINED_BY_TITLES: Record<string, string> = Object.fromEntries(
  MAINTAINED_BY_TIERS.map((t) => [t.value, t.title])
)
/** Tier glyphs for facet chips; only AWS carries a brand mark. */
export const MAINTAINED_BY_ICONS: Record<string, string> = { aws: AWS_ICON }
/** Crops AWS_ICON's square canvas to the mark's measured bounds (y 4.8-19.2). */
export const AWS_MARK_VIEWBOX = '0 4.6 24 14.8'

/** Shield-check glyph for the verified badge (cards and the verified facet). */
export const VERIFIED_ICON =
  'M12 1 3 5v6c0 5.6 3.8 10.7 9 12 5.2-1.3 9-6.4 9-12V5l-9-4zm-1.5 15L7 12.5 8.4 11l2.1 2.1 5.1-5.1L17 9.4 10.5 16z'

/** A facet choice (value + display label) with its entry count. */
export interface FacetOption {
  value: string
  label: string
  count: number
}
