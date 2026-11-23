import { describe, expect, it } from 'vitest'
import * as experimental from '../index.js'
import * as root from '../../index.js'
import * as contextManager from '../../context-manager/index.js'

describe('experimental barrel', () => {
  it('exports tool search and ServerToolBlock, which the stable barrels leave out', () => {
    expect(experimental).toMatchObject({
      KeywordToolSearcher: expect.any(Function),
      ServerToolBlock: expect.any(Function),
    })
    expect(root).not.toHaveProperty('ServerToolBlock')
    expect(contextManager).not.toHaveProperty('KeywordToolSearcher')
  })
})
