import { defineCollection, type SchemaContext } from 'astro:content'
import { z } from 'astro/zod'
import { docsSchema } from '@astrojs/starlight/schema'
import { glob, file } from 'astro/loaders'
import { pathToDocsSlug } from './util/links'
import { TagSchema } from './config/tags'

export const ALL_SDK_LANGUAGES = ['python', 'typescript'] as const

export const docsLanguagesSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .superRefine((val, ctx) => {
    if (!val) return
    const langs = Array.isArray(val) ? val.map((l) => l.toLowerCase()) : [val.toLowerCase()]
    if (ALL_SDK_LANGUAGES.every((l) => langs.includes(l))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'languages must not list all supported SDKs (python and typescript) — ' +
          'omit the field entirely when a feature is available in all languages',
      })
    }
  })

const authorSchema = z.object({
  name: z.string(),
  role: z.string(),
  bio: z.string(),
  avatar: z.string().optional(),
})

export const sourceLinkSchema = z.object({
  // Repo-relative path to the implementation,
  // e.g. 'strands-py/src/strands/agent/agent.py'.
  path: z.string(),
  // SDK language this implementation is for. Optional — by default it is
  // inferred from the file extension (see resolveLanguage in util/source-links).
  // Set it explicitly only to override inference: a backing file whose
  // extension doesn't map to a language, or a future language. Free-form string
  // (not an enum) so a new language works without a schema change.
  language: z.string().optional(),
  // GitHub repo slug under the strands-agents org. Defaults to the monorepo;
  // override only for code that lives in a different org repo.
  repo: z.string().default('harness-sdk'),
})
export type SourceLink = z.infer<typeof sourceLinkSchema>

export const changelogEntrySchema = z.object({
  type: z.enum(['feat', 'fix', 'breaking', 'chore', 'docs', 'perf', 'refactor', 'test', 'other']),
  breaking: z.boolean().default(false),
  scope: z.string().nullable().default(null),
  areas: z.array(z.string()).default([]),
  title: z.string(),
  pr: z.number().nullable().default(null),
  prUrl: z.string().url().nullable().default(null),
  commit: z.string().nullable().default(null),
  commitUrl: z.string().url().nullable().default(null),
  author: z.string().nullable().default(null),
})
export type ChangelogEntry = z.infer<typeof changelogEntrySchema>

export const changelogFrontmatterSchema = z
  .object({
    sdk: z.enum(['sdk', 'evals']),
    language: z.enum(['python', 'typescript']).optional(),
    version: z.string(),
    tag: z.string(),
    date: z.coerce.date(),
    releaseUrl: z.string().url(),
    packageUrl: z.string().url(),
    highlights: z.string().optional(),
    entries: z.array(changelogEntrySchema).default([]),
    newContributors: z.array(z.object({ login: z.string(), pr: z.number() })).default([]),
  })
  // Tie `language` to `sdk` so bad data can't create bogus streams/routes:
  // sdk releases are per-language (python|typescript); evals is python-only
  // and omits the field entirely.
  .superRefine((d, ctx) => {
    if (d.sdk === 'sdk' && d.language === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['language'],
        message: 'sdk releases require a language (python or typescript)',
      })
    }
    if (d.sdk === 'evals' && d.language !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['language'],
        message: 'evals releases must not set a language (evals is python-only)',
      })
    }
  })
export type ChangelogFrontmatter = z.infer<typeof changelogFrontmatterSchema>

// `package` is optional: an empty block (`python: {}`) marks a guide-only
// integration (documented by a vendor dev-guide, no Strands-specific
// installable package) as covering that language, so it still participates
// in the language facet. The registry link derives from the package name at
// build time (see toCardModel in util/catalog.ts), so entries never declare
// registry URLs. `.strict()` makes a submitted `registry:` (or any other
// stray key) fail the build with a clear error instead of being silently
// ignored.
const catalogLanguageSchema = z
  .object({
    // Package name as published on the registry (PyPI or npm)
    package: z.string().optional(),
  })
  .strict()

export const catalogEntrySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    // Keep in sync with the docs frontmatter integrationType below and the
    // display registry in src/components/catalog/types.ts (this schema can't
    // import from components without tangling content config into the UI).
    integrationType: z.enum([
      'model-provider',
      'tool',
      'session-manager',
      'memory-store',
      'storage',
      'integration',
      'plugin',
      'agent-extension',
      'intervention',
    ]),
    // Which SDK's ecosystem this belongs to. The catalog's SDK facet stays
    // hidden until at least one evals entry exists.
    sdk: z.enum(['agents', 'evals']).default('agents'),
    // Strict so a misspelled language key (`typeScript:`) fails the build
    // instead of silently dropping the language from the entry's facets.
    languages: z
      .object({
        python: catalogLanguageSchema.optional(),
        typescript: catalogLanguageSchema.optional(),
      })
      .strict(),
    // The single self-declared link: the maintainer shown on the card derives
    // from this URL's owner segment, and registry links derive from the
    // package names — submitters can't point them somewhere else.
    github: z.string().url().startsWith('https://github.com/', 'github must start with https://github.com/'),
    // Docs collection id of the detail page (e.g. 'docs/integrations/tools/strands-deepgram').
    // Optional: entries without one link out to their GitHub repo instead.
    docsPage: z.string().optional(),
    // External URL of the integration's own Strands setup/instructions page
    // (e.g. Temporal's docs for its Strands integration). When there is no
    // on-site docsPage, the card's primary link prefers this over the bare
    // GitHub repo so users land on usage instructions.
    docsUrl: z.string().url().startsWith('https://', 'docsUrl must be https').optional(),
    // Who stands behind the integration, shown and filtered on the catalog.
    // `strands` (SDK built-ins) and `aws` are granted by the Strands team;
    // `partner` requires a maintainer to verify the entry is vended by the
    // integrator's official org; submitters leave it unset (community).
    maintainedBy: z.enum(['strands', 'aws', 'partner', 'community']).default('community'),
    // Editorial fields — maintainer-granted only; submitters leave them unset.
    featured: z.boolean().default(false),
    badges: z.array(z.enum(['verified'])).default([]),
    // Drives the "New" badge on the catalog card.
    addedDate: z.coerce.date(),
  })
  // A stray key (e.g. a self-declared `maintainer:`) fails the build with a
  // clear error instead of being silently dropped.
  .strict()
  .superRefine((d, ctx) => {
    if (!d.languages.python && !d.languages.typescript) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['languages'],
        message: 'at least one language block (python or typescript) is required',
      })
    }
  })
export type CatalogEntryData = z.infer<typeof catalogEntrySchema>

const blogSchema = z.object({
  title: z.string(),
  date: z.coerce.date(),
  description: z.string(),
  authors: z.array(z.string()),
  tags: z.array(z.string()).default([]),
  draft: z.boolean().default(false),
  coverImage: z.string().optional(),
  // For syndicated posts: set to the original URL so search engines credit the source
  canonicalUrl: z.string().url().optional(),
  // Injected by remark-reading-time plugin at build time
  readingTime: z.string().optional(),
})

// Regex rejects protocol-relative URLs like //evil.com and /\evil.com that startsWith('/') would accept.
const internalHref = z.string().regex(
  /^\/(?![/\\])/,
  'course hrefs must be site-relative (start with a single /)',
)

export const courseSchema = z.object({
  title: z.string(),
  number: z.number().int().positive(),
  status: z.enum(['available', 'in-development', 'proposed']),
  description: z.string(),
  href: internalHref,
  syllabusHref: internalHref.optional(),
  // Array position is the source of truth for lesson order; titles resolved from docs at render time.
  lessons: z
    .array(
      z.object({
        href: internalHref,
      })
    )
    .optional(),
})
export type Course = z.infer<typeof courseSchema>

// Accepts unquoted YAML dates (Date) or quoted YYYY-MM-DD strings.
// Round-trip check rejects rolled-over dates: '2026-02-30' passes the regex but coerces to a different ISO date.
const eventDate = z
  .union([
    z.date(),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'event dates must be YYYY-MM-DD')
      .superRefine((s, ctx) => {
        const coerced = new Date(s)
        if (isNaN(coerced.getTime()) || coerced.toISOString().slice(0, 10) !== s) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid calendar date: ${s}` })
        }
      }),
  ])
  .pipe(z.coerce.date())

export const eventSchema = z
  .object({
    title: z.string(),
    startDate: eventDate,
    endDate: eventDate.optional(),
    location: z.string(),
    href: z.string().optional(),
    description: z.string().optional(),
    featured: z.boolean().default(false),
  })
  .refine((d) => d.endDate === undefined || d.endDate >= d.startDate, {
    message: 'endDate must not be before startDate',
    path: ['endDate'],
  })
export type LearnEvent = z.infer<typeof eventSchema>

export const collections = {
  authors: defineCollection({
    loader: file('src/content/authors.yaml'),
    schema: authorSchema,
  }),
  blog: defineCollection({
    loader: glob({
      base: 'src/content/blog',
      pattern: '**/*.{md,mdx}',
    }),
    schema: blogSchema,
  }),
  catalog: defineCollection({
    loader: glob({
      base: 'src/content/catalog',
      pattern: '**/*.yaml',
    }),
    schema: catalogEntrySchema,
  }),
  changelog: defineCollection({
    loader: glob({
      base: 'src/content/changelog',
      pattern: '**/*.{md,mdx}',
    }),
    schema: changelogFrontmatterSchema,
  }),
  testimonials: defineCollection({
    loader: glob({
      base: 'src/content',
      pattern: 'testimonials/**/*.md',
    }),
    schema: ({ image }: SchemaContext) =>
      z.object({
        name: z.string(),
        title: z.string().optional(),
        logo: image().optional(),
        dark_logo: image().optional(),
        link: z.string().url().optional(),
        order: z.number().default(0),
      }),
  }),
  courses: defineCollection({
    loader: glob({
      base: 'src/content/courses',
      pattern: '**/*.{yml,yaml}',
    }),
    schema: courseSchema,
  }),
  events: defineCollection({
    loader: glob({
      base: 'src/content/events',
      pattern: '**/*.{yml,yaml}',
    }),
    schema: eventSchema,
  }),
  docs: defineCollection({
    loader: glob({
      base: 'src/content',
      // We explicitly declare the folders we want to include, as otherwise it includes index.md files
      // in examples which are not intended to be rendered on the site.
      // Long-term we'll be moving examples into the sdk-python repository instead, solving this problem.
      pattern: [
        '404.mdx',

        'docs/user-guide/**/*.mdx',
        'docs/learning/**/*.mdx',
        'docs/integrations/**/*.mdx',
        'docs/contribute/**/*.mdx',
        'docs/examples/**/[!index]*.mdx',
        'docs/labs/**/*.mdx',
        'docs/api/python/**/*.mdx',
        'docs/api/typescript/**/*.(md|mdx)',
      ],
      generateId: generateDocsId,
    }),
    schema: docsSchema({
      // We have certain flags/behavior based on the following properties; see CMS-README.md for more info
      extend: z.object({
        languages: docsLanguagesSchema,
        community: z.boolean().default(false),
        experimental: z.boolean().default(false),
        // Drives the derived "New" sidebar badge for NEW_BADGE_DAYS after this
        // date (see route-middleware.ts). Never hand-write a literal New badge.
        addedDate: z.coerce.date().optional(),
        // Category for TypeScript API docs (classes, interfaces, type-aliases, functions)
        category: z.string().optional(),
        // Integration type for filtering (e.g., 'model-provider' for model providers)
        integrationType: z
          .enum([
            'model-provider',
            'tool',
            'session-manager',
            'memory-store',
            'storage',
            'integration',
            'plugin',
            'agent-extension',
            'intervention',
          ])
          .optional(),
        // Short description for catalog listings
        description: z.string().optional(),
        // Array of slugs that should redirect to this page (e.g., old URLs)
        redirectFrom: z.array(z.string()).optional(),
        // Tags from src/config/tags.yml — drive the build-time "Related pages" block
        tags: z.array(TagSchema).default([]),
        // Pointers to the SDK implementation behind this page. Rendered as an
        // "Implementation" section on headless surfaces only (index.md, llms-full.txt).
        sourceLinks: z.array(sourceLinkSchema).optional(),
      }),
    }),
  }),
}

/**
 * Custom generateId function for docs content collection.
 * This mimics Astro's default slug generation (see node_modules/astro/dist/content/loaders/glob.js)
 * via the shared pathToDocsSlug utility, which redirect.static.ts also uses —
 * both must agree on ids or redirect stubs point at 404s.
 */
function generateDocsId({ entry, data }: { entry: string; data: Record<string, unknown> }): string {
  return pathToDocsSlug(entry, data.slug)
}
