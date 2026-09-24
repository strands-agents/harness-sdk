/**
 * Redirect helper: maps old MkDocs-style URLs to new CMS slugs or explicit external URLs.
 *
 * resolveRedirectFromUrl normalises a versioned URL to a slug, then
 * resolveRedirect applies rename rules for paths that changed structure.
 *
 * Only explicit rename rules or redirectFromMap may produce external URLs.
 * The path-normalization fallback never returns an external URL (prevents open redirects).
 */

import { exactly, startsWith } from './regex'

// ── Slug-level rename rules ───────────────────────────────────────────────────

/**
 * Exact-match slug renames: old slug → new slug or explicit external URL.
 *
 * Exported so astro.config.mjs (via redirect.static.ts) can enumerate every
 * entry into a build-time redirect stub — a static HTML page with a meta
 * refresh and canonical link. Crawlers don't execute the client-side 404
 * redirect, so these stubs are what preserve backlink equity for renamed pages.
 *
 * Only add enumerable, exact-match renames here. Dynamic rules (regex matches,
 * computed targets) belong in PREFIX_SLUG_RULES below and are handled solely by
 * the client-side 404 fallback.
 */
export const STATIC_SLUG_REDIRECTS: Record<string, string> = {

  // gemini was renamed to google (concepts/ was later consolidated under harness/)
  'docs/user-guide/concepts/model-providers/gemini': 'docs/user-guide/sdk/model-providers/google',

  // bidi model providers renamed to match upstream (#3956)
  'docs/user-guide/concepts/bidirectional-streaming/models/nova_sonic':
    'docs/user-guide/sdk/bidirectional-streaming/models/bedrock',
  'docs/user-guide/concepts/bidirectional-streaming/models/gemini_live':
    'docs/user-guide/sdk/bidirectional-streaming/models/google',
  'docs/user-guide/concepts/bidirectional-streaming/models/openai_realtime':
    'docs/user-guide/sdk/bidirectional-streaming/models/openai',

  // python-tools was renamed to custom-tools
  'docs/user-guide/concepts/tools/python-tools': 'docs/user-guide/sdk/tools/custom-tools',

  // Vanity URLs for community links
  discord: 'https://discord.gg/strands',

  // Campaign short-links → tracked landing pages with UTM baked in, so a source
  // is tracked even when the URL is typed (not clicked). Each emits a build-time
  // redirect stub at /<slug>/; the destination's canonical is param-free (SEO-safe).
  // Add a channel by copying a line and changing the slug + utm_source/utm_medium.
  //
  // Always-on PAID external channels land on the QuickStart (evergreen — the blog
  // dates itself, and this traffic wants to start building). utm_medium=paid-social
  // so they classify under the "Paid Social Media" marketing channel; utm_source
  // keeps each buy separable within it.
  newsletter:
    'https://strandsagents.com/docs/user-guide/harness/quickstart/?utm_source=newsletter&utm_medium=paid-social&utm_campaign=always-on',
  quora:
    'https://strandsagents.com/docs/user-guide/harness/quickstart/?utm_source=quora&utm_medium=paid-social&utm_campaign=always-on',
  reddit:
    'https://strandsagents.com/docs/user-guide/harness/quickstart/?utm_source=reddit&utm_medium=paid-social&utm_campaign=always-on',
  bytebytego:
    'https://strandsagents.com/docs/user-guide/harness/quickstart/?utm_source=bytebytego&utm_medium=paid-social&utm_campaign=always-on',
  dailydev:
    'https://strandsagents.com/docs/user-guide/harness/quickstart/?utm_source=dailydev&utm_medium=paid-social&utm_campaign=always-on',
  // Spotify is a paid audio ad, not social — utm_medium=display so it doesn't
  // mislabel as Paid Social Media. Adjust if the report suite wants another channel.
  spotify:
    'https://strandsagents.com/docs/user-guide/harness/quickstart/?utm_source=spotify&utm_medium=display&utm_campaign=always-on',

  // The /community/ and /learn/ hubs were removed; both now lead to the
  // start of the learning path (courses).
  community: 'docs/learning/how-agents-really-work',
  learn: 'docs/learning/how-agents-really-work',

  // The /docs/examples/ tutorials were replaced by the /examples/ catalog
  // (pulled from the samples repo). Index gets a static stub; the prefix rule
  // below covers every individual tutorial URL via the 404 fallback.
  'docs/examples': 'examples',

  // docs/community/learning/ lessons moved to docs/learning/
  // Explicit entries prevent the COMMUNITY_PREFIX_RULE catch-all from sending
  // 404-fallback requests to docs/integrations/learning/* (wrong).
  'docs/community/learning/lesson1-how-agents-really-work': 'docs/learning/how-agents-really-work',
  'docs/community/learning/lesson2-switching-model-providers': 'docs/learning/switching-model-providers',
  'docs/community/learning/lesson3-give-your-agent-tools-using-mcp': 'docs/learning/give-your-agent-tools-using-mcp',
  'docs/community/learning/lesson4-adding-callbacks-and-response-streaming':
    'docs/learning/adding-callbacks-and-response-streaming',
  'docs/community/learning/lesson5-control-your-agent-with-hooks': 'docs/learning/control-your-agent-with-hooks',
  'docs/community/learning/lesson6-agent-plugins-and-skills': 'docs/learning/agent-plugins-and-skills',
  'docs/community/learning/lesson7-improve-agent-reliability-with-strands-steering':
    'docs/learning/improve-agent-reliability-with-strands-steering',
  'docs/community/learning/lesson8-context-engineering-and-conversation-management':
    'docs/learning/context-engineering-and-conversation-management',
  'docs/community/learning/lesson9-persistent-memory-with-session-managers':
    'docs/learning/persistent-memory-with-session-managers',
  'docs/community/learning/lesson10-multi-agent-patterns-agents-as-tools':
    'docs/learning/multi-agent-patterns-agents-as-tools',
  'docs/community/learning/lesson11-multi-agent-patterns-graph-workflows':
    'docs/learning/multi-agent-patterns-graph-workflows',
  'docs/community/learning/lesson12-multi-agent-patterns-agent-swarms':
    'docs/learning/multi-agent-patterns-agent-swarms',
  'docs/community/learning/lesson13-evaluating-agents': 'docs/learning/evaluating-agents',
  'docs/community/learning/lesson14-deploying-agents-to-the-cloud': 'docs/learning/deploying-agents-to-the-cloud',

  // cli-reference-agent was archived (strands-agents/agent-builder)
  'docs/examples/python/cli-reference-agent': 'examples',

  // Labs project pages were removed: each project now lives in its own
  // strands-labs GitHub repo, surfaced only from the Labs overview. Labs is
  // launched, so every removed URL redirects straight to its repo. robots-sim
  // was archived earlier (capabilities folded into Strands Robots), so it lands
  // on the Robots repo too.
  'docs/labs/robots-sim': 'https://github.com/strands-labs/robots',
  'docs/labs/robots': 'https://github.com/strands-labs/robots',
  'docs/labs/strands-for-cosmos': 'https://github.com/strands-labs/strands-for-cosmos',
  'docs/labs/benchmark-harnesses': 'https://github.com/strands-labs/benchmark-harnesses',
  'docs/labs/harness-optimizer': 'https://github.com/strands-labs/harness-optimizer',
  'docs/labs/ai-functions': 'https://github.com/strands-labs/ai-functions',
  'docs/labs/pywebrtc-audio': 'https://github.com/strands-labs/pywebrtc-audio',

  // community-packages content lives on the interactive integrations page
  // (an Astro page — buildStaticRedirects validates those targets against
  // src/pages as well as docs content).
  'docs/community/community-packages': 'integrations',

  // The community docs section overview URL predates the docs/integrations
  // rename; its landing content is the interactive integrations page.
  'docs/community': 'integrations',

  // The docs/community/ section was renamed to docs/integrations/ so its URLs
  // match the /integrations page. Every page that existed at rename time gets
  // a static stub (crawler-followable); the COMMUNITY_PREFIX_RULE below covers
  // any docs/community/ URL not listed here via the client-side 404 fallback.
  'docs/community/agent-extensions/strands-code-agent': 'docs/integrations/agent-extensions/strands-code-agent',
  'docs/community/get-featured': 'docs/integrations/get-featured',
  'docs/community/integrations/ag-ui': 'docs/integrations/integrations/ag-ui',
  'docs/community/interventions/overview': 'docs/integrations/interventions/overview',
  'docs/community/interventions/strands-agt': 'docs/integrations/interventions/strands-agt',
  'docs/community/memory-stores/agentcore-memory-store': 'docs/integrations/memory-stores/agentcore-memory-store',
  'docs/community/memory-stores/overview': 'docs/integrations/memory-stores/overview',
  'docs/community/memory-stores/strands-dakera': 'docs/integrations/memory-stores/strands-dakera',
  'docs/community/model-providers/clova-studio': 'docs/integrations/model-providers/clova-studio',
  'docs/community/model-providers/cohere': 'docs/integrations/model-providers/cohere',
  'docs/community/model-providers/crusoe': 'docs/integrations/model-providers/crusoe',
  'docs/community/model-providers/fireworksai': 'docs/integrations/model-providers/fireworksai',
  'docs/community/model-providers/mlx': 'docs/integrations/model-providers/mlx',
  'docs/community/model-providers/nebius-token-factory': 'docs/integrations/model-providers/nebius-token-factory',
  'docs/community/model-providers/nvidia-nim': 'docs/integrations/model-providers/nvidia-nim',
  'docs/community/model-providers/ovhcloud-ai-endpoints': 'docs/integrations/model-providers/ovhcloud-ai-endpoints',
  'docs/community/model-providers/sglang': 'docs/integrations/model-providers/sglang',
  'docs/community/model-providers/vllm': 'docs/integrations/model-providers/vllm',
  'docs/community/model-providers/xai': 'docs/integrations/model-providers/xai',
  'docs/community/plugins/agent-control': 'docs/integrations/plugins/agent-control',
  'docs/community/plugins/agentcore-payments': 'docs/integrations/plugins/agentcore-payments',
  'docs/community/plugins/agentcore-tool-search': 'docs/integrations/plugins/agentcore-tool-search',
  'docs/community/plugins/datadog-ai-guard': 'docs/integrations/plugins/datadog-ai-guard',
  'docs/community/plugins/s3-vectors-memory': 'docs/integrations/plugins/s3-vectors-memory',
  'docs/community/session-managers/agentcore-memory': 'docs/integrations/session-managers/agentcore-memory',
  'docs/community/session-managers/strands-valkey-session-manager':
    'docs/integrations/session-managers/strands-valkey-session-manager',
  'docs/community/storage/overview': 'docs/integrations/storage/overview',
  'docs/community/tools/strands-apify': 'docs/integrations/tools/strands-apify',
  'docs/community/tools/strands-deepgram': 'docs/integrations/tools/strands-deepgram',
  'docs/community/tools/strands-google': 'docs/integrations/tools/strands-google',
  'docs/community/tools/strands-hubspot': 'docs/integrations/tools/strands-hubspot',
  'docs/community/tools/strands-perplexity': 'docs/integrations/tools/strands-perplexity',
  'docs/community/tools/strands-spraay': 'docs/integrations/tools/strands-spraay',
  'docs/community/tools/strands-sql': 'docs/integrations/tools/strands-sql',
  'docs/community/tools/strands-teams': 'docs/integrations/tools/strands-teams',
  'docs/community/tools/strands-telegram': 'docs/integrations/tools/strands-telegram',
  'docs/community/tools/strands-telegram-listener': 'docs/integrations/tools/strands-telegram-listener',
  'docs/community/tools/utcp': 'docs/integrations/tools/utcp',

  // CDK and deployment examples now live on GitHub
  'docs/examples/cdk/deploy_to_apprunner':
    'https://github.com/strands-agents/harness-sdk/blob/main/site/docs/examples/cdk/deploy_to_apprunner/README.md',
  'docs/examples/cdk/deploy_to_ec2':
    'https://github.com/strands-agents/harness-sdk/blob/main/site/docs/examples/cdk/deploy_to_ec2/README.md',
  'docs/examples/cdk/deploy_to_fargate':
    'https://github.com/strands-agents/harness-sdk/blob/main/site/docs/examples/cdk/deploy_to_fargate/README.md',
  'docs/examples/cdk/deploy_to_lambda':
    'https://github.com/strands-agents/harness-sdk/blob/main/site/docs/examples/cdk/deploy_to_lambda/README.md',
  'docs/examples/deploy_to_eks':
    'https://github.com/strands-agents/harness-sdk/blob/main/site/docs/examples/deploy_to_eks/README.md',
  'docs/examples/typescript/deploy_to_bedrock_agentcore':
    'https://github.com/strands-agents/harness-sdk/blob/main/site/docs/examples/typescript/deploy_to_bedrock_agentcore/README.md',
}

type SlugRule = { match: RegExp; to: string } | { match: RegExp; to: (m: RegExpMatchArray) => string }

// Exact-match rules: STATIC_SLUG_REDIRECTS plus the exact dynamic renames
// (section landing pages). These are the highest-priority rules — they win over
// a page's frontmatter redirectFrom, because they encode deliberate 1:1 renames.
const EXACT_SLUG_RULES: SlugRule[] = [
  ...Object.entries(STATIC_SLUG_REDIRECTS).map(([from, to]) => ({
    match: exactly(from),
    to,
  })),

  // The SDK docs were consolidated from scattered top-level prefixes
  // (concepts/, quickstart/, deploy/, observability-evaluation/, safety-security/,
  // versioning-and-support) into a single /docs/user-guide/sdk/ tree. The
  // concepts/ overview became the sdk/ landing, so it needs an exact rule (the
  // concepts/ prefix rule below would send it to /sdk/harness).
  { match: exactly('docs/user-guide/concepts/harness'), to: 'docs/user-guide/sdk' },
  { match: exactly('docs/user-guide/versioning-and-support'), to: 'docs/user-guide/sdk/versioning-and-support' },
]

// Prefix (catch-all) rules: lowest priority, applied only after a page's
// frontmatter redirectFrom has had its chance. A blanket section rename like
// concepts/ → harness/ must not shadow a specific redirectFrom (e.g. a page that
// moved *within* concepts and then into integrations), so these run last.
const PREFIX_SLUG_RULES: SlugRule[] = [
  // docs/community/ → docs/integrations/ section rename.
  { match: startsWith('docs/community'), to: (m) => `docs/integrations/${m[1]}` },

  // Every legacy docs/examples/ tutorial now resolves to the /examples/ catalog.
  { match: startsWith('docs/examples'), to: () => 'examples' },

  // Product rebrand: "Harness SDK" → "SDK". Its pages moved from
  // /docs/user-guide/harness/* to /docs/user-guide/sdk/*. Fires only on 404, so
  // the Strands harness pages at /harness/* are served normally
  // and only genuinely-missing old SDK deep links fall through to /sdk/*.
  { match: startsWith('docs/user-guide/harness'), to: (m) => `docs/user-guide/sdk/${m[1]}` },

  // Changelog stream rename: the former "harness" stream is now the "sdk" stream.
  { match: startsWith('changelog/harness'), to: (m) => `changelog/sdk/${m[1]}` },

  // SDK consolidation: every old top-level prefix folds under sdk/.
  { match: startsWith('docs/user-guide/concepts'), to: (m) => `docs/user-guide/sdk/${m[1]}` },
  { match: startsWith('docs/user-guide/quickstart'), to: (m) => `docs/user-guide/sdk/quickstart/${m[1]}` },
  { match: startsWith('docs/user-guide/deploy'), to: (m) => `docs/user-guide/sdk/deploy/${m[1]}` },
  {
    match: startsWith('docs/user-guide/observability-evaluation'),
    to: (m) => `docs/user-guide/sdk/observability-evaluation/${m[1]}`,
  },
  {
    match: startsWith('docs/user-guide/safety-security'),
    to: (m) => `docs/user-guide/sdk/safety-security/${m[1]}`,
  },
]

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply slug-level rename rules to an already-normalised slug.
 * Checks SLUG_RULES first (highest priority), then falls back to redirectFromMap.
 * Returns the renamed slug, or null if no rule matched (slug is already current).
 *
 * @param slug - The slug to resolve
 * @param redirectFromMap - Optional map of source slugs to target slugs (from frontmatter redirectFrom)
 */
export function resolveRedirect(slug: string, redirectFromMap?: Record<string, string>): string | null {
  // 1. Exact renames win first — deliberate 1:1 moves take priority over everything.
  for (const rule of EXACT_SLUG_RULES) {
    const m = slug.match(rule.match)
    if (m) return typeof rule.to === 'function' ? rule.to(m) : rule.to
  }

  // 2. A page's frontmatter redirectFrom beats the blanket prefix rules below, so a
  //    page that moved to a non-obvious location (e.g. into integrations) is honored
  //    instead of being swept up by a section-wide prefix rename.
  if (redirectFromMap && slug in redirectFromMap) {
    return redirectFromMap[slug] ?? null
  }

  // 3. Prefix (catch-all) section renames, lowest priority.
  for (const rule of PREFIX_SLUG_RULES) {
    const m = slug.match(rule.match)
    if (m) return typeof rule.to === 'function' ? rule.to(m) : rule.to
  }

  return null
}

/**
 * Given a path from the old site, normalise it to a slug and apply redirect rules.
 * Returns '/' for versioned root paths, or null if the path isn't recognisable.
 *
 * External URLs (https://) are only returned when an explicit rule in SLUG_RULES
 * or redirectFromMap matched. The path-normalization fallback never produces an
 * external URL, preventing open redirect attacks via crafted paths like
 * /latest/https://evil.com.
 *
 * @param path - The URL path to resolve (e.g. "/docs/user-guide/...")
 * @param redirectFromMap - Optional map of source slugs to target slugs (from frontmatter redirectFrom)
 */
export function resolveRedirectFromUrl(path: string, redirectFromMap?: Record<string, string>): string | null {
  // Strip leading version segment: /latest/, /1.x/, /1.5.x/, etc.
  path = path.replace(/^\/?(latest|[\d]+(?:\.[\dx]+)*)\//, '/')

  // /documentation/docs/... -> /docs/...
  path = path.replace(/^\/?documentation\/docs(\/|$)/, 'docs$1')

  // Remember if the original path had a trailing slash
  const hadTrailingSlash = path.endsWith('/')

  // Trim leading/trailing slashes
  path = path.replace(/^\/+|\/+$/g, '')

  if (path === '') return '/'

  // Prevent open redirects: absolute URLs can only come from explicit SLUG_RULES,
  // never from the path-normalization fallback.
  if (/^https?:\/\//i.test(path)) return null

  const resolved = resolveRedirect(path, redirectFromMap) ?? path
  return hadTrailingSlash ? `${resolved}/` : resolved
}
