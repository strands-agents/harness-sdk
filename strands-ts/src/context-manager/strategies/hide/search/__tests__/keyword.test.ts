import { describe, it, expect } from 'vitest'
import { KeywordToolSearchStrategy } from '../keyword.js'
import type { ToolSpec } from '../../../../../tools/types.js'

function spec(name: string, description = '', properties?: Record<string, { description?: string }>): ToolSpec {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: properties ?? {} },
  }
}

describe('KeywordToolSearchStrategy', () => {
  const weather = [
    spec('get_weather', 'Current conditions for a city', { city: { description: 'City name' } }),
    spec('city_guide', 'Weather-independent sightseeing tips'),
    spec('bookFlight', 'Book a flight to a destination'),
  ]
  const rank = async (query: string, limit = 10): Promise<string[]> =>
    (await KeywordToolSearchStrategy.search(query, weather, { limit: limit })).map((match) => match.name)

  it('splits snake_case names and weights name hits over description hits', async () => {
    expect(await rank('weather Paris')).toEqual(['get_weather', 'city_guide'])
  })

  it('splits camelCase names', async () => {
    expect(await rank('book a flight')).toEqual(['bookFlight'])
  })

  it('ranks a tool named verbatim in the query first', async () => {
    expect(await rank('run get_weather for Seattle', 1)).toEqual(['get_weather'])
    expect(await rank('call bookFlight now', 1)).toEqual(['bookFlight'])
  })

  it('matches CamelCase words in the query against whole descriptions', async () => {
    const specs = [
      spec('order_status', 'Look up the status of an order'),
      spec('dynamodb_query', 'Run a query against a DynamoDB table'),
      spec('github_search', 'Search GitHub repositories'),
      spec('youtube_search', 'Search YouTube videos'),
    ]
    const first = async (query: string): Promise<string[]> =>
      (await KeywordToolSearchStrategy.search(query, specs, { limit: 1 })).map((match) => match.name)
    expect(await first('look up the order in DynamoDB')).toEqual(['order_status'])
    expect(await first('query the DynamoDB table')).toEqual(['dynamodb_query'])
    expect(await first('search GitHub')).toEqual(['github_search'])
  })

  it('splits acronym boundaries', async () => {
    const specs = [spec('parseHTTPBody', 'Parse a request body'), spec('other', 'Unrelated')]
    const results = await KeywordToolSearchStrategy.search('http body', specs, { limit: 10 })
    expect(results.map((match) => match.name)).toEqual(['parseHTTPBody'])
  })

  it('matches input-property names and descriptions', async () => {
    expect(await rank('name')).toEqual(['get_weather'])
  })

  it('ignores stop words and single characters', async () => {
    expect(await rank('the a to')).toEqual([])
    expect(await rank('is it in the city')).toEqual(['city_guide', 'get_weather'])
  })

  it('breaks ties by candidate order', async () => {
    expect(await rank('tips conditions')).toEqual(['get_weather', 'city_guide'])
  })

  it('respects the limit', async () => {
    expect(await rank('city', 1)).toEqual(['city_guide'])
  })

  it('returns every ranked match when no limit is given', async () => {
    const results = await KeywordToolSearchStrategy.search('city', weather)
    expect(results.map((match) => match.name)).toEqual(['city_guide', 'get_weather'])
  })

  it('ranks any name hit above any number of description hits', async () => {
    const specs = [
      spec('crm_note', 'Send a weather note by email about the email weather'),
      spec('send_email', 'Deliver a message'),
    ]
    const results = await KeywordToolSearchStrategy.search('send weather email', specs, { limit: 10 })
    expect(results.map((match) => match.name)).toEqual(['send_email', 'crm_note'])
  })

  it('normalizes plurals on both sides', async () => {
    const specs = [
      spec('refund_invoice', 'Refund an invoice'),
      spec('create_booking', 'Create a booking'),
      spec('search_flights', 'Search flights by route'),
      spec('run_query', 'Run a query'),
    ]
    const first = async (query: string): Promise<string | undefined> =>
      (await KeywordToolSearchStrategy.search(query, specs, { limit: 1 }))[0]?.name
    expect(await first('refunds for customer 42')).toBe('refund_invoice')
    expect(await first('show my bookings')).toBe('create_booking')
    expect(await first('book a flight')).toBe('search_flights')
    expect(await first('my saved queries')).toBe('run_query')
  })

  it('normalizes plurals of sibilant stems in both directions', async () => {
    const specs = [
      spec('list_processes', 'Lists running processes on the host'),
      spec('validate_address', 'Validate a postal address'),
      spec('list_classes', 'List the classes in a module'),
    ]
    const first = async (query: string): Promise<string | undefined> =>
      (await KeywordToolSearchStrategy.search(query, specs, { limit: 1 }))[0]?.name
    expect(await first('kill a process')).toBe('list_processes')
    expect(await first('check the addresses')).toBe('validate_address')
    expect(await first('show the class')).toBe('list_classes')
  })

  it('returns scores with higher meaning more relevant', async () => {
    const results = await KeywordToolSearchStrategy.search('weather', weather, { limit: 10 })
    expect(results).toEqual([
      { name: 'get_weather', score: 1 },
      { name: 'city_guide', score: 0.5 },
    ])
  })
})
