import { describe, expect, it } from 'vitest'
import { CitationsBlock, type CitationsBlockData } from '../citations.js'

describe('CitationsBlock', () => {
  const singleCitationData: CitationsBlockData = {
    citations: [
      {
        location: { type: 'documentChar', documentIndex: 0, start: 10, end: 50 },
        source: 'doc-0',
        sourceContent: [{ text: 'source text from document' }],
        title: 'Test Document',
      },
    ],
    content: [{ text: 'generated text with citation' }],
  }

  const allVariantsData: CitationsBlockData = {
    citations: [
      {
        location: { type: 'documentChar', documentIndex: 0, start: 150, end: 300 },
        source: 'doc-0',
        sourceContent: [{ text: 'char source' }],
        title: 'Text Document',
      },
      {
        location: { type: 'documentPage', documentIndex: 0, start: 2, end: 3 },
        source: 'doc-0',
        sourceContent: [{ text: 'page source' }],
        title: 'PDF Document',
      },
      {
        location: { type: 'documentChunk', documentIndex: 1, start: 5, end: 8 },
        source: 'doc-1',
        sourceContent: [{ text: 'chunk source' }],
        title: 'Chunked Document',
      },
      {
        location: { type: 'searchResult', searchResultIndex: 0, start: 25, end: 150 },
        source: 'search-0',
        sourceContent: [{ text: 'search source' }],
        title: 'Search Result',
      },
      {
        location: { type: 'web', url: 'https://example.com/doc', domain: 'example.com' },
        source: 'web-0',
        sourceContent: [{ text: 'web source' }, { text: 'additional source' }],
        title: 'Web Page',
      },
    ],
    content: [{ text: 'first generated' }, { text: 'second generated' }],
  }

  it('creates block with correct type discriminator', () => {
    const block = new CitationsBlock(singleCitationData)
    expect(block.type).toBe('citationsBlock')
  })

  it('stores citations and content', () => {
    const block = new CitationsBlock(singleCitationData)
    expect(block.citations).toStrictEqual(singleCitationData.citations)
    expect(block.content).toStrictEqual(singleCitationData.content)
  })

  it('round-trips all CitationLocation variants, multiple citations, and multiple content blocks', () => {
    const original = new CitationsBlock(allVariantsData)
    const json = original.toJSON()
    const restored = CitationsBlock.fromJSON(json)

    expect(restored).toEqual(original)
    expect(restored.citations).toHaveLength(5)

    expect(restored.citations[0]!.location.type).toBe('documentChar')
    expect(restored.citations[1]!.location.type).toBe('documentPage')
    expect(restored.citations[2]!.location.type).toBe('documentChunk')
    expect(restored.citations[3]!.location.type).toBe('searchResult')
    expect(restored.citations[4]!.location.type).toBe('web')

    // Verify web-specific optional domain field survives round-trip
    const webLoc = restored.citations[4]!.location
    if (webLoc.type === 'web') {
      expect(webLoc.domain).toBe('example.com')
    }
  })

  it('handles empty arrays', () => {
    const data: CitationsBlockData = {
      citations: [],
      content: [],
    }
    const block = new CitationsBlock(data)
    expect(block.citations).toStrictEqual([])
    expect(block.content).toStrictEqual([])

    const restored = CitationsBlock.fromJSON(block.toJSON())
    expect(restored).toEqual(block)
  })

  it('toJSON returns wrapped format', () => {
    const block = new CitationsBlock(singleCitationData)
    const json = block.toJSON()
    expect(json).toStrictEqual({
      citations: {
        citations: singleCitationData.citations,
        content: singleCitationData.content,
      },
    })
  })

  it('works with JSON.stringify', () => {
    const original = new CitationsBlock(allVariantsData)
    const jsonString = JSON.stringify(original)
    const restored = CitationsBlock.fromJSON(JSON.parse(jsonString))
    expect(restored).toEqual(original)
  })
})
