# Astro/Starlight CMS Customizations

This document explains the custom modifications made to the Astro/Starlight setup for the Strands Agents documentation site.

## Overview

We're using [Astro](https://astro.build/) with the [Starlight](https://starlight.astro.build/) documentation theme. However, we've made several customizations to preserve compatibility with our existing MkDocs-based documentation structure and navigation.

## Key Customizations

### 1. Sidebar Generation (`src/sidebar.ts`)

**What it does:** Reads the navigation structure from `src/config/navigation.yml` and converts it to Starlight's sidebar format. It does not apply any collapse behavior — that is handled entirely by the route middleware.

**Why:** Starlight can auto-generate sidebars from the file structure, but we have a specific navigation layout defined in `navigation.yml` that we want to preserve. The config file also contains navbar and GitHub dropdown configuration.

**Collapse opt-in:** Add `collapsed: true` to any group in `navigation.yml` to make it collapsed by default. This value is passed through to the middleware, which is the sole owner of collapse decisions.

**Badges:** Badges (like "new", "community", "experimental") come from page frontmatter, not the navigation config. This allows page authors to control badges directly.

### 2. Route Middleware (`src/route-middleware.ts`)

**What it does:** Filters the sidebar at buildtime so each page only shows items from its section, and applies collapse behavior via `applyCollapse()`. For API pages (Python and TypeScript), it dynamically generates sidebars from the docs collection and computes pagination links.

**Why:** The sidebar is organized around products (Strands harness, SDK, Shell, Evals SDK) plus Examples and Community. Without this middleware, every page would show the entire tree. The middleware scopes it to the current section (matched by the longest `basePath` in `navigation.yml`'s `navbar`), so more specific paths win. Each product's sidebar follows the same shape — Get started → Build guides → Run guides → Components → Reference. First-level bands always render open; depth ≥ 1 subgroups collapse by default (see `applyCollapse()`), and no first-level band sets `collapsed:`. The SDK is the largest scope — the SDK concepts, deploy, observability, and safety pages plus the generated API reference (`/docs/api/`) all resolve to it — while Strands harness, Shell, and Evals SDK each scope to their own product pages under `user-guide/`.

**Product scoping, the switcher & hubs:** The scoped sidebar renders as the normal Starlight left rail. On product pages, `Sidebar.astro` leads with a **product switcher** (the current product slug, e.g. `/harness`, opening the full product list) so you can jump products without leaving the rail. The `PageTitle` override (`src/components/overrides/PageTitle.astro`) renders a product's hub page (`currentPath === product.href`) as a lightweight hero (slug eyebrow, H1, tagline, Quickstart CTA) and every other product page with a small slug eyebrow above the H1. The current product is resolved by `currentProduct()` (`src/util/current-product.ts`) using the same longest-`basePath` rule. Products are declared once in `navigation.yml` under `products:` (the single source of truth for the header "Products" dropdown), and per-product `navbar` `basePath` entries drive the scoping. API/Blog/Changelog pages keep their traditional left sidebar.

**Right table of contents:** Disabled globally via `tableOfContents: false` in `astro.config.mjs`, so no page renders the right "On this page" rail.

**Python API sidebar:** When viewing pages under `docs/api/python/`, the middleware uses `buildPythonApiSidebar()` from `src/dynamic-sidebar.ts` to generate a nested sidebar structure based on module names (e.g., `strands.agent.agent` becomes `Agent > Agent`).

**TypeScript API sidebar:** When viewing pages under `docs/api/typescript/`, the middleware uses `buildTypeScriptApiSidebar()` to generate a category-grouped sidebar (Classes, Interfaces, Type Aliases, Functions).

**Pagination:** For API pages, the middleware also updates `starlightRoute.pagination` using `getPrevNextLinks()` from `src/dynamic-sidebar.ts`. This ensures the previous/next navigation links at the bottom of pages work correctly with the dynamically generated sidebar. Pagination labels use actual page titles (from the docs collection) rather than sidebar nav labels.

**Non-matching pages:** Pages that don't belong to any nav section (e.g., the landing page) now show an empty sidebar instead of the full sidebar.

**Pagination pruning for regular pages:** Starlight pre-computes prev/next links from the full sidebar before middleware runs. The middleware now prunes any links that fall outside the current nav section and overrides labels with actual page titles.

### 3. MkDocs Snippets Plugin (`src/plugins/remark-mkdocs-snippets.ts`)

**What it does:** Processes MkDocs-style code snippet references in markdown files.

**Why:** Our existing documentation uses MkDocs' snippet syntax to include code from external files. This plugin provides compatibility so we don't need to rewrite all our code examples.

**Syntax supported:**
```markdown
```typescript
--8<-- "path/to/file.ts:section_name"
```
```

**Source file markers:**
```typescript
// --8<-- [start:section_name]
const example = "This code will be included"
// --8<-- [end:section_name]
```

### 4. Relative Link Resolution (`src/util/links.ts`, `src/components/PageLink.astro`)

**What it does:** Converts MkDocs-style relative file links to Astro slug-based URLs at render time.

**Why:** MkDocs uses relative links to files (e.g., `../tools/custom-tools.md`), while Astro uses slugs by default and doesn't validate internal links. Rather than rewriting all links to use slugs, we override the default `<a>` element to resolve relative paths automatically. This provides a better authoring experience—linking to files feels more natural than memorizing slug paths.

**How it works:**

1. `PageLink.astro` replaces the default anchor element via `astro-auto-import`
2. When rendering a link, it checks if the href is relative (not absolute, not anchor-only)
3. For relative links, it strips the site's base path from the current URL before resolving, then re-applies it to the result — this ensures correct behavior when the site is deployed under a sub-path
4. The resolved path is matched against the content collection to find the correct slug
5. If no match is found, a warning is logged during development

**Example resolution:**

From page `user-guide/concepts/agents/state.mdx`:
- `conversation-management.md` → `/user-guide/concepts/agents/conversation-management/`
- `../tools/custom-tools.md` → `/user-guide/concepts/tools/custom-tools/`
- `../tools/index.md` → `/user-guide/concepts/tools/`

**Slug generation:** The content collection uses a custom `generateId` function in `src/content.config.ts` that shares the same normalization logic (`normalizePathToSlug`) as link resolution. This ensures consistency between how pages are identified and how links resolve to them.

The collection base is `src/content` (not `src/content/docs`), so all doc slugs include a `docs/` prefix (e.g., `docs/user-guide/concepts/agents/state`). The `generateId` function strips this prefix from path-based slugs so that URLs remain clean (e.g., `/docs/user-guide/...`). Files with an explicit `slug` frontmatter field (such as generated API docs) use that value directly and must include the `docs/` prefix themselves.

### 5. API Reference Links (`@api` shorthand)

**What it does:** Provides a shorthand format for linking to API reference pages that's cleaner than relative paths.

**Syntax:**
```markdown
<!-- Python API -->
[@api/python/strands.agent.agent](link text)
[@api/python/strands.agent.agent#AgentResult](link text with anchor)

<!-- TypeScript API -->
[@api/typescript/Agent](link text)
[@api/typescript/Agent#constructor](link text with anchor)
```

**How it works:**

1. Links starting with `@api/` are detected by `isApiShorthand()` in `src/util/links.ts`
2. `resolveApiShorthand()` converts them to absolute paths (e.g., `/docs/api/python/strands.agent.agent/`)
3. `PageLink.astro` applies the site's base path for correct URL generation

**Why use this format:**
- Cleaner than relative paths with `../api-reference/python/...`
- Doesn't break when the linking page moves to a different directory
- Matches the actual URL structure of the generated API docs
- Validated against the content collection at build time

**Examples:**
```markdown
<!-- Instead of this (fragile, verbose): -->
[AgentResult](../api-reference/python/agent/agent_result.md#strands.agent.agent_result.AgentResult)

<!-- Use this (clean, stable): -->
[AgentResult](@api/python/strands.agent.agent_result#AgentResult)
```

## Configuration (`astro.config.mjs`)

The main config ties everything together:

```javascript
import { loadSidebarFromConfig } from "./src/sidebar.ts"
import remarkMkdocsSnippets from './src/plugins/remark-mkdocs-snippets.ts'
import AutoImport from 'astro-auto-import'

const sidebar = loadSidebarFromConfig(
  path.resolve('./src/config/navigation.yml'),
  path.resolve('./src/content')  // base is src/content, not src/content/docs
)

export default defineConfig({
  markdown: {
    remarkPlugins: [remarkMkdocsSnippets],
  },
  integrations: [
    astroExpressiveCode({
      themes: ['github-light', 'github-dark'],
      // Follow Starlight's data-theme attribute instead of prefers-color-scheme
      themeCssSelector: (theme) => `[data-theme='${theme.type}']`,
    }),
    starlight({
      markdown: {
        // Ensures Starlight's rehype plugins run on API docs symlinked from .build/api-docs
        processedDirs: [path.resolve('.build/api-docs')],
      },
      sidebar: sidebar,
      routeMiddleware: './src/route-middleware.ts',
      // ...
    }),
    AutoImport({
      imports: [/* ... */],
      defaultComponents: {
        // Override anchor elements for relative link resolution
        a: './src/components/PageLink.astro'
      }
    })
  ],
})
```

Notable config details:
- `themeCssSelector` on Expressive Code makes code block themes follow Starlight's `[data-theme]` attribute rather than the browser's `prefers-color-scheme`, keeping syntax highlighting in sync with the site's theme toggle.
- `processedDirs` tells Starlight to run its rehype plugins (e.g. heading anchor links) on the real resolved paths of the API docs symlinks.
- `AutoImport` makes the following components available in every MDX page without an explicit import: `Tabs` (AutoSyncTabs), `Tab` (Starlight's TabItem), `Syntax`, and `YouTube` (from `@astro-community/astro-embed-youtube`).

## Custom Frontmatter Fields

The documentation extends Starlight's default schema with custom fields that automatically render contextual banners at the top of pages.

### `languages`

Indicates a feature is only available in specific SDK languages.

```yaml
---
title: My Feature
languages: Python
---
```

Renders a note aside: "This provider is only supported in {languages}."

### `community`

Marks a page as community-contributed content.

```yaml
---
title: Community Tool
community: true
---
```

Renders a tip aside explaining the package is community-maintained, not officially supported.

### `experimental`

Marks a feature as experimental.

```yaml
---
title: Experimental Feature
experimental: true
---
```

Renders a tip aside warning the feature may change in future versions.

### Rendering Order

When multiple fields are set, banners render top to bottom: experimental → community → languages.

### Sidebar Badges

Pages can display badges in sidebar navigation:

```yaml
---
title: My Page
sidebar:
  label: "AWS Lambda"
  badge:
    text: New
    variant: note
---
```

Available variants: `note`, `tip`, `caution`, `danger`, `success`, `default`

**Badge sources:** Badges like "Experimental" or "Community" are determined from page frontmatter. Add a `sidebar.badge` field to a page's frontmatter to display a badge in the sidebar.

## MDX Components

Documentation pages use MDX format and can import [Starlight components](https://starlight.astro.build/components/using-components/):

```mdx
import { Tabs, TabItem } from '@astrojs/starlight/components';

<Tabs>
  <TabItem label="Python">Python code here</TabItem>
  <TabItem label="TypeScript">TypeScript code here</TabItem>
</Tabs>
```

Available: `Tabs`/`TabItem`, `Aside`, `Card`/`CardGrid`, `LinkCard`, `Icon`, `Badge`

### Auto-Imported Components

We use [astro-auto-import](https://github.com/delucis/astro-auto-import) to make `Tabs`, `Tab`, and `Syntax` available globally without explicit imports. Since language tabs and inline language-specific identifiers appear on nearly every page, this reduces boilerplate.

```mdx
<!-- No import needed — just use directly -->
<Tabs>
  <Tab label="Python">pip install strands</Tab>
  <Tab label="TypeScript">npm install @strands-agents/sdk</Tab>
</Tabs>
```

`Tabs` maps to our `AutoSyncTabs` component (auto-syncs tabs with matching labels), and `Tab` maps to Starlight's `TabItem`.

For other components, use [explicit imports](https://starlight.astro.build/components/using-components/).

## Custom Components (`src/components/`)

### `AutoSyncTabs`

A wrapper around Starlight's `Tabs` that auto-generates a `syncKey` from tab labels. Tabs with identical label sets automatically sync together across the page. Auto-imported as `Tabs` (see above).

### `Syntax`

Inline component for language-specific identifiers in prose. Renders the Python or TypeScript variant based on the global language toggle, avoiding the `"python_name (Python) or tsName (TypeScript)"` pattern. Auto-imported.

```mdx
Pass <Syntax py="context_manager" ts="contextManager" /> to configure...
```

Props:
- `py` (required): Python syntax variant
- `ts` (required): TypeScript syntax variant
- `plain` (default: `false`): Renders as plain text instead of `<code>`.

The component reads the same `localStorage` key as the language toggle and swaps live without page reload.

**When to use:** Any time a single identifier, method name, or parameter differs between Python and TypeScript and you're writing shared prose (not inside a `<Tab>` section).

**When NOT to use:** For code blocks (use `<Tabs>`), for conceptual differences between SDKs that aren't simple name swaps, or for content that only applies to one language.

### `PageLink`

Replaces the default anchor element to enable MkDocs-style relative linking. Resolves relative hrefs against the current page's path and validates against the content collection. Logs warnings in development for broken links. Auto-imported as the default `a` element.

### Starlight Overrides (`src/components/overrides/`)

These override default Starlight components:

- **`Head.astro`**: Adds Mermaid diagram support and loads `SiteScripts` (Shortbread + WebSDK).
- **`Header.astro`**: Custom header with navigation tabs and theme-aware logos (see [Header Navigation](#header-navigation) below).
- **`Hero.astro`**: Suppresses the Starlight hero on `/blog/` paths. Blog pages pass a dummy `hero: { actions: [] }` to collapse Starlight's two-panel layout, and this override ensures that dummy hero has no visual output.
- **`MarkdownContent.astro`**: Injects the custom frontmatter banners (experimental, community, languages) at the top of page content.
- **`PageFrame.astro`**: Extends Starlight's default `PageFrame` to add a full-width site footer containing the `Copyright` component. The footer spans the content area (respecting sidebar offset) with `--sl-color-bg-nav` background to match the header.
- **`Sidebar.astro`** and **`SidebarSublist.astro`**: Custom sidebar navigation that mimics MkDocs Material theme's `navigation.sections` behavior.

#### Sidebar Navigation Style

The custom sidebar components provide a flatter navigation style.

**How it works:**
1. Top-level groups render as non-collapsible section headers (uppercase labels), unless `collapsed: true` is set in `navigation.yml`, in which case they render as a collapsible with a caret icon
2. Nested groups are collapsible with a caret icon
3. Group labels link to their first child page (clickable navigation)
4. Groups auto-expand when they contain the current page
5. Indentation only starts at depth 2+ (first level under section headers has no indent)

**Why:** Starlight's default sidebar shows all groups as collapsible accordions. This override provides a cleaner hierarchy where top-level sections are always visible, and nested groups can be both navigated to and expanded.

### Header Navigation

The custom header (`src/components/overrides/Header.astro`) replicates the navigation tabs from the MkDocs Material theme used on strandsagents.com.

**Features:**
- Navigation tabs displayed below the main header row on desktop
- Mobile dropdown menu next to the search bar for small screens
- GitHub repository dropdown (`src/components/GitHubDropdown.astro`) replacing the default social icons
- Theme-aware logos (`logo-header-light.svg` / `logo-header-dark.svg`)
- Active state detection using longest-match path logic

**Configuring Navigation Links:**

Edit `src/config/navbar.ts` to add, remove, or reorder navigation links:

```typescript
const rawNavLinks: NavLink[] = [
  { label: 'Home', href: '/' },
  {
    label: 'User Guide',
    href: '/user-guide/quickstart/overview/',
    basePath: '/user-guide/',  // Used for active state detection
  },
  {
    label: 'Contribute ❤️',
    href: 'https://github.com/strands-agents/harness-sdk/blob/main/CONTRIBUTING.md',
    external: true,  // Opens in new tab with arrow icon
  },
]
```

**GitHub dropdown:** `src/config/navbar.ts` also exports `githubSections` — an array of grouped repository links shown in the `GitHubDropdown` component (desktop) and the mobile nav menu. Edit this to add or remove repos/orgs.

**Active state logic:** The header uses `findCurrentNavSection()` from `src/route-middleware.ts` to determine which tab is active. It finds the nav link with the longest matching `basePath` (or `href` if no `basePath`) that the current URL starts with.

**Theme-aware logos:** The header renders both `logo-header-light.svg` and `logo-header-dark.svg`, using CSS to show the appropriate one based on the `[data-theme]` attribute. Logo files are in `src/assets/`.

### Internal Aside Components

Used by `MarkdownContent.astro` to render frontmatter banners:

- `ExperimentalAside.astro`
- `CommunityContributionAside.astro`
- `LanguageSupportAside.astro`

These are not meant to be imported directly in MDX files—use the frontmatter fields instead.

## Python API Reference Generation

The Python API reference documentation is auto-generated from the SDK source code using pydoc-markdown.

### Generation Script (`scripts/api-generation-python.py`)

**What it does:** Parses Python source code from the SDK and generates MDX documentation files.

**How to run:**
```bash
uv run scripts/api-generation-python.py
```

**Input:** `.build/sdk-python/src` (cloned SDK repository)
**Output:** `.build/api-docs/python/*.mdx`

**Filtering:**
- Skips private modules (any module path containing `_` prefix)
- Skips explicitly excluded modules (e.g., `strands.agent` which just re-exports)

**Output format:** Each module becomes a flat MDX file named `strands.module.name.mdx` with frontmatter containing the title, slug, and `editUrl: false` (suppresses the "Edit this page" link on generated pages).

### Symlink Setup

The generated docs are accessed via a committed symlink:
```
src/content/docs/api/python/_generated -> ../../../../../.build/api-docs/python
```

This symlink is checked into git, so no manual setup is required. The generation script outputs to `.build/api-docs/python/`, and the symlink makes those files available to the content collection.

The index page (`src/content/docs/api/python/index.mdx`) is a permanent file (not generated) that imports the `PythonApiList` component.

### Dynamic Sidebar (`src/dynamic-sidebar.ts`)

**What it does:** Builds a hierarchical sidebar structure from Python API docs at runtime, and provides pagination utilities.

**How it works:**
1. Filters docs collection for `docs/api/python/*` pages
2. Parses module names from page titles (e.g., `strands.agent.agent`)
3. Builds a nested tree structure based on module path segments
4. Converts tree to Starlight sidebar entries with groups and links

**Pagination utilities:**
- `flattenSidebar()` - Converts nested sidebar structure to a flat list of links
- `getPrevNextLinks(sidebar, titlesByHref?)` - Finds the current page in the flattened sidebar and returns prev/next links. The optional `titlesByHref` map (href → title) overrides sidebar nav labels with actual page titles.

**Sorting:**
- Alphabetical A-Z within each level
- "Experimental" group always appears last
- Groups at depth ≥2 are collapsed by default

**Example transformation:**
```
strands.agent.agent      → Agent > Agent
strands.agent.base       → Agent > Base
strands.experimental.bidi.types → Experimental > Bidi > Types
```

### Index Page Component (`src/components/PythonApiList.astro`)

**What it does:** Renders the API reference index page with a hierarchical list of all modules.

**How it works:** Uses the same `buildPythonApiSidebar()` function as the route middleware to ensure consistency between the sidebar navigation and the index page listing.

### Path Alias

Components can be imported using the `@components` alias:
```typescript
import PythonApiList from '@components/PythonApiList.astro'
```

This is configured in `tsconfig.json` under `compilerOptions.paths`.

## TypeScript API Reference Generation

The TypeScript API reference documentation is auto-generated from the SDK source code using [typedoc](https://typedoc.org/) with [typedoc-plugin-markdown](https://typedoc-plugin-markdown.org/).

### Generation Script (`scripts/api-generation-typescript.ts`)

**What it does:** Runs typedoc to generate markdown files, then post-processes them to add frontmatter.

**How to run:**
```bash
npm run sdk:generate:ts
# or
npx tsx scripts/api-generation-typescript.ts
```

**Input:** `.build/sdk-typescript/src` (cloned SDK repository)
**Output:** `.build/api-docs/typescript/{classes,interfaces,type-aliases,functions,namespaces}/*.md`

### TypeDoc Configuration (`typedoc.json`)

Key settings:
- `outputFileStrategy: "members"` - Creates separate files per class/interface/type/function
- `fileExtension: ".md"` - Outputs standard markdown format
- `basePath: ".build/sdk-typescript"` - Strips build path prefix from source links
- `hideBreadcrumbs: true`, `hidePageHeader: true` - Cleaner output for Starlight integration
- `excludeExternals: true` - Excludes re-exported symbols from external packages

### Post-Processing

The generation script performs these transformations after typedoc runs:

1. **Adds frontmatter** with title, slug, category, and `editUrl: false` (suppresses the "Edit this page" link since these files are generated):
   ```yaml
   ---
   title: "Agent"
   slug: docs/api/typescript/Agent
   category: classes
   editUrl: false
   ---
   ```
   For namespace members, the slug includes the namespace as a prefix separated by a colon:
   ```yaml
   ---
   title: "setupTracer"
   slug: docs/api/typescript/telemetry:setupTracer
   category: functions
   editUrl: false
   ---
   ```

2. **Fixes relative links** to match the flat slug structure (e.g., `../interfaces/AgentData.md` → `../AgentData.md`) and updates `.md` extensions to `.mdx`. For namespace members and namespace index pages, cross-member links are rewritten to absolute slug paths (e.g., `[TracerConfig](../interfaces/TracerConfig.md)` → `[TracerConfig](/api/typescript/telemetry:TracerConfig)`) to ensure correct resolution regardless of the page's own URL.

3. **Converts to MDX** — runs content through a `unified`/`remark-gfm` pipeline with `mdxToMarkdown()` serialization, which escapes characters that are valid in markdown but invalid in MDX (e.g. `{`, `}` outside code blocks). Content inside code fences is left untouched. Files are written as `.mdx` instead of `.md`. A targeted replacement also handles the literal string `<name>Data` that typedoc emits in prose to describe the naming pattern for data interfaces.

4. **Deletes the generated index.md** - We use our own custom index page instead

### Flat Slugs with Category Grouping

Unlike Python API docs which use hierarchical slugs based on module paths, TypeScript API docs use flat slugs:
- URL: `/docs/api/typescript/Agent/` (not `/docs/api/typescript/classes/Agent/`)
- The `category` frontmatter field is used for sidebar grouping

This keeps URLs clean while still organizing the sidebar by type (Classes, Interfaces, Type Aliases, Functions).

### Namespace Exports

When the SDK exports a namespace (e.g., `export * as telemetry from './telemetry/index.js'`), typedoc generates a nested directory structure under `namespaces/<ns>/`. The generation script handles this specially:

- The namespace index page (`namespaces/<ns>/index.md`) is kept and written as `namespaces/<ns>.mdx` with slug `api/typescript/<ns>` and category `namespaces`.
- Members of the namespace (classes, interfaces, functions, etc.) are flattened into the same top-level category directories as regular exports, but their slugs are prefixed with the namespace name using a colon separator: `docs/api/typescript/<ns>:<MemberName>`.
- All cross-member links within a namespace are rewritten to absolute slug paths to avoid broken relative links after flattening.

### Symlink Setup

The generated docs are accessed via a committed symlink:
```
src/content/docs/api/typescript/_generated -> ../../../../../.build/api-docs/typescript
```

The index page (`src/content/docs/api/typescript/index.mdx`) is a permanent file that imports the `TypeScriptApiList` component.

### Dynamic Sidebar (`src/dynamic-sidebar.ts`)

**What it does:** Builds a category-grouped sidebar structure from TypeScript API docs at runtime.

**How it works:**
1. Filters docs collection for `docs/api/typescript/*` pages
2. Groups docs by their `category` frontmatter field
3. Creates sidebar groups for Classes, Interfaces, Type Aliases, and Functions
4. Sorts entries alphabetically within each group

**Example structure:**
```
Namespaces
  └── telemetry
Classes
  ├── Agent
  ├── BedrockModel
  └── Tool
Interfaces
  ├── AgentConfig
  ├── TracerConfig       ← namespace member, slug: docs/api/typescript/telemetry:TracerConfig
  └── ToolSpec
Type Aliases
  ├── ContentBlock
  └── ToolChoice
Functions
  ├── configureLogging
  ├── setupTracer        ← namespace member, slug: docs/api/typescript/telemetry:setupTracer
  └── tool
```

### Index Page Component (`src/components/TypeScriptApiList.astro`)

**What it does:** Renders the API reference index page with a categorized list of all exports.

**How it works:** Uses the same `buildTypeScriptApiSidebar()` function as the route middleware to ensure consistency between the sidebar navigation and the index page listing.

### Content Collection Schema

The `category` field is defined in `src/content.config.ts`:
```typescript
extend: z.object({
  // ...
  category: z.string().optional(),
})
```

This allows the content collection to validate and expose the category for sidebar generation.


## Custom Landing Page

The landing page uses a custom layout that provides the Starlight header without the full documentation page structure, allowing for full-width marketing content.

### Landing Layout (`src/layouts/LandingLayout.astro`)

**What it does:** Provides a minimal layout with the Starlight header, theme support, and CSS variables, but without the sidebar, table of contents, or content constraints of documentation pages.

**Key features:**
- Mocks `Astro.locals.starlightRoute` with minimal data needed for the Header component
- Mocks `Astro.locals.t` translation function (with `.all()` method for Search component)
- Includes `SiteScripts` for Shortbread consent and WebSDK

**Usage:**
```astro
---
import LandingLayout from '../layouts/LandingLayout.astro'
---

<LandingLayout title="Page Title" description="Optional description">
  <!-- Full-width content here -->
</LandingLayout>
```

### Landing Page (`src/pages/index.astro`)

The main landing page includes:
- Animated parallax curves background (replicating strandsagents.com effect)
- Hero section with frosted glass effect
- Feature cards that expand on hover to show descriptions
- Testimonials slider with fade transitions and auto-play
- Footer with `Copyright` component (left-aligned, `--sl-color-bg-nav` background)

**Assets:**
- `src/assets/curve-primary.svg` and `src/assets/curve-secondary.svg` - Animated strand patterns
- `src/assets/icons/icon-*.svg` - Feature card icons

## Testimonials Content Collection

Testimonials are managed as a content collection of Markdown files, with company logos stored alongside them.

### Schema (`src/content.config.ts`)

```typescript
testimonials: defineCollection({
  loader: glob({ base: 'src/content', pattern: 'testimonials/**/*.md' }),
  schema: ({ image }) => z.object({
    name: z.string(),
    title: z.string().optional(),
    logo: image().optional(),       // Light-mode company logo
    dark_logo: image().optional(),  // Dark-mode variant (falls back to logo)
    order: z.number().default(0),
  }),
})
```

Using Astro's `image()` helper ensures logos are processed through the asset pipeline (hashed, optimized) at build time.

### Content Location

`src/content/testimonials/` — each company has a `.md` file and its logo(s) stored alongside it:

```
src/content/testimonials/
├── smartsheet.md
├── smartsheet-logo.svg
├── smartsheet-logo-white.svg   ← dark-mode variant
├── landchecker.md
├── landchecker-logo.svg
└── ...
```

### File Format

Each testimonial is a Markdown file with frontmatter metadata and the quote as the body:

```markdown
---
name: JB Brown
title: VP Engineering, Smartsheet
logo: ./smartsheet-logo.svg
dark_logo: ./smartsheet-logo-white.svg
order: 1
---

At Smartsheet, we chose Strands...
```

The `order` field controls display sequence in the slider. Logo paths are relative to the file.

### Dark/Light Logo Switching

The landing page renders both `logo` and `dark_logo` (falling back to `logo` when no dark variant exists) and uses CSS to show the appropriate one based on Starlight's `[data-theme]` attribute:

```css
.logo-dark { display: none; }
[data-theme='dark'] .logo-light { display: none; }
[data-theme='dark'] .logo-dark { display: block; }
```

## Temporary Migration Files

The following files were created to support the MkDocs → Astro migration and should be deleted once migration is complete:

### Link Conversion Utilities

These files handle converting old MkDocs-style API reference links to the new `@api` shorthand format:

- `src/util/api-link-converter.ts` - Utility functions to detect and convert old API links
- `test/api-link-converter.test.ts` - Tests for the link converter

### Migration Scripts

These scripts assist with documentation maintenance:

- `scripts/update-quickstart.ts` - Quickstart-specific transformations
- `scripts/update-language-index.ts` - Updates language index pages
- `test/update-docs.test.ts` - Tests for API link conversion utilities


## URL Redirects (Old MkDocs URLs → New CMS URLs)

The old MkDocs site used versioned URLs like `/latest/documentation/docs/<path>/` and `/1.x/documentation/docs/<path>/`. The new CMS uses clean paths like `/docs/<path>/`. Some pages also moved or were renamed. The redirect system handles both cases client-side via the 404 page.

### How It Works

1. **404 page** (`src/content/404.mdx`) renders `Redirect404.astro`, which runs a client-side script on every 404.
2. **`Redirect404.astro`** (`src/components/Redirect404.astro`) builds a `redirectFromMap` at build time (via `src/util/redirect.build.ts`) and passes it to the client-side script, which calls `resolveRedirectFromUrl()` with the current URL and map. If a target is found, `window.location.replace()` fires without adding a history entry.
3. **`src/util/redirect.ts`** contains the redirect logic:
   - `resolveRedirectFromUrl(url, redirectFromMap?)` — strips the version prefix (`/latest/`, `/1.x/`, `/1.5.x/`, etc.) and the `/documentation/` segment, then delegates to `resolveRedirect()`.
   - `resolveRedirect(slug, redirectFromMap?)` — checks `SLUG_RULES` first (highest priority), then falls back to `redirectFromMap` for frontmatter-based redirects.
4. **`src/util/redirect.build.ts`** — shared helper that calls `getCollection('docs')` and builds the `redirectFromMap` from all `redirectFrom` frontmatter arrays. Used by both `Redirect404.astro` and the sitemap coverage test.

### Page-Level Redirects (`redirectFrom` frontmatter)

Individual pages can declare old slugs that should redirect to them:

```yaml
---
title: My Page
redirectFrom:
  - docs/old/path/to/page
---
```

This is useful when a page moves to a new URL. The `redirectFrom` slugs are collected at build time into a map and passed to the client-side redirect script. They must also be registered in `test/known-routes.json` — the sitemap coverage test enforces this.

### Adding New Redirect Rules

Edit `SLUG_RULES` in `src/util/redirect.ts` for structural renames affecting many pages. For single-page moves, prefer `redirectFrom` frontmatter instead. Each `SLUG_RULES` entry has a `match` regex and a `to` string or function:

```typescript
// Static rename
{ match: exactly('docs/old/path'), to: 'docs/new/path' },

// Pattern-based rename (capture group 1 = everything after the prefix)
{ match: startsWith('docs/old-prefix'), to: (m) => `docs/new-prefix/${m[1]}` },
```

Helper builders from `src/util/regex.ts`:
- `startsWith(prefix)` — matches slugs starting with `prefix/`, captures the rest in `m[1]`
- `exactly(s)` — matches the slug exactly

### Testing

- **`test/redirect.test.ts`** — unit tests for `resolveRedirect` and `resolveRedirectFromUrl` covering slug transforms, URL normalisation, trailing-slash preservation, and `redirectFromMap` priority rules.
- **`test/sitemap-coverage.test.ts`** — integration tests including:
  - Every `redirectFrom` slug declared in frontmatter has a corresponding entry in `test/known-routes.json` (fails with copy-paste-ready JSON if missing).
  - Every known route resolves to a valid CMS entry (uses `buildRedirectFromMap()` so frontmatter-based redirects are honoured).
  - Live sitemap coverage (controlled by `VERIFY_LIVE_SITEMAP=true`, skipped locally).

Run with:
```bash
npm test
```

---

## LLM-Friendly Documentation (`llms.txt`)

We provide machine-readable documentation following the [llms.txt specification](https://llmstxt.org/), optimized for both humans and AI agents.

### Why Custom Implementation

We evaluated existing Astro llms.txt plugins/integrations but found them lacking:
- They generated HTML or poorly formatted markdown with navigation clutter
- Links weren't properly resolved to our documentation structure
- No support for our custom components (tabs, code snippets, etc.)

Our implementation renders documentation through Astro's container API, applies custom HTML-to-markdown transformations, and generates clean output with correct links.

### Endpoints

- `/llms.txt` - Index with links to all docs organized by sidebar structure
- `/llms-full.txt` - Complete documentation content (excludes API reference)
- `/{slug}/index.md` - Any doc page in raw markdown format

### Implementation Files

| File | Purpose |
|------|---------|
| `src/pages/llms.txt.ts` | Generates index from sidebar structure |
| `src/pages/llms-full.txt.ts` | Renders all docs inline |
| `src/pages/[...slug]/index.md.ts` | Dynamic endpoint for individual pages |
| `src/util/render-to-markdown.ts` | Renders MDX entries via AstroContainer |
| `src/util/html-to-markdown.ts` | HTML→Markdown conversion with custom rules |

### HTML-to-Markdown Transformations

Uses [Turndown](https://github.com/mixmark-io/turndown) with custom rules:

- **Tables**: GFM plugin for proper markdown table syntax
- **Code blocks**: Handles both standard and Expressive Code syntax highlighting
- **Tab panels**: Wraps content with `(( tab "Label" ))` markers
- **Local links**: Rewrites to `/index.md` format for LLM consumption
- **Cleanup**: Removes screen-reader elements, empty anchors, tab navigation lists, scripts

### Link Handling

The `src/util/links.ts` module was extended:
- `toRawMarkdownUrl()` - Converts paths to index.md URLs, skips files with extensions
- `isLocalLink()` - Identifies links that should be converted (excludes .txt, external, anchors)
- `resolveHref()` - Special-cases `llms.txt` and `llms-full.txt` for proper resolution
- `getSiteOrigin()` - Returns the value of the `SITE_DOMAIN` environment variable (trailing slash stripped), or an empty string if unset. Used by `llms.txt` and `llms-full.txt` to produce absolute URLs when a domain is known.

### Absolute URLs via `SITE_DOMAIN`

By default, links in `llms.txt` and `llms-full.txt` are relative (path-only). Set the `SITE_DOMAIN` environment variable at build time to prefix all links with the full domain:

```bash
SITE_DOMAIN=https://strandsagents.com npm run build
```

Without `SITE_DOMAIN`, links remain relative (e.g. `/user-guide/quickstart/`). With it set, they become absolute (e.g. `https://strandsagents.com/user-guide/quickstart/`).

## Blog

The blog is a standalone section at `/blog/` with its own content collection, layouts, components, and routes — outside of Starlight's docs collection. It follows the same pattern as the custom landing page: reuses the Starlight header via `BlogLayout.astro` while opting out of the docs chrome (sidebar, table of contents, etc.).

### Content Collections

**Authors** (`src/content/authors.yaml`):
```yaml
- id: strands-team
  name: Strands Agents Team
  role: Core Team
  bio: The team behind the Strands Agents SDK.
```

Schema: `{ id, name, role, bio, avatar? }` — all strings. The `id` field is used as the reference key from blog post frontmatter. Stored as a single YAML file (array of author objects) rather than individual JSON files per author.

**Blog Posts** (`src/content/blog/*.mdx`):
```yaml
---
title: "Post Title"
date: 2026-02-20T00:00:00.000Z
description: "Short description for cards and meta tags."
authors: ["strands-team"]     # References author file IDs
tags: ["Open Source"]
draft: false                  # Excluded from production builds
coverImage: "/path/to/image"  # Optional
---
```

The `readingTime` field is injected automatically by the remark plugin (see below).

Both collections are registered in `src/content.config.ts` using glob loaders, following the same pattern as testimonials.

### Reading Time Remark Plugin (`src/plugins/remark-reading-time.ts`)

Extracts text from the markdown AST and injects a `readingTime` string (e.g., "3 min read") into `file.data.astro.frontmatter`. Registered in `astro.config.mjs` under `markdown.remarkPlugins`.

Dependencies: `reading-time`, `mdast-util-to-string`.

### Blog Utilities (`src/util/blog.ts`)

Helper functions used across all blog pages:

| Function | Purpose |
|----------|---------|
| `getPublishedPosts()` | All posts sorted by date desc, excludes drafts in prod |
| `getAllTags()` | Unique tags across all published posts |
| `getPostsByTag(tag)` | Posts filtered by tag |
| `getPostsByAuthor(authorId)` | Posts filtered by author ID |
| `resolveAuthors(ids)` | Looks up author collection entries by ID |
| `tagToSlug(tag)` / `slugToTag(slug)` | Bidirectional tag↔URL conversion |
| `formatDate(date)` | Human-readable date (e.g., "February 20, 2026") |

### Layouts

**`BlogLayout.astro`** — Base layout for all blog pages. Uses Starlight's `<StarlightPage>` component to get the full page shell (head, styles, theme, header) for free. Passes `hasSidebar={false}` and `template: 'splash'` to suppress sidebar and doc-page chrome. Passes `hero: { actions: [] }` to collapse Starlight's two-panel layout into a single content panel (suppressing the auto-generated `PageTitle`). Extra head tags (canonical URL, OG/Twitter meta, RSS autodiscovery) are injected via the `frontmatter.head` array. A named `<slot name="head" />` is forwarded for page-specific head content (e.g. JSON-LD). The `Hero` component override (`src/components/overrides/Hero.astro`) suppresses the hero on `/blog/` paths so the dummy hero value has no visual effect.

**`BlogPostLayout.astro`** — Wraps `BlogLayout` with article-specific chrome: title, date, reading time, description, author byline, tags, cover image. Injects JSON-LD Article schema via the head slot. OG image URL: `/blog/og/{slug}.png`.

### Components (`src/components/blog/`)

| Component | Purpose |
|-----------|---------|
| `BlogCard.astro` | Card for listing pages (cover, title, description, meta, tags). Glassmorphism styling matching landing page. |
| `BlogAuthorByline.astro` | Author avatar + name + role, links to `/blog/authors/[id]/` |
| `BlogTagList.astro` | Tag chips linking to `/blog/tags/[tagSlug]/` |
| `BlogPostGrid.astro` | Reusable card grid (auto-fill, 320px min, 1200px max). Resolves authors for all posts. |

### Pages

| Route | File | Description |
|-------|------|-------------|
| `/blog/` | `src/pages/blog/index.astro` | Index with tag filter bar + post grid |
| `/blog/[slug]` | `src/pages/blog/[slug].astro` | Individual post (via `getStaticPaths`) |
| `/blog/tags/[tag]/` | `src/pages/blog/tags/[tag].astro` | Posts filtered by tag |
| `/blog/authors/[author]/` | `src/pages/blog/authors/[author].astro` | Author page with bio + their posts |

### Navigation

Blog is added to the header nav in `src/config/navbar.ts`:
```typescript
{ label: 'Blog', href: '/blog/', basePath: '/blog/' }
```
Active state is handled by the existing `findCurrentNavSection()` longest-match logic.

### RSS Feeds

| Endpoint | File |
|----------|------|
| `/blog/feed.xml` | `src/pages/blog/feed.xml.ts` — Main feed (all posts) |
| `/blog/feed/[tag].xml` | `src/pages/blog/feed/[tag].xml.ts` — Per-tag feeds |

Uses `@astrojs/rss`. Currently includes description only (not full rendered content).

### AEO (Agentic Engine Optimization)

The blog extends the existing llms.txt system:

- **`/blog/[slug]/index.md`** — Raw markdown endpoint for each post (mirrors the `[...slug]/index.md.ts` pattern for docs). Uses `renderEntryToMarkdown()` with `basePath: /blog/${post.id}/`.
- **`/llms.txt`** — Extended with a `## Blog` section listing links to blog markdown endpoints.
- **`/llms-full.txt`** — Extended to render blog posts inline after docs content.
- **`src/util/render-to-markdown.ts`** — Generalized from `CollectionEntry<'docs'>` to `CollectionEntry<'docs'> | CollectionEntry<'blog'>` with an optional `basePath` parameter.

### OG Images

Build-time OG image generation at `/blog/og/[slug].png` using `astro-og-canvas`:
- 1200×630px images from post title + description
- Strands branding: dark background (#0E0E0E), Strands green (#00CC5F) left border

Implementation: `src/pages/blog/og/[slug].png.ts`

### robots.txt

`public/robots.txt` — Allows all crawlers including GPTBot, ClaudeBot, PerplexityBot. References sitemap.

## Dependency Version Pinning

### `astro-broken-links-checker`

This package is pinned to an exact version (`1.0.6`) rather than using a semver range. It's a low-popularity package, so we avoid automatic updates to prevent potentially pulling in malicious or breaking changes without an explicit review. Before upgrading, manually inspect the changelog and diff on the package's repository.

**Known bug:** The upstream plugin does not account for Astro's `base` path configuration, causing it to incorrectly flag all internal links as broken when the site is deployed under a sub-path. See [imazen/astro-broken-link-checker#16](https://github.com/imazen/astro-broken-link-checker/issues/16).

**Local fix:** Rather than waiting for an upstream fix, the plugin source has been inlined into `scripts/astro-broken-links-checker-index.js` and `scripts/astro-broken-links-checker-check-links.js`. The fix captures `config.base` in the `astro:config:setup` hook and strips the base prefix from internal links before resolving them against the `dist/` directory. `astro.config.mjs` imports from the local copy instead of the npm package.
