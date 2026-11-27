import { describe, expect, it } from 'vitest'
import type { StarlightSidebarItem } from '../src/sidebar'
import { findProductNavGroup } from '../src/util/product-nav'

type SidebarGroup = Extract<StarlightSidebarItem, { items: StarlightSidebarItem[] }>

describe('findProductNavGroup', () => {
  it('ignores a same-label group that does not contain the product hub', () => {
    const decoy: SidebarGroup = {
      label: 'Strands Decider',
      items: [{ label: 'Overview', slug: 'docs/unrelated/overview' }],
    }
    const decider: SidebarGroup = {
      label: 'Strands Decider',
      items: [
        { label: 'Quickstart', slug: 'docs/labs/strands-decider/quickstart' },
        { label: 'Inference', slug: 'docs/labs/strands-decider/inference' },
      ],
    }
    const sidebar: StarlightSidebarItem[] = [
      decoy,
      {
        label: 'Community',
        items: [
          {
            label: 'Labs',
            items: [{ label: 'Overview', slug: 'docs/labs' }, decider],
          },
        ],
      },
    ]

    expect(findProductNavGroup(sidebar, 'docs/labs/strands-decider/quickstart', ['Decider', 'Strands Decider'])).toBe(
      decider
    )
  })
})
