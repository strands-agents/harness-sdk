import { describe, expect, it } from 'vitest'
import { catalogUrlFor, isModalPath, titleWithHeading } from '../src/util/integration-modal'

const typePaths = ['/docs/integrations/storage/', '/docs/integrations/tools/']

describe('isModalPath', () => {
  it('matches docs pages below a type page', () => {
    expect(isModalPath('/docs/integrations/storage/github/', typePaths)).toBe(true)
    expect(isModalPath('/docs/integrations/storage/overview/', typePaths)).toBe(true)
  })

  it('leaves the type pages and other pages alone', () => {
    expect(isModalPath('/docs/integrations/storage/', typePaths)).toBe(false)
    expect(isModalPath('/integrations/', typePaths)).toBe(false)
    expect(isModalPath('/docs/integrations/get-featured/', typePaths)).toBe(false)
    expect(isModalPath('/docs/user-guide/sdk/tools/', typePaths)).toBe(false)
  })
})

describe('catalogUrlFor', () => {
  it('keeps the filters and drops nothing else', () => {
    expect(catalogUrlFor('/docs/integrations/storage/', '?q=git&lang=python')).toBe(
      '/docs/integrations/storage/?q=git&lang=python'
    )
  })

  it('has no query when there are no filters', () => {
    expect(catalogUrlFor('/docs/integrations/storage/', '')).toBe('/docs/integrations/storage/')
  })
})

describe('titleWithHeading', () => {
  it('swaps the page name before the site name', () => {
    expect(titleWithHeading('GitHub Storage | Strands Agents', 'Storage')).toBe('Storage | Strands Agents')
  })

  it('uses the heading alone for a title without a site name', () => {
    expect(titleWithHeading('GitHub Storage', 'Storage')).toBe('Storage')
  })

  it('keeps the title when there is no heading', () => {
    expect(titleWithHeading('Integrations | Strands Agents', '')).toBe('Integrations | Strands Agents')
  })
})
