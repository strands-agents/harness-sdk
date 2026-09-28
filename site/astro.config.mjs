// @ts-check
import { defineConfig } from 'astro/config'
import { unified } from '@astrojs/markdown-remark'
import starlight from '@astrojs/starlight'
import path from 'node:path'
import remarkMkdocsSnippets from './src/plugins/remark-mkdocs-snippets.ts'
import sdkSetupPlugin from './src/plugins/vite-plugin-sdk-setup.ts'
import remarkReadingTime from './src/plugins/remark-reading-time.ts'
import watchNavigationPlugin from './src/plugins/vite-plugin-watch-navigation.ts'

import { loadSidebarFromConfig } from "./src/sidebar.ts"
import { buildStaticRedirects } from "./src/util/redirect.static.ts"
import { sitemapWithLastmod } from "./src/plugins/sitemap-lastmod.ts"
import AutoImport from './src/plugins/astro-auto-import.ts'
import astroExpressiveCode from "astro-expressive-code"
import mdx from '@astrojs/mdx';
import astroBrokenLinksChecker from './scripts/astro-broken-links-checker-index.js';

// Generate sidebar from navigation.yml config (validates against existing content files)
// Top-level groups will be rendered as tabs by the custom Sidebar component
const sidebar = loadSidebarFromConfig(
  path.resolve('./src/config/navigation.yml'),
  path.resolve('./src/content')
)

const base = process.env.ASTRO_BASE_PATH || '/'

// Static HTML redirect stubs for known legacy MkDocs URLs (meta refresh +
// canonical link), so crawlers follow renames that the client-side 404
// fallback only handles for humans. Dynamic legacy URLs (/latest/*, /1.x/*)
// can't be enumerated and stay with the 404 fallback (Redirect404.astro).
const redirects = buildStaticRedirects(path.resolve('./src/content'), base)

// https://astro.build/config
export default defineConfig({
  site: 'https://strandsagents.com',
  base,
  redirects,
  vite: {
    plugins: [sdkSetupPlugin(), watchNavigationPlugin()],
    // TODO once we separate out CMS build from TS verification, fix this
    // https://github.com/withastro/astro/issues/14117
		ssr: {
			noExternal: ['zod'],
		},
	},
  markdown: {
    processor: unified(),
    remarkPlugins: [remarkMkdocsSnippets, remarkReadingTime],
  },
  integrations: [
    // Sitemap with git-based <lastmod> dates — must be before Starlight
    // so Starlight detects it and skips its own sitemap integration
    sitemapWithLastmod('src/content'),
    astroExpressiveCode({
      themes: ['github-light', 'github-dark'],
      // Follow Starlight's data-theme attribute instead of the browser's prefers-color-scheme
      themeCssSelector: (theme) => `[data-theme='${theme.type}']`,
      styleOverrides: {
        // Match the accent color from the site theme
        frames: {
          shadowColor: 'transparent',
        },
      },
    }),
    mdx(),
    starlight({
      social: [],
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://strandsagents.com/og-image.png' } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: 'Strands Agents — open source AI agent SDK' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://strandsagents.com/og-image.png' } },
      ],
      markdown: {
        // API docs are symlinked from .build/api-docs; processedDirs ensures Starlight's
        // rehype plugins (e.g. heading anchor links) run on the real resolved paths.
        processedDirs: [path.resolve('.build/api-docs')],
      },
      title: 'Strands Agents',
      description: 'The open source toolkit for building production agents.',
      sidebar: sidebar,
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
      routeMiddleware: './src/route-middleware.ts',
      customCss: [
        './src/styles/custom.css',
        './src/styles/fonts.css',
      ],
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: false,
      },
      editLink: {
        baseUrl: 'https://github.com/strands-agents/harness-sdk/edit/main/site/',
      },
      components: {
        Head: './src/components/overrides/Head.astro',
        Header: './src/components/Header.astro',
        Hero: './src/components/overrides/Hero.astro',
        MarkdownContent: './src/components/overrides/MarkdownContent.astro',
        PageTitle: './src/components/overrides/PageTitle.astro',
        Sidebar: './src/components/overrides/Sidebar.astro',
        PageFrame: './src/components/overrides/PageFrame.astro',
      },
  }),
   astroBrokenLinksChecker({
      checkExternalLinks: false,      // Optional: check external links (default: false)
      cacheExternalLinks: false,      // Optional: cache verified external links to disk (default: true)
      throwError: true,               // Optional: fail the build if broken links are found (default: false)
      linkCheckerDir: '.link-checker', // Optional: directory for cache and log files (default: '.link-checker')
    }),
   AutoImport({
      imports: [
        {
          '@astrojs/starlight/components': [
            ['TabItem', 'Tab']
          ],
          './src/components/AutoSyncTabs.astro': [
            ['default', "Tabs"]
          ],
          './src/components/Syntax.astro': [
            ['default', 'Syntax']
          ],
          './src/components/CopyPromptButton.astro': [
            ['default', 'CopyPromptButton']
          ],
          '@astro-community/astro-embed-youtube': [
            ['YouTube', 'YouTube']
          ],
        },
      ],
      defaultComponents: {
        // override 'a' links so that we can use relative urls
        a: './src/components/PageLink.astro'
      }
    }),
  ],
})
