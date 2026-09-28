import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  loadSidebarFromConfig,
  loadNavigationConfig,
  loadNavbarFromConfig,
  loadGitHubSectionsFromConfig,
  type StarlightSidebarItem,
} from '../src/sidebar'

const pathToNavigationYml = path.resolve('./src/config/navigation.yml')

describe('Sidebar Generation from navigation.yml', () => {
  it('should generate sidebar structure from navigation.yml', () => {
    const sidebar = loadSidebarFromConfig(pathToNavigationYml)

    console.log('\n=== Generated Sidebar Structure ===\n')
    console.log(JSON.stringify(sidebar, null, 2))

    expect(sidebar).toBeDefined()
    expect(Array.isArray(sidebar)).toBe(true)
    expect(sidebar.length).toBeGreaterThan(0)
  })

  it('should load navigation config with all sections', () => {
    const config = loadNavigationConfig(pathToNavigationYml)

    expect(config).toBeDefined()
    expect(config.navbar).toBeDefined()
    expect(Array.isArray(config.navbar)).toBe(true)
    expect(config.sidebar).toBeDefined()
    expect(Array.isArray(config.sidebar)).toBe(true)
    expect(config.github).toBeDefined()
    expect(config.github.sections).toBeDefined()
  })

  it('should load navbar links', () => {
    const navbar = loadNavbarFromConfig(pathToNavigationYml)

    expect(navbar).toBeDefined()
    expect(Array.isArray(navbar)).toBe(true)
    expect(navbar.length).toBeGreaterThan(0)

    // Check that navbar links have required properties
    const firstLink = navbar[0]
    expect(firstLink).toHaveProperty('label')
    expect(firstLink).toHaveProperty('href')
  })

  it('should load GitHub sections', () => {
    const sections = loadGitHubSectionsFromConfig(pathToNavigationYml)

    expect(sections).toBeDefined()
    expect(Array.isArray(sections)).toBe(true)
    expect(sections.length).toBeGreaterThan(0)

    // Check that sections have required structure
    const firstSection = sections[0]
    expect(firstSection).toHaveProperty('title')
    expect(firstSection).toHaveProperty('links')
    expect(Array.isArray(firstSection.links)).toBe(true)
  })

  it('should have correct top-level sidebar sections', () => {
    const sidebar = loadSidebarFromConfig(pathToNavigationYml)

    // Check that we have the expected top-level sections
    const topLevelLabels = sidebar
      .filter((item): item is StarlightSidebarItem & { label: string } => 'label' in item)
      .map((item) => item.label)

    // Examples is a standalone navbar entry (/examples/), not a docs sidebar section.
    expect(topLevelLabels).toContain('Harness')
    expect(topLevelLabels).toContain('Harness SDK')
    expect(topLevelLabels).toContain('Shell')
    expect(topLevelLabels).toContain('Evals SDK')
    expect(topLevelLabels).toContain('Community')
  })

  it('should not set collapsed on groups unless explicitly specified in YAML', () => {
    const sidebar = loadSidebarFromConfig(pathToNavigationYml)

    // Find the SDK product section
    const harness = sidebar.find(
      (item): item is StarlightSidebarItem & { label: string; items: StarlightSidebarItem[] } =>
        'label' in item && item.label === 'Harness SDK'
    )

    expect(harness).toBeDefined()
    if (harness) {
      // Top level should not have collapsed set (middleware handles depth-based defaults)
      expect(harness).not.toHaveProperty('collapsed')

      // A nested group without an explicit collapsed flag in YAML — "Get started"
      const getStarted = harness.items.find(
        (item): item is StarlightSidebarItem & { label: string } => 'label' in item && item.label === 'Get started'
      )

      // Nested groups without explicit YAML collapsed flag should also lack the property
      expect(getStarted).not.toHaveProperty('collapsed')
    }
  })

  it('should support both labeled and unlabeled leaf items', () => {
    const sidebar = loadSidebarFromConfig(pathToNavigationYml)

    // Collect all leaf items
    function findLeafItems(items: StarlightSidebarItem[]): StarlightSidebarItem[] {
      const leaves: StarlightSidebarItem[] = []
      for (const item of items) {
        if ('slug' in item && !('items' in item)) {
          leaves.push(item)
        }
        if ('items' in item) {
          leaves.push(...findLeafItems(item.items as StarlightSidebarItem[]))
        }
      }
      return leaves
    }

    const leaves = findLeafItems(sidebar)
    expect(leaves.length).toBeGreaterThan(0)

    // Some leaves should have labels (Build section items)
    const labeled = leaves.filter((item) => 'label' in item)
    expect(labeled.length).toBeGreaterThan(0)

    // Some leaves should not have labels (plain slug items)
    const unlabeled = leaves.filter((item) => !('label' in item))
    expect(unlabeled.length).toBeGreaterThan(0)
  })

  it('should include Labs and Learning under Community', () => {
    const sidebar = loadSidebarFromConfig(pathToNavigationYml)

    // Find the Community section
    const community = sidebar.find(
      (item): item is StarlightSidebarItem & { label: string; items: StarlightSidebarItem[] } =>
        'label' in item && item.label === 'Community'
    )

    expect(community).toBeDefined()
    if (community) {
      const subLabels = community.items
        .filter((item): item is StarlightSidebarItem & { label: string } => 'label' in item)
        .map((item) => item.label)

      expect(subLabels).toContain('Labs')
      expect(subLabels).toContain('Learning')
    }
  })

  it('should have Contribute as its own top-level section', () => {
    const sidebar = loadSidebarFromConfig(pathToNavigationYml)
    const labels = sidebar
      .filter((item): item is StarlightSidebarItem & { label: string } => 'label' in item)
      .map((item) => item.label)
    expect(labels).toContain('Contribute')
  })

  it('should group SDK build guides by task', () => {
    const sidebar = loadSidebarFromConfig(pathToNavigationYml)
    const harness = sidebar.find(
      (item): item is StarlightSidebarItem & { label: string; items: StarlightSidebarItem[] } =>
        'label' in item && item.label === 'Harness SDK'
    )

    expect(harness).toBeDefined()
    if (!harness) return

    const buildGuides = harness.items.find(
      (item): item is StarlightSidebarItem & { label: string; items: StarlightSidebarItem[] } =>
        'label' in item && item.label === 'Build guides' && 'items' in item
    )

    expect(buildGuides).toBeDefined()
    if (!buildGuides) return

    const groups = buildGuides.items.filter(
      (item): item is StarlightSidebarItem & { label: string; items: StarlightSidebarItem[] } =>
        'label' in item && 'items' in item
    )
    const labels = groups.map((group) => group.label)

    expect(labels).toEqual(['Tools', 'Sessions', 'Memory', 'Responses'])
    expect(groups[0]?.items).toEqual([
      { label: 'Overview', slug: 'docs/user-guide/sdk/tools' },
      { label: 'Attach and invoke tools', slug: 'docs/user-guide/sdk/tools/using-tools' },
      { label: 'Use MCP tools', slug: 'docs/user-guide/sdk/tools/mcp-tools' },
      { label: 'Create custom tools', slug: 'docs/user-guide/sdk/tools/custom-tools' },
    ])
    expect(groups[1]?.items).toEqual([
      { label: 'Persist state across sessions', slug: 'docs/user-guide/sdk/agents/session-management' },
    ])
    expect(groups[2]?.items).toEqual([
      { label: 'Overview', slug: 'docs/user-guide/sdk/memory/overview' },
      { label: 'Control what the agent remembers', slug: 'docs/user-guide/sdk/memory/managing-memory' },
    ])
    expect(groups[3]?.items).toEqual([
      { label: 'Return structured output', slug: 'docs/user-guide/sdk/agents/structured-output' },
      { label: 'Stream responses', slug: 'docs/user-guide/sdk/streaming' },
    ])

    // Single-page guides sit alongside the groups as flat links.
    const flat = buildGuides.items
      .filter((item): item is StarlightSidebarItem & { label: string; slug: string } => 'slug' in item)
      .map((item) => ({ label: item.label, slug: item.slug }))
    expect(flat).toEqual([
      { label: 'Manage the context window', slug: 'docs/user-guide/sdk/context-management' },
      { label: 'Pause for input and control', slug: 'docs/user-guide/sdk/agents/interventions/human-in-the-loop' },
      { label: 'Coordinate multiple agents', slug: 'docs/user-guide/sdk/multi-agent/multi-agent-patterns' },
      { label: 'Build a voice agent', slug: 'docs/user-guide/sdk/bidirectional-streaming/quickstart' },
    ])
  })
})
