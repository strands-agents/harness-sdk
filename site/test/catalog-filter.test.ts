import { describe, it, expect } from 'vitest'
import {
  countIfSelected,
  matchesFilters,
  selectOnly,
  stateToQuery,
  queryToState,
  type CatalogFilterState,
  type CardFilterData,
} from '../src/util/catalog-filter'

function state(overrides: Partial<CatalogFilterState> = {}): CatalogFilterState {
  return {
    search: '',
    types: new Set(),
    languages: new Set(),
    badges: new Set(),
    maintainedBy: new Set(),
    sdk: 'agents',
    ...overrides,
  }
}

const card: CardFilterData = {
  search: 'strands-deepgram deepgram speech-to-text and audio intelligence',
  type: 'tool',
  languages: ['python'],
  badges: ['verified'],
  maintainedBy: 'community',
  sdk: 'agents',
}

describe('matchesFilters', () => {
  it('matches everything with the default state', () => {
    expect(matchesFilters(card, state())).toBe(true)
  })

  it('matches case-insensitive substrings against name+description', () => {
    expect(matchesFilters(card, state({ search: 'Speech-To-Text' }))).toBe(true)
    expect(matchesFilters(card, state({ search: 'telemetry' }))).toBe(false)
  })

  it('filters by integration type (OR within the facet)', () => {
    expect(matchesFilters(card, state({ types: new Set(['tool', 'plugin']) }))).toBe(true)
    expect(matchesFilters(card, state({ types: new Set(['plugin']) }))).toBe(false)
  })

  it('filters by language', () => {
    expect(matchesFilters(card, state({ languages: new Set(['python']) }))).toBe(true)
    expect(matchesFilters(card, state({ languages: new Set(['typescript']) }))).toBe(false)
  })

  it('filters by badge', () => {
    expect(matchesFilters(card, state({ badges: new Set(['verified']) }))).toBe(true)
    expect(matchesFilters({ ...card, badges: [] }, state({ badges: new Set(['verified']) }))).toBe(false)
  })

  it('always filters by sdk', () => {
    expect(matchesFilters(card, state({ sdk: 'evals' }))).toBe(false)
  })

  it('ANDs across facets', () => {
    expect(
      matchesFilters(card, state({ search: 'deepgram', types: new Set(['tool']), languages: new Set(['python']) }))
    ).toBe(true)
    expect(matchesFilters(card, state({ search: 'deepgram', types: new Set(['plugin']) }))).toBe(false)
  })
})

describe('URL state round-trip', () => {
  it('serializes only non-default state', () => {
    expect(stateToQuery(state())).toBe('')
    expect(stateToQuery(state({ search: 'sql', types: new Set(['tool']) }))).toBe('q=sql&type=tool')
    expect(stateToQuery(state({ sdk: 'evals' }))).toBe('sdk=evals')
  })

  it('round-trips through queryToState', () => {
    const s = state({
      search: 'sql',
      types: new Set(['tool', 'plugin']),
      languages: new Set(['python']),
      badges: new Set(['verified']),
      maintainedBy: new Set(['partner']),
      sdk: 'evals',
    })
    const back = queryToState(stateToQuery(s))
    expect(back.search).toBe('sql')
    expect(back.types).toEqual(new Set(['tool', 'plugin']))
    expect(back.languages).toEqual(new Set(['python']))
    expect(back.badges).toEqual(new Set(['verified']))
    expect(back.maintainedBy).toEqual(new Set(['partner']))
    expect(back.sdk).toBe('evals')
  })

  it('filters by maintainer tier', () => {
    expect(matchesFilters(card, state({ maintainedBy: new Set(['community', 'aws']) }))).toBe(true)
    expect(matchesFilters(card, state({ maintainedBy: new Set(['strands']) }))).toBe(false)
  })

  it('parses maintainer tiers from a deep link', () => {
    expect(queryToState('by=strands,aws').maintainedBy).toEqual(new Set(['strands', 'aws']))
    expect(queryToState('by=official').maintainedBy).toEqual(new Set())
  })

  it('countIfSelected holds other facets and swaps in the probed value', () => {
    const cards = [
      card,
      { ...card, type: 'plugin', maintainedBy: 'aws' },
      { ...card, type: 'tool', maintainedBy: 'aws' },
    ]
    const s = state({ maintainedBy: new Set(['aws']) })
    expect(countIfSelected(cards, s, 'types', 'tool')).toBe(1)
    expect(countIfSelected(cards, s, 'types', 'session-manager')).toBe(0)
    // probing within the same facet replaces the current selection
    expect(countIfSelected(cards, s, 'maintainedBy', 'community')).toBe(1)
  })

  it('selectOnly replaces the selection and re-picking clears it', () => {
    const set = new Set(['model-provider'])
    selectOnly(set, 'tool')
    expect(set).toEqual(new Set(['tool']))
    selectOnly(set, 'tool')
    expect(set).toEqual(new Set())
  })

  it('drops unknown values when parsing', () => {
    const back = queryToState('type=widget&lang=rust&sdk=nope')
    expect(back.types.size).toBe(0)
    expect(back.languages.size).toBe(0)
    expect(back.sdk).toBe('agents')
  })

  it('accepts every registered catalog type in type filters', () => {
    // KNOWN_TYPES derives from CATALOG_TYPES; this guards a newly registered
    // type (e.g. storage) being filterable without a second manual list.
    const back = queryToState('type=storage,memory-store')
    expect(back.types).toEqual(new Set(['storage', 'memory-store']))
  })
})
