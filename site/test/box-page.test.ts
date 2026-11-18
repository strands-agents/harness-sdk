import { readFileSync } from 'node:fs'

import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'

import {
  BOX_BOUNDARY_PANELS,
  BOX_CAPABILITIES,
  BOX_CAPABILITIES_HEADLINE,
  BOX_CAPABILITIES_SUMMARY,
  BOX_CLI_REPOSITORY_URL,
  BOX_CORE_REPOSITORY_URL,
  BOX_EXAMPLE_BOUNDARY,
  BOX_FEATURED_AGENT_EXAMPLES,
  BOX_INSTALL_COMMAND,
  BOX_LANDING_DESCRIPTION,
  BOX_LANDING_TITLE,
  BOX_LINKS,
  BOX_OVERVIEW_DESCRIPTION,
  BOX_REPOSITORY_URL,
  BOX_VERIFY_COMMAND,
} from '../src/config/box-landing'

function configuredPathWithBase(value: string): string {
  const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
  const normalizedValue = value.startsWith('/') ? value : `/${value}`
  return `${base}${normalizedValue}`
}

function configuredHref(value: string): string {
  return value.startsWith('http') ? value : configuredPathWithBase(value)
}

function configuredCanonical(value: string): string {
  const origin = (process.env.SITE_DOMAIN ?? 'https://strandsagents.com').replace(/\/$/, '')
  return `${origin}${configuredPathWithBase(value)}`
}

function configuredSiteLink(value: string): string {
  if (value.startsWith('http')) return value
  const origin = (process.env.SITE_DOMAIN ?? '').replace(/\/$/, '')
  return `${origin}${configuredPathWithBase(value)}`
}

describe('Box landing page', () => {
  const html = readFileSync(new URL('../dist/box/index.html', import.meta.url), 'utf8')
  const page = parse(html)

  it('renders one focused product story outside the docs layout', () => {
    const main = page.querySelector('main')
    const headings = main?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? []

    expect(main?.getAttribute('data-pagefind-body')).not.toBeNull()
    expect(headings[0]?.tagName).toBe('H1')
    expect(main?.querySelectorAll('h1')).toHaveLength(1)
    expect(main?.querySelector('h1')?.text.replace(/\s+/g, ' ').trim()).toBe('Put your agent in a box.')
    expect(main?.querySelector('.box-hero__product')?.text.trim()).toBe('/box')
    expect(main?.querySelector('.box-hero__description')).toBeNull()
    expect(page.querySelector('.box-hero__status')).toBeNull()
    expect(page.text).not.toContain('Developer preview')
    expect(page.text).toContain('brew install strands-agents/tap/box')
    expect(page.querySelector('.sidebar')).toBeNull()
    expect(page.querySelector('starlight-menu-button')).toBeNull()
  })

  it('presents the agent selector and expandable boundary examples in one section', () => {
    const agentTabs = page.querySelectorAll('[data-box-agent-tab]')
    const agentPanels = page.querySelectorAll('[data-box-agent-panel]')
    const capabilityCards = page.querySelectorAll('[data-box-capability]')
    const exampleDecisions = page.querySelectorAll('[data-box-boundary-decision]')

    const agentSectionIndex = html.indexOf('<section class="box-start')
    const nextStepsIndex = html.indexOf('<section class="next-steps')

    expect(agentSectionIndex).toBeLessThan(nextStepsIndex)
    expect(html).not.toContain('<section class="box-capabilities')
    expect(page.querySelector('.box-boundary')).toBeNull()
    expect(page.querySelector('[data-boundary-trust]')).toBeNull()
    expect(page.querySelector('.box-start__header h2')?.text.trim()).toBe('Run the coding agent you already use')
    expect(page.querySelector('.box-start__header > span')).toBeNull()
    expect(page.text).not.toContain('Box creates a reusable profile on the first run.')
    expect(page.querySelector('.box-controls')).toBeNull()
    expect(page.querySelector('[data-box-agent-selector]')).not.toBeNull()
    expect(page.querySelector('[data-box-agent-selector]')?.getAttribute('data-enhanced')).toBeUndefined()
    expect(page.querySelector('[data-box-agent-selector]')?.getAttribute('data-capabilities-enhanced')).toBeUndefined()
    expect(page.querySelector('[data-box-agent-tablist]')?.getAttribute('aria-label')).toBe('Choose a coding agent')
    expect(page.querySelector('[data-box-agent-tablist]')?.getAttribute('role')).toBeUndefined()
    expect(page.querySelector('.box-start__launcher')?.querySelector('[data-box-agent-tablist]')).not.toBeNull()
    expect(page.querySelector('.box-start__launcher')?.querySelectorAll('[data-box-overview-command]')).toHaveLength(
      BOX_FEATURED_AGENT_EXAMPLES.length
    )
    expect(page.querySelector('.box-start__demo')?.querySelector('[data-box-agent-tablist]')).toBeNull()
    expect(agentTabs).toHaveLength(BOX_FEATURED_AGENT_EXAMPLES.length)
    expect(agentPanels).toHaveLength(BOX_FEATURED_AGENT_EXAMPLES.length)
    expect(page.querySelectorAll('[data-box-agent-tab][data-default-active]')).toHaveLength(1)
    expect(page.querySelectorAll('.box-start__terminal-dots')).toHaveLength(BOX_FEATURED_AGENT_EXAMPLES.length)
    expect(page.querySelector('[data-box-agent-selector] .box-start__capabilities')).not.toBeNull()
    expect(page.querySelectorAll('.box-start__connectors > span')).toHaveLength(BOX_CAPABILITIES.length)
    expect(page.querySelector('.box-start__experience [data-box-capability]')).toBeNull()
    expect(page.querySelector('[data-box-agent-card]')).toBeNull()
    expect(page.querySelector('[data-box-agent-button]')).toBeNull()
    expect(page.querySelector('.box-start__steps')).toBeNull()
    expect(page.querySelector('.box-start__step-heading')).toBeNull()
    expect(page.querySelector('.box-examples')).toBeNull()
    expect(page.querySelector('.box-examples__terminal')).toBeNull()

    expect(page.querySelector('.box-start__eyebrow')).toBeNull()
    expect(page.querySelector('.box-start__product')?.text.trim()).toBe('/box')
    expect(page.querySelector('.box-start__summary')?.text.trim()).toBe(BOX_OVERVIEW_DESCRIPTION)
    expect(page.querySelector('[data-box-overview-install]')).toBeNull()
    expect(page.querySelectorAll('[data-box-overview-command]')).toHaveLength(BOX_FEATURED_AGENT_EXAMPLES.length)
    expect(capabilityCards).toHaveLength(BOX_CAPABILITIES.length)
    expect(page.querySelectorAll('[data-box-capability-toggle]')).toHaveLength(BOX_CAPABILITIES.length)
    expect(page.querySelectorAll('[data-box-capability-code]')).toHaveLength(BOX_CAPABILITIES.length)
    expect(page.querySelectorAll('[data-box-capability-action]')).toHaveLength(BOX_CAPABILITIES.length)
    expect(exampleDecisions).toHaveLength(BOX_EXAMPLE_BOUNDARY.length * BOX_FEATURED_AGENT_EXAMPLES.length)

    for (const [index, capability] of BOX_CAPABILITIES.entries()) {
      const panel = BOX_BOUNDARY_PANELS[index]
      if (!panel) throw new Error(`Missing boundary panel for ${capability.id}`)

      const card = page.querySelector(`[data-box-capability="${capability.id}"]`)
      const title = page.querySelector(`[data-box-capability-title="${capability.id}"]`)
      const category = page.querySelector(`[data-box-capability-category="${capability.id}"]`)
      const toggle = card?.querySelector(`[data-box-capability-toggle="${capability.id}"]`)
      const details = card?.querySelector(`[data-box-capability-code="${capability.id}"]`)
      const action = card?.querySelector(`[data-box-capability-action="${capability.id}"]`)
      const terminalMarkup = parse(details?.querySelector('pre[data-lang-code]')?.innerHTML ?? '')
      const renderedCode = terminalMarkup
        .querySelectorAll('.toolkit__card-terminal-line')
        .map((line) => line.textContent)
        .join('\n')

      expect(card?.querySelector('.box-start__slug')).toBeNull()
      expect(title?.text.trim()).toBe(capability.title)
      expect(category?.text.trim()).toBe(capability.label)
      expect(card?.querySelector('.box-start__capability-label')).toBeNull()
      expect(card?.querySelector('.box-start__capability-description')?.text.trim()).toBe(capability.description)
      expect(card?.getAttribute('data-box-capability-label')).toBe(capability.title)
      expect(card?.getAttribute('data-box-capability-card')).not.toBeNull()
      expect(details?.getAttribute('id')).toBe(`box-capability-${capability.id}-details`)
      expect(details?.hasAttribute('hidden')).toBe(false)
      expect(details?.querySelector('.box-start__capability-file')?.text.trim()).toBe(`/${panel.filename}`)
      expect(renderedCode).toBe(panel.code)
      expect(card?.querySelector('.toolkit__card-terminal-language')?.text.trim()).toBe(
        panel.id === 'policy' ? 'Policy' : 'TOML'
      )
      expect(card?.querySelector('.toolkit__card-terminal-copy')?.getAttribute('aria-label')).toBe(
        `Copy the ${panel.filename} example`
      )
      expect(toggle?.tagName).toBe('BUTTON')
      expect(toggle?.getAttribute('type')).toBe('button')
      expect(toggle?.getAttribute('aria-expanded')).toBe('false')
      expect(toggle?.getAttribute('aria-controls')).toBe(`box-capability-${capability.id}-details`)
      expect(toggle?.getAttribute('aria-label')).toBe(`Show ${capability.title} example`)
      expect(toggle?.querySelector('[aria-hidden="true"] svg')).not.toBeNull()
      expect(action?.text.replace(/\s+/g, ' ').trim()).toContain(panel.linkLabel)
      expect(action?.getAttribute('href')).toBe(configuredHref(panel.href))
    }

    expect(page.querySelector('[data-box-review-link]')).toBeNull()

    for (const example of BOX_FEATURED_AGENT_EXAMPLES) {
      const tab = page.querySelector(`[data-box-agent-tab="${example.id}"]`)
      const panel = page.querySelector(`[data-box-agent-panel="${example.id}"]`)
      const overviewCommand = page.querySelector(`[data-box-overview-command="${example.id}"]`)
      const command = panel?.querySelector('[data-command-pill]')
      const decisionRows = panel?.querySelectorAll('[data-box-boundary-decision]') ?? []

      expect(tab?.text.trim()).toBe(example.title)
      expect(tab?.getAttribute('id')).toBe(`box-agent-tab-${example.id}`)
      expect(tab?.getAttribute('href')).toBe(`#box-agent-panel-${example.id}`)
      expect(tab?.getAttribute('role')).toBeUndefined()
      expect(panel?.getAttribute('id')).toBe(`box-agent-panel-${example.id}`)
      expect(panel?.getAttribute('aria-labelledby')).toBe(`box-agent-tab-${example.id}`)
      expect(panel?.getAttribute('role')).toBeUndefined()
      expect(panel?.hasAttribute('hidden')).toBe(false)
      expect(overviewCommand?.hasAttribute('hidden')).toBe(example !== BOX_FEATURED_AGENT_EXAMPLES[0])
      expect(overviewCommand?.querySelector('[data-command-pill]')?.getAttribute('data-command')).toBe(example.command)
      expect(overviewCommand?.querySelector('[data-command-copy]')?.getAttribute('aria-label')).toBe(
        `Copy the ${example.title} Box run command`
      )
      expect(command?.getAttribute('data-command')).toBe(example.command)
      expect(command?.text).toContain(example.command)
      expect(panel?.querySelector('.box-start__run-command [data-command-pill]')?.getAttribute('data-command')).toBe(
        example.command
      )
      expect(panel?.querySelector('[data-box-example-boundary] [data-command-pill]')).toBeNull()
      expect(command?.querySelector('[data-command-copy]')?.getAttribute('aria-label')).toBe(
        `Copy the ${example.title} Box run command`
      )
      expect(panel?.querySelector(`[data-example-guide="${example.id}"]`)?.getAttribute('href')).toBe(
        configuredHref(example.href)
      )
      expect(panel?.querySelector('[data-box-example-boundary]')?.getAttribute('aria-label')).toBe(
        `${example.title} example Box controls`
      )
      expect(panel?.querySelector('.box-start__session-header')?.text).toContain('What Box allows')
      expect(decisionRows).toHaveLength(BOX_EXAMPLE_BOUNDARY.length)

      for (const decision of BOX_EXAMPLE_BOUNDARY) {
        const row = panel?.querySelector(`[data-box-boundary-decision="${decision.id}"]`)

        expect(row?.querySelector('code')?.text.trim()).toBe(decision.action)
        expect(row?.querySelector('.box-start__decision-state')?.text).toContain(decision.result)
      }
    }
  })

  it('matches the Box product hero', () => {
    const heroCommand = page.querySelector('.box-hero [data-command-pill]')
    const heroLinks = page.querySelectorAll('.box-hero__link')
    const githubLink = page.querySelector('.box-hero__link--github')
    const githubStars = githubLink?.querySelector('.box-hero__github-stars')?.text.trim()
    const nextLinks = page.querySelectorAll('.next-steps__cta')

    expect(heroCommand?.getAttribute('data-command')).toBe('brew install strands-agents/tap/box')
    expect(heroCommand?.text).toContain('brew install strands-agents/tap/box')
    expect(BOX_LINKS.install).toContain(BOX_CLI_REPOSITORY_URL)
    expect(BOX_LINKS.quickstart).toContain(BOX_CLI_REPOSITORY_URL)
    expect(BOX_LINKS.install).not.toContain(BOX_CORE_REPOSITORY_URL)
    expect(page.querySelectorAll('.box-hero__meta span').map((platform) => platform.text.trim())).toEqual([
      'macOS 15+ (Apple silicon)',
      '·',
      'Linux ARM64',
    ])

    expect(heroLinks.map((link) => link.getAttribute('href'))).toEqual([
      configuredHref(BOX_LINKS.quickstart),
      BOX_CORE_REPOSITORY_URL,
    ])
    expect(page.querySelector('.box-hero__link--primary')?.text.replace(/\s+/g, ' ').trim()).toBe('Run Box')
    expect(githubStars).toMatch(/^\d{1,3}(,\d{3})*\+?$/)
    expect(githubLink?.getAttribute('aria-label')).toBe(`View Strands Box on GitHub, ${githubStars} stars`)
    expect(githubLink?.querySelector('.box-hero__github-icon svg')).not.toBeNull()
    expect(nextLinks.map((link) => link.getAttribute('href'))).toEqual([
      configuredHref(BOX_LINKS.install),
      configuredPathWithBase(BOX_LINKS.deployment),
      configuredPathWithBase(BOX_LINKS.security),
    ])

    for (const example of BOX_FEATURED_AGENT_EXAMPLES) {
      expect(example.href).toContain(`${BOX_CLI_REPOSITORY_URL}/blob/main/resources/packs/`)
    }
  })

  it('uses base-aware metadata and internal links', () => {
    const canonical = configuredCanonical('/box/')

    expect(page.querySelector('title')?.text).toBe(BOX_LANDING_TITLE)
    expect(page.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(BOX_LANDING_DESCRIPTION)
    expect(page.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(canonical)
    expect(page.querySelector('link[rel="alternate"][type="text/markdown"]')?.getAttribute('href')).toBe(
      configuredPathWithBase('/box/index.md')
    )
    expect(page.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(canonical)
    expect(page.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(BOX_LANDING_TITLE)
    expect(page.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(BOX_LANDING_DESCRIPTION)
    expect(page.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary_large_image')
    expect(page.querySelector('meta[name="twitter:title"]')?.getAttribute('content')).toBe(BOX_LANDING_TITLE)
    expect(page.querySelector('meta[name="twitter:description"]')?.getAttribute('content')).toBe(
      BOX_LANDING_DESCRIPTION
    )

    for (const link of page.querySelectorAll<HTMLAnchorElement>('main a')) {
      const href = link.getAttribute('href')
      if (!href || href.startsWith('http') || href.startsWith('#')) continue
      expect(href.startsWith(configuredPathWithBase('/'))).toBe(true)
    }
  })

  it('describes Box as the page software product in JSON-LD', () => {
    const structuredData = JSON.parse(page.querySelector('script[type="application/ld+json"]')?.textContent ?? '{}')
    const nodes = structuredData['@graph'] as Array<Record<string, unknown>>
    const product = nodes.find((node) => node['@type'] === 'SoftwareApplication')

    expect(nodes.map((node) => node['@type'])).toEqual(['Organization', 'WebSite', 'SoftwareApplication'])
    expect(product).toMatchObject({
      name: 'Strands Box',
      description:
        'Run AI agents in a sandbox that limits the files, programs, websites, and credentials they can access locally or in supported cloud deployments.',
      url: configuredCanonical('/box/'),
      applicationCategory: 'DeveloperApplication',
      license: 'https://www.apache.org/licenses/LICENSE-2.0',
      isBasedOn: {
        codeRepository: BOX_CORE_REPOSITORY_URL,
        programmingLanguage: ['Rust'],
      },
    })
  })

  it('publishes the same core content as Markdown', () => {
    const markdown = readFileSync(new URL('../dist/box/index.md', import.meta.url), 'utf8')

    expect(markdown.startsWith('# /box\n')).toBe(true)
    expect(markdown.match(/^# /gm)).toHaveLength(1)
    expect(markdown).not.toContain('Developer preview')
    expect(markdown).not.toContain('brew install strands-agents/tap/box')
    expect(markdown).toContain(`## Install Box CLI`)
    expect(markdown).toContain(BOX_INSTALL_COMMAND)
    expect(markdown).toContain(BOX_VERIFY_COMMAND)
    expect(markdown).toContain('## Run the coding agent you already use')
    expect(markdown).toContain('Open a terminal in the project where you want to run the agent.')
    expect(markdown).not.toContain('## Get running')
    expect(markdown).toContain('The first `box run` creates a reusable profile')
    expect(markdown.indexOf('## Run the coding agent you already use')).toBeLessThan(
      markdown.indexOf('## What Box does')
    )
    expect(markdown.indexOf('## What Box does')).toBeLessThan(markdown.indexOf('## How it works'))
    expect(markdown).toContain('## What Box does')
    expect(markdown).toContain(BOX_CAPABILITIES_HEADLINE)
    expect(markdown).toContain(BOX_CAPABILITIES_SUMMARY)
    expect(markdown).toContain('### What Box allows')

    for (const capability of BOX_CAPABILITIES) {
      expect(markdown).toContain(`### ${capability.title}`)
      expect(markdown).toContain(capability.description)
    }

    for (const decision of BOX_EXAMPLE_BOUNDARY) {
      expect(markdown).toContain(`- \`${decision.action}\`: ${decision.result.toLowerCase()}`)
    }

    expect(markdown).toContain('## How it works')
    expect(markdown).toContain('Two files define the boundary.')
    expect(markdown).toContain('Packs describe the agent, model provider, and tools.')
    expect(markdown).toContain('### Enforced outside the agent')
    expect(markdown).toContain('applies to the code it launches')
    expect(markdown).toContain('approval mode does not change these controls')
    expect(markdown).toContain('For routed credentials, the agent receives a stand-in.')
    expect(markdown).toContain('does not hide credentials stored in files the agent can read')
    expect(markdown).toContain('Box records mediated policy decisions')
    expect(markdown).toContain('Direct operating-system grants remain separate')
    expect(markdown).toContain('## Deploy with Box Core')
    expect(markdown).toContain(configuredSiteLink(BOX_LINKS.deployment))
    expect(markdown).toContain(configuredSiteLink(BOX_LINKS.dogwood))
    expect(markdown).toContain(configuredSiteLink(BOX_LINKS.credentialGuide))
    expect(markdown).toContain(configuredSiteLink(BOX_LINKS.designStory))
    expect(markdown).not.toContain('## See Box around a real agent')
    expect(markdown).toContain('@id("no_env")')
    expect(markdown).toContain('Box::Action::"net:connect"')
    expect(markdown).toContain('[egress.github]')
    expect(markdown).toContain('box run codex')
    expect(markdown).toContain('box run pi')
    expect(markdown).toContain(configuredSiteLink(BOX_LINKS.quickstart))
    expect(markdown).toContain(configuredSiteLink(BOX_LINKS.security))
    expect(markdown).toContain(BOX_REPOSITORY_URL)
  })
})
